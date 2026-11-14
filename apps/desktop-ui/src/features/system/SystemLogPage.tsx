import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { dateLocaleTag } from "@linkshell/client-core";
import { parseHostLog, readLog, revealLog, useManagement } from "../../core";
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
    void readLog();
    const timer = setInterval(() => void readLog(), LOG_REFRESH_MS);
    return () => clearInterval(timer);
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
