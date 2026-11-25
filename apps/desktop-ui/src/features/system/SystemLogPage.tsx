import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { dateLocaleTag } from "@linkshell/client-core";
import {
  DESKTOP_VISIBILITY_EVENT,
  getDesktopCapability,
  getShellVisible,
  isElectronDesktop,
  openDesktopEventStream,
  type DesktopEventStreamHandle,
} from "../../bridge";
import {
  appendHostLog,
  parseHostLog,
  readLog,
  revealLog,
  setHostLog,
  useManagement,
} from "../../core";
import { DesktopIcon } from "../../icons";
import { Button, CopyButton, IconButton, Input, Select } from "../../primitives";
import { useSystemI18n } from "./system-i18n";

const LOG_REFRESH_MS = 5_000;
const LOG_END_SLACK = 24;

function pad(val: number, len = 2): string {
  return String(val).padStart(len, "0");
}

function formatLogClock(date: Date): string {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(
    date.getMilliseconds(),
    3,
  )}`;
}

export function SystemLogPage() {
  const { locale, tCore, ts, revealInFiles } = useSystemI18n();
  const rawLog = useManagement((s) => s.log);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const followingRef = useRef(true);
  const [scrolledAway, setScrolledAway] = useState(false);
  const [tagFilter, setTagFilter] = useState("__all__");
  const [query, setQuery] = useState("");

  useEffect(() => {
    const isVisible = () =>
      (typeof document === "undefined" || document.visibilityState !== "hidden") &&
      getShellVisible();
    const canStream = isElectronDesktop && Boolean(getDesktopCapability());

    let disposed = false;
    let visible = isVisible();
    let stream: DesktopEventStreamHandle | undefined;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let pollTimer: ReturnType<typeof setInterval> | undefined;

    const closeStream = () => {
      clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
      const current = stream;
      stream = undefined;
      current?.close();
    };

    const stopFallbackPoll = () => {
      clearInterval(pollTimer);
      pollTimer = undefined;
    };

    const startFallbackPoll = () => {
      if (pollTimer) return;
      pollTimer = setInterval(() => {
        if (visible && !stream) void readLog();
      }, LOG_REFRESH_MS);
    };

    const openStream = () => {
      if (disposed || !visible || !canStream || stream) return;
      clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
      const next = openDesktopEventStream("/desktop/log/stream", {
        onOpen: () => {
          if (stream === next) stopFallbackPoll();
        },
        onEvent: (event, data) => {
          if (stream !== next || !data || typeof data !== "object") return;
          if (event === "init" || event === "reset") {
            const payload = data as { text?: unknown; path?: unknown };
            if (typeof payload.text === "string") {
              setHostLog(
                payload.text,
                typeof payload.path === "string" ? payload.path : undefined,
              );
            }
          } else if (event === "append") {
            const payload = data as { chunk?: unknown };
            if (typeof payload.chunk === "string") appendHostLog(payload.chunk);
          }
        },
        onClose: () => {
          if (stream !== next) return;
          stream = undefined;
          if (disposed || !visible) return;
          void readLog();
          startFallbackPoll();
          reconnectTimer = setTimeout(() => {
            reconnectTimer = undefined;
            openStream();
          }, 2_500);
        },
      });
      stream = next;
    };

    if (visible) {
      if (canStream) openStream();
      else {
        void readLog();
        startFallbackPoll();
      }
    }

    const onVisibility = (event?: Event) => {
      const detail = (event as CustomEvent<{ visible?: boolean }> | undefined)?.detail;
      const next = detail ? detail.visible !== false : isVisible();
      if (next === visible) return;
      visible = next;
      if (visible) {
        if (canStream) openStream();
        else {
          void readLog();
          startFallbackPoll();
        }
      } else {
        closeStream();
        stopFallbackPoll();
      }
    };
    const onDocVisibility = () => onVisibility();
    window.addEventListener(DESKTOP_VISIBILITY_EVENT, onVisibility);
    document.addEventListener("visibilitychange", onDocVisibility);
    return () => {
      disposed = true;
      closeStream();
      stopFallbackPoll();
      window.removeEventListener(DESKTOP_VISIBILITY_EVENT, onVisibility);
      document.removeEventListener("visibilitychange", onDocVisibility);
    };
  }, []);

  const entries = useMemo(() => (rawLog ? parseHostLog(rawLog) : []), [rawLog]);

  const tags = useMemo(() => {
    const seen = new Set<string>();
    for (const item of entries) {
      if (item.tag) seen.add(item.tag);
    }
    return [...seen].sort();
  }, [entries]);

  const filteredEntries = useMemo(() => {
    const q = query.trim().toLowerCase();
    return entries.filter((entry) => {
      if (tagFilter !== "__all__" && entry.tag !== tagFilter) return false;
      if (!q) return true;
      return (
        entry.text.toLowerCase().includes(q) ||
        (entry.tag?.toLowerCase().includes(q) ?? false)
      );
    });
  }, [entries, tagFilter, query]);

  const scrollToEnd = () => {
    const el = scrollerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  };

  useLayoutEffect(() => {
    if (followingRef.current) scrollToEnd();
  }, [filteredEntries]);

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el || typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(() => {
      if (followingRef.current) scrollToEnd();
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const handleScroll = () => {
    const el = scrollerRef.current;
    if (!el) return;
    const atEnd = el.scrollHeight - el.scrollTop - el.clientHeight <= LOG_END_SLACK;
    followingRef.current = atEnd;
    setScrolledAway(!atEnd);
  };

  const jumpToLatest = () => {
    followingRef.current = true;
    setScrolledAway(false);
    scrollToEnd();
  };

  const copyPayload = useMemo(() => {
    if (tagFilter === "__all__" && !query.trim()) return rawLog;
    return filteredEntries
      .map((entry) => {
        const tsPrefix = entry.at ? `${new Date(entry.at).toISOString()} ` : "";
        const tagPrefix = entry.tag ? `[${entry.tag}] ` : "";
        return `${tsPrefix}${tagPrefix}${entry.text}`;
      })
      .join("\n");
  }, [filteredEntries, query, rawLog, tagFilter]);

  let lastDay = "";

  return (
    <div className="ls-log-shell">
      <div className="ls-log-toolbar">
        <div className="ls-system-row__controls">
          <Select
            size="sm"
            ariaLabel={ts("log.allTags")}
            value={tagFilter}
            onValueChange={setTagFilter}
            options={[
              { value: "__all__", label: ts("log.allTags") },
              ...tags.map((tag) => ({ value: tag, label: `[${tag}]` })),
            ]}
          />
          <Input
            size="sm"
            leadingIcon="search"
            placeholder={ts("log.filterPlaceholder")}
            value={query}
            className="ls-log-filter-input"
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>

        <div className="ls-system-row__controls">
          <CopyButton
            value={copyPayload}
            label={ts("log.copyLog")}
            copiedLabel={ts("log.copiedLog")}
            disabled={!rawLog}
            showText
          />
          <IconButton
            icon="refresh"
            size="icon-sm"
            variant="ghost"
            label={tCore("common.refresh")}
            onClick={() => void readLog()}
          />
          <Button
            size="sm"
            variant="secondary"
            leadingIcon="folder-open"
            onClick={() => void revealLog()}
          >
            {revealInFiles}
          </Button>
        </div>
      </div>

      <div
        ref={scrollerRef}
        className="ls-log-well"
        tabIndex={0}
        role="log"
        aria-label={ts("nav.log")}
        onScroll={handleScroll}
      >
        {!rawLog ? (
          <p className="ls-system-note">{ts("log.emptyLoading")}</p>
        ) : filteredEntries.length === 0 ? (
          <p className="ls-system-note">{ts("log.emptyFiltered")}</p>
        ) : (
          filteredEntries.map((entry, idx) => {
            const date = entry.at !== undefined ? new Date(entry.at) : undefined;
            const dayText = date
              ? date.toDateString() === new Date().toDateString()
                ? ts("log.today")
                : date.toLocaleDateString(dateLocaleTag(locale), {
                    month: "short",
                    day: "numeric",
                  })
              : "";
            const showDayDivider = Boolean(dayText && dayText !== lastDay);
            if (dayText) lastDay = dayText;

            return (
              <div key={`${entry.at ?? ""}:${idx}`} className="ls-log-entry">
                {showDayDivider ? (
                  <div className="ls-log-day">{dayText}</div>
                ) : null}
                <div className="ls-log-line">
                  {date ? (
                    <time
                      className="ls-log-time"
                      dateTime={date.toISOString()}
                    >
                      {formatLogClock(date)}
                    </time>
                  ) : null}
                  {entry.tag ? (
                    <span className="ls-log-tag">[{entry.tag}]</span>
                  ) : null}
                  <span className="ls-log-text">{entry.text}</span>
                </div>
              </div>
            );
          })
        )}
      </div>

      {scrolledAway ? (
        <button
          type="button"
          className="ls-log-jump"
          onClick={jumpToLatest}
        >
          <DesktopIcon name="arrow-down" size="xs" />
          <span>{ts("log.jumpLatest")}</span>
        </button>
      ) : null}
    </div>
  );
}
