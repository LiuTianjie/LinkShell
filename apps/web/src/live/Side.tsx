import { useEffect, useRef, useState } from "react";
import { LoaderCircle } from "lucide-react";
import type { SessionSummary, SideChat, SideMessage } from "@linkshell/wire";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ErrorNotice, useActions, useClient, useJob, useSessionOnline } from "./common";
import { RichText } from "./Timeline";

const NO_SIDES: SideChat[] = [];

/**
 * The session's side conversations (Codex's `/side`, Claude's and Grok's
 * `/btw`): questions about the session that don't interrupt it or enter it.
 */
export function Side({ session, label }: { session: SessionSummary; label: string }) {
  const actions = useActions();
  const online = useSessionOnline();
  const sides = useClient((state) => state.sides[session.id] ?? NO_SIDES);
  const job = useJob();
  const [sideId, setSideId] = useState<string>();
  const [draft, setDraft] = useState("");
  const end = useRef<HTMLDivElement>(null);
  const current = sides.find((entry) => entry.sideId === sideId) ?? (sideId ? undefined : sides[sides.length - 1]);
  const last = current?.messages[current.messages.length - 1];

  useEffect(() => {
    if (online) void actions.loadSides(session.id).catch(() => {});
  }, [online, actions, session.id]);
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [current?.messages.length, last?.text.length]);

  const ask = () =>
    void job.run(async () => {
      const text = draft.trim();
      if (!text) return;
      const asked = await actions.askSide(session.id, text, current?.sideId);
      setSideId(asked.sideId);
      setDraft("");
    });

  return (
    <section className="settings-panel side-chat">
      <p className="muted">
        问一个关于这个会话的问题，不打断正在进行的一轮。
        {session.agent === "codex"
          ? `${label} 在只读的临时分叉里回答，可以查看文件，不会改动任何东西；问答不进入会话。`
          : `${label} 依据会话到现在为止的内容回答，不使用工具；问答不进入会话。`}
      </p>
      {sides.length > 0 && (
        <div className="side-chat-tabs" role="tablist" aria-label="旁支对话">
          {sides.map((entry, index) => (
            <button
              type="button"
              role="tab"
              key={entry.sideId}
              aria-selected={entry.sideId === current?.sideId}
              data-active={entry.sideId === current?.sideId || undefined}
              onClick={() => setSideId(entry.sideId)}
              title={entry.messages[0]?.text}
            >
              {entry.messages[0]?.text.slice(0, 24) || `旁支 ${index + 1}`}
            </button>
          ))}
          <button type="button" role="tab" aria-selected={!current} data-active={!current || undefined} onClick={() => setSideId("new")}>
            ＋ 新的旁支
          </button>
        </div>
      )}
      {current && (
        <div className="side-chat-messages">
          {current.messages.map((message, index) => (
            <SideMessageView key={message.id} message={message} answering={current.running && index === current.messages.length - 1} />
          ))}
          <div ref={end} />
        </div>
      )}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          ask();
        }}
      >
        <Textarea
          aria-label="旁支问题"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              ask();
            }
          }}
          rows={3}
          maxLength={20_000}
          disabled={!online}
          placeholder={current ? "接着问…" : `问 ${label}…`}
        />
        <ErrorNotice error={job.error} />
        <div className="permission-buttons">
          {current?.running ? (
            <Button type="button" variant="outline" onClick={() => void job.run(() => actions.cancelSide(session.id, current.sideId))}>
              停止回答
            </Button>
          ) : (
            <Button type="submit" disabled={!online || job.busy || !draft.trim()}>
              {current ? "接着问" : "提问"}
            </Button>
          )}
          {current && (
            <Button
              type="button"
              variant="ghost"
              disabled={job.busy}
              onClick={() =>
                void job.run(async () => {
                  await actions.closeSide(session.id, current.sideId);
                  setSideId(undefined);
                })
              }
            >
              结束这个旁支
            </Button>
          )}
        </div>
      </form>
    </section>
  );
}

function SideMessageView({ message, answering }: { message: SideMessage; answering: boolean }) {
  if (message.role === "user")
    return (
      <article className="user-message">
        <p>{message.text}</p>
      </article>
    );
  return (
    <article className="side-answer">
      {message.activity?.length ? (
        <ul className="side-activity">
          {message.activity.map((line, index) => (
            <li key={index}>{line}</li>
          ))}
        </ul>
      ) : null}
      {message.text && <RichText text={message.text} />}
      {answering && !message.text && (
        <p className="conversation-activity" role="status">
          <LoaderCircle aria-hidden="true" />
          <span>正在回答…</span>
        </p>
      )}
      {message.error && <p className={message.error === "已停止" ? "muted" : "form-error"}>{message.error}</p>}
    </article>
  );
}
