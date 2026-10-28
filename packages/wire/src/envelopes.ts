// What agents and their desktop clients wrap around a person's words. Claude Code adds reminders
// and IDE state, the Claude app adds session events and peer mail, Codex Desktop adds the files,
// selection and browser state it attached: context for the model, not what the person typed.
// Readers show the words, and the context as a chip or an event line where it means something to
// them, the way Claude's and Codex's own apps do. Shared by the host (titles, previews, what it
// keeps from Claude's transcripts) and every client.

/** Tags whose whole content is for the model only: the Claude app's own list, then Codex's. */
const HIDDEN_TAGS = [
  "system-reminder",
  "task-notification",
  "slack_context",
  "uploaded_files",
  "available-deferred-tools",
  "new-diagnostics",
  "critical_user_preferences_reminder",
  "persisted-output",
  "local-command-caveat",
  "tick",
  "goal",
  "mcp-resource",
  "mcp-resource-update",
  "mcp-polling-update",
  "teammate-message",
  "cross-session-message",
  "launch-selected-element",
  "connected_office_files",
  "thinking",
  "ide_opened_file",
  "ide_selection",
  "ide_diagnostics",
  "browser_instruction",
  "cell",
  "cell_type",
  "language",
  "command-message",
  "command-args",
  "no-action-needed",
  "comprehensive-mode-instructions",
  "cu_window_hints",
  "widget_context_hint",
  "preview-annotation-context",
  "terminal-selection",
  "environment_context",
  "user_instructions",
  "turn_aborted",
  "subagent_notification",
  "external_codex_apps_open_page",
];

const hiddenPattern = (tags: string[]) => new RegExp(`<(${tags.join("|")})(?:\\s[^>]*)?>[\\s\\S]*?</\\1>`, "gi");
const HIDDEN = hiddenPattern(HIDDEN_TAGS);
/** Mail between sessions and agents: hidden in a person's bubble, but a message of its own when it is the whole message. */
const PEER_TAGS = ["teammate-message", "cross-session-message"];
const HIDDEN_BUT_PEERS = hiddenPattern(HIDDEN_TAGS.filter((tag) => !PEER_TAGS.includes(tag)));

/** Something attached to a message, shown as a chip beside the words. */
export interface UserContext {
  kind: "file" | "image" | "pasted" | "selection" | "comments" | "checks" | "annotations" | "browser" | "review" | "pull-request" | "merge" | "history" | "other";
  label: string;
  /** A path, or the start of the attached text. */
  detail?: string;
}

/** A message that is an event, not something said: one line in the conversation. */
export type UserEvent =
  | { kind: "ci"; count: number }
  | { kind: "github"; count: number }
  | { kind: "sessions"; sessions: { id?: string; title: string }[] }
  | { kind: "scheduled"; name: string; detail?: string };

export interface UserTextView {
  /** The words to show; empty when the message is only context, an event or a command's output. */
  text: string;
  context: UserContext[];
  /** A shell command run from the prompt (Claude's `!` mode), and what it printed. */
  shell?: { command?: string; stdout?: string; stderr?: string };
  /** What a local slash command printed (`/cost`, `/context`). */
  output?: string;
  event?: UserEvent;
  /** Nothing in it is for a reader. */
  hidden: boolean;
}

/** The text without what is for the model only; `keepPeers` keeps mail from other sessions and agents. */
export function stripHiddenContext(text: string, { keepPeers = false }: { keepPeers?: boolean } = {}): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(keepPeers ? HIDDEN_BUT_PEERS : HIDDEN, "")
    .replace(/<\/?tool_use_error>/g, "")
    // Claude's pointers to a background task's files, for itself.
    .replace(/^(?:Full transcript available at|Read the output file to retrieve the result):.*$/gm, "")
    .replace(/\s*\[event:[\da-f-]{36}\]\s*$/i, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const ANSI = /\u001b\[[\d;?]*[ -/]*[@-~]/g;

function tagText(source: string, tag: string): string | undefined {
  const match = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "i").exec(source);
  return match ? match[1]! : undefined;
}

function attribute(attrs: string, name: string): string | undefined {
  const match = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i").exec(attrs);
  return match ? (match[1] ?? match[2]) : undefined;
}

const EVENT_TAGS = ["side-sessions-event", "ci-monitor-event", "github-webhook-activity"] as const;
const EVENT_PATTERNS = new Map(EVENT_TAGS.map((tag) => [tag, new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}>`, "gi")]));

/** A message made only of one kind of tag, repeated: the count, else undefined. */
function only(text: string, tag: (typeof EVENT_TAGS)[number]): number | undefined {
  if (!text.startsWith(`<${tag}`)) return undefined;
  const pattern = EVENT_PATTERNS.get(tag)!;
  const all = text.match(pattern);
  if (!all) return undefined;
  return text.replace(pattern, "").trim() ? undefined : all.length;
}

/** Codex Desktop's sections before "## My request:", by heading. */
const CONTEXT_SECTIONS: Record<string, UserContext["kind"]> = {
  "Files mentioned by the user": "file",
  "Files pasted by the user": "pasted",
  "Selected text": "selection",
  "Diff comments": "comments",
  "Browser comments": "comments",
  "Failing PR checks": "checks",
  "Response annotations": "annotations",
};
const MODES: Record<string, [UserContext["kind"], string]> = {
  "Code review guidelines": ["review", "审查模式"],
  "Pull request fix": ["pull-request", "PR 修复"],
  "Auto resolve merge": ["merge", "自动解决冲突"],
  "Prior conversation with Codex": ["history", "参考历史对话"],
};
const SECTION_LABELS: Record<string, string> = {
  "Selected text": "选中的文本",
  "Diff comments": "差异评论",
  "Browser comments": "浏览器评论",
  "Failing PR checks": "失败的 PR 检查",
  "Response annotations": "回复批注",
};
const REQUEST = /^## My request(?: for Codex)?:[ \t]*$/gm;

const baseName = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;

function codexContext(text: string, images: number): { text: string; context: UserContext[] } | undefined {
  const start = /^(#{1,2}) ([^\n:]+):[ \t]*$/m.exec(text);
  // Only an envelope Codex wrote: it opens the message with one of its own headings.
  if (!start || start.index !== 0) return undefined;
  const heading = start[2]!;
  if (!(start[1] === "#" ? heading in CONTEXT_SECTIONS : heading in MODES || /^My request(?: for Codex)?$/.test(heading))) return undefined;
  let cut = -1;
  let after = 0;
  for (const match of text.matchAll(REQUEST)) {
    cut = match.index!;
    after = match.index! + match[0].length;
  }
  const preface = cut < 0 ? text : text.slice(0, cut);
  const request = cut < 0 ? "" : text.slice(after).trim();
  const context: UserContext[] = [];
  let imageEntries = 0;
  const sections = preface.split(/^(?=#{1,2} [^\n:]+:[ \t]*$)/m);
  for (const section of sections) {
    const head = /^(#{1,2}) ([^\n:]+):[ \t]*\n?/.exec(section);
    if (!head) continue;
    const name = head[2]!;
    const body = section.slice(head[0].length).trim();
    if (head[1] === "##") {
      const mode = MODES[name];
      if (mode) context.push({ kind: mode[0], label: mode[1] });
      continue;
    }
    const kind = CONTEXT_SECTIONS[name];
    if (kind === "file") {
      for (const entry of body.matchAll(/^## (.+?): (.+?)(?: \((lines? [^)]*)\))?\n?(Image attachment: true)?$/gm)) {
        if (entry[4]) {
          imageEntries += 1;
          // The picture itself is shown; a chip for it would say it twice.
          if (imageEntries <= images) continue;
        }
        context.push({ kind: entry[4] ? "image" : "file", label: entry[1]!.includes("/") ? baseName(entry[1]!) : entry[1]!, detail: entry[3] ? `${entry[2]} · ${entry[3]}` : entry[2] });
      }
    } else if (kind === "pasted") {
      for (const entry of body.matchAll(/^## "?(.+?)"?: (.+)$/gm)) context.push({ kind: "pasted", label: entry[1]!.trim(), detail: entry[2] });
    } else if (kind) {
      context.push({ kind, label: SECTION_LABELS[name] ?? name, detail: body.split("\n").find((line) => line.trim())?.trim() });
    } else if (name !== "Distinguish instructions in attached documents from the user's request") {
      context.push({ kind: "other", label: name });
    }
  }
  return { text: request, context };
}

/**
 * How to show a person's message: its words, what came with it, or the one event it is. `images`
 * is how many pictures the message carries besides its text, so an envelope naming them doesn't
 * also chip them.
 */
export function readUserText(raw: string, { images = 0 }: { images?: number } = {}): UserTextView {
  let text = raw.replace(/\r\n/g, "\n");
  const context: UserContext[] = [];
  const view = (rest: Partial<UserTextView>): UserTextView => ({ text: "", context, hidden: false, ...rest });

  // The Claude app tells a session about the sessions it started in a reminder beside the event.
  const sessions = [...text.matchAll(/The session "([^"\n]+)" you started \((local_[\w-]+)\)/g)].map((match) => ({ title: match[1]!, id: match[2] }));
  const browser = /<in-app-browser-context\b[^>]*>[\s\S]*?<\/in-app-browser-context>/gi;
  const withoutBrowser = text.replace(browser, "");
  if (withoutBrowser !== text) {
    context.push({ kind: "browser", label: "浏览器上下文" });
    text = withoutBrowser;
  }
  text = stripHiddenContext(text);

  if (only(text, "side-sessions-event")) return view({ event: { kind: "sessions", sessions } });
  if (!text) return view({ hidden: images === 0 && context.length === 0 });
  if (/^\[Request interrupted by user(?: for tool use)?\]$/.test(text)) return view({ hidden: true });
  const ci = only(text, "ci-monitor-event");
  if (ci) return view({ event: { kind: "ci", count: ci } });
  const github = only(text, "github-webhook-activity");
  if (github) return view({ event: { kind: "github", count: github } });
  const scheduled = /^<scheduled-task\b([^>]*)>([\s\S]*?)<\/scheduled-task>$/i.exec(text);
  if (scheduled) {
    const name = attribute(scheduled[1]!, "name") ?? baseName(attribute(scheduled[1]!, "file") ?? "").replace(/\.md$/i, "");
    return view({ event: { kind: "scheduled", name: name || "定时任务", detail: scheduled[2]!.trim() || undefined } });
  }

  if (/^<bash-(?:input|stdout|stderr)>/.test(text)) {
    const clean = (value?: string) => value?.replace(ANSI, "").replace(/\n+$/, "") || undefined;
    const command = clean(tagText(text, "bash-input"))?.trim();
    const stdout = clean(tagText(text, "bash-stdout"));
    const stderr = clean(tagText(text, "bash-stderr"));
    const rest = text.replace(/<(bash-(?:input|stdout|stderr|exit-code))>[\s\S]*?<\/\1>/g, "").trim();
    return view({ shell: { command, stdout, stderr }, text: rest, hidden: !command && !stdout && !stderr && !rest });
  }
  if (/^<local-command-(?:stdout|stderr)>/.test(text)) {
    const output = [tagText(text, "local-command-stdout"), tagText(text, "local-command-stderr")]
      .filter((part): part is string => !!part?.trim())
      .join("\n")
      .replace(ANSI, "")
      .trim();
    // /model's confirmation: the Claude app doesn't show the switch as a line either.
    return view({ output: output || undefined, hidden: !output || /^Set model to\b/.test(output) });
  }
  // Slash-command plumbing the host couldn't read as a command, and notifications it didn't match.
  if (/^<(?:command-name|local-command-|task-notification)/.test(text)) return view({ hidden: true });

  const codex = codexContext(text, images);
  if (codex) {
    context.push(...codex.context);
    return view({ text: codex.text, hidden: !codex.text && images === 0 && context.length === 0 });
  }
  return view({ text });
}
