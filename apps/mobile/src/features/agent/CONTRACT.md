# Agent Console — Module Contract

Authoritative reference for the clean rewrite of the mobile agent console under
`apps/mobile/src/features/agent/`. Phase 2 (this commit) established the `lib/`
foundation and `types.ts`. Phase 3 builds the components listed below.

## Module tree

```
apps/mobile/src/features/agent/
├── CONTRACT.md                  ← this file
├── types.ts                     ← re-exports (single source of truth; no redefinition)
├── lib/
│   ├── format.ts                ← theme color helpers, formatting, constants, Option<T>
│   ├── capabilities.ts          ← provider capability → model/effort/permission options
│   ├── commands.ts              ← slash-command + @-mention tokenizers, command resolution
│   ├── diff.ts                  ← diff parsing/stats, syntax tokenizer, command humanizer
│   └── timeline.ts              ← timeline dedupe/filter, subagent/notice/delivery helpers
└── components/                  ← phase 3 (one file per component, see below)
    ├── CodeBlock.tsx
    ├── DiffBlock.tsx
    ├── HighlightedCodeLine.tsx
    ├── MarkdownContent.tsx
    ├── MessageContent.tsx
    ├── UserMessageContent.tsx
    ├── StreamingPill.tsx
    ├── TimelineSeparator.tsx
    ├── AgentTimelineBlock.tsx
    ├── SystemActivityCard.tsx
    ├── SubagentCard.tsx
    ├── StructuredInputCard.tsx
    ├── PermissionRequestCard.tsx
    ├── PlanCard.tsx
    ├── NoticeStrip.tsx
    ├── AssistantMessage.tsx
    ├── SystemMessageCard.tsx
    ├── UserMessageCard.tsx
    ├── ErrorCard.tsx
    ├── FileChangeCard.tsx
    ├── ToolCard.tsx
    ├── AgentConversationSkeleton.tsx
    ├── SlashCommandPanel.tsx
    ├── MentionPanel.tsx
    ├── QueuedFollowUpList.tsx
    ├── FilePreviewDrawer.tsx
    └── TimelineItemView.tsx      ← dispatcher
```

## lib/ public API (already migrated, verbatim behavior)

- **format.ts** — `Option<T>` type; constants `EFFORT_OPTIONS`, `PERMISSION_OPTIONS`,
  `MAX_IMAGE_ATTACHMENTS`, `MAX_IMAGE_DATA_URL_LENGTH`, `FILE_PREVIEW_MAX_BYTES`,
  `DEFAULT_OPTION_ID`, `MONO_FONT`; functions `timelineSurface`, `agentEventSurface`,
  `agentEventBorder`, `statusMeta`, `visibleConversationStatus`, `toolStatusMeta`,
  `permissionMeta`, `formatEffort`, `formatRuntime`, `formatModel`,
  `permissionModeNeedsAttention`, `shortPath`, `displayProvider`, `parentPath`,
  `fileName`, `formatBytes`, `languageFromPath`, `compactPath`, `normalizedToken`,
  `isEmptyActivityText`.
- **capabilities.ts** — `providerCapabilityFor`, `modelOptionsFor`, `effortOptionsFor`,
  `permissionOptionsFor`; re-exports `Option<T>`.
- **commands.ts** — `trailingSlashCommandToken`, `trailingMentionToken`,
  `commandSearchBlob`, `filteredCommands`, `commandCategoryLabel`, `commandRawText`,
  `commandFromMessage`, `isElevatedPermissionOption`.
- **diff.ts** — types `FileDiffEntry`, `HighlightToken`; functions `looksLikeDiff`,
  `diffStats`, `diffEntries`, `diffLineColors`, `syntaxTokens`, `commandLanguage`,
  `unwrapShell`, `lastCommandTarget`, `humanizeCommand`.
- **timeline.ts** — types `TimelineBottomSpacer`, `TimelineListItem`, `AgentRailTone`;
  functions `isTimelineBottomSpacer`, `agentRailColor`, `subagentTitle`,
  `subagentStatusLabel`, `subagentDisplayName`, `fileToolDedupeKey`,
  `dedupeTimelineItems`, `userMessageDeliveryLabel`, `isQueuedFollowUpItem`,
  `isQueuedFollowUpPlaceholder`, `queuedFollowUpText`, `imageBlockFromAsset`,
  `noticeAccent`.

## Import conventions (MANDATORY for all phase-3 components)

- Theme: `import { useTheme, type Theme } from "../../../theme";`
  Leaf cards receive `theme: Theme` as a **prop** — do NOT call `useTheme()` inside
  leaf cards. The screen calls `useTheme()` once and passes `theme` down. (Only the
  top-level screen and self-contained drawers like `FilePreviewDrawer` that already
  receive `theme` as a prop follow the prop convention too.)
- Icons: `import { AppSymbol } from "../../../components/AppSymbol";`
- Lib helpers: `import { ... } from "../lib/format";` (or `../lib/diff`, etc.)
- Types: `import type { ... } from "../types";`
- Image: `import { Image } from "expo-image";`
- Clipboard/haptics copy helper: components needing copy use a shared
  `copy(value): Promise<boolean>` helper (Clipboard + verification + haptic). This
  helper lives in the screen today; phase 3 should host it in a shared module
  (e.g. `lib/clipboard.ts`) and import it. Not part of the migrated lib yet.

## Component rules

1. Components are **pure / memo'd** where the source memoized them
   (`MarkdownContent`, `FileChangeCard`, `ToolCard`, `TimelineItemView` are `memo`).
2. Components receive `theme` as a prop. No `useTheme()` in leaf cards.
3. **No data-fetching inside cards.** Cards render from props only. The only
   exception is `FilePreviewDrawer`, which owns its own browse/read lifecycle via
   the `workspace` handle passed as a prop (mirrors the source).
4. Local UI state (expand/collapse, copied flag, form selection) stays local with
   `useState` — this is presentational state, not data.
5. Chinese UI text is preserved verbatim.

## Component specs

### CodeBlock — `components/CodeBlock.tsx`
```ts
function CodeBlock(props: {
  label: string;
  code: string;
  theme: Theme;
  maxLines?: number;
}): JSX.Element
```
Imports: `AppSymbol`; `MONO_FONT` from `../lib/format` (or inline `Platform.select`);
shared `copy` helper. Local `copied` state with 1200ms reset; copy failure → Alert.

### DiffBlock — `components/DiffBlock.tsx`
```ts
function DiffBlock(props: { diff: string; theme: Theme; expanded: boolean }): JSX.Element
```
Imports: `diffLineColors` from `../lib/diff`; `MONO_FONT`. Line cap 18 collapsed /
500 expanded; overflow footer "还有 N 行".

### HighlightedCodeLine — `components/HighlightedCodeLine.tsx`
```ts
function HighlightedCodeLine(props: {
  line: string;
  lineNumber: number;
  language: string;
  theme: Theme;
}): JSX.Element
```
Imports: `syntaxTokens` from `../lib/diff`; `MONO_FONT` from `../lib/format`.

### MarkdownContent — `components/MarkdownContent.tsx`
```ts
const MarkdownContent: React.MemoExoticComponent<(props: {
  text: string;
  theme: Theme;
  inverse?: boolean;
  monospace?: boolean;
}) => JSX.Element>
```
Imports: `Markdown` from `react-native-markdown-display`; `Linking` from `expo-linking`
(http(s)-only `onLinkPress`); `MONO_FONT` from `../lib/format`; `CodeBlock` (for
`fence`/`code_block` rules). `memo`.

### MessageContent — `components/MessageContent.tsx`
```ts
function MessageContent(props: {
  blocks?: AgentContentBlock[];
  fallbackText?: string;
  theme: Theme;
  inverse?: boolean;
  monospace?: boolean;
}): JSX.Element
```
Imports: `Image` from `expo-image`; `AppSymbol`; `MarkdownContent`; type
`AgentContentBlock` from `../types`. Image thumbnails (220 × aspect 4/3) + markdown.

### UserMessageContent — `components/UserMessageContent.tsx`
```ts
function UserMessageContent(props: {
  blocks?: AgentContentBlock[];
  fallbackText?: string;
  theme: Theme;
}): JSX.Element
```
Imports: `Image` from `expo-image`; `AppSymbol`; type `AgentContentBlock`.
Plain selectable text (no markdown) + image thumbnails.

### StreamingPill — `components/StreamingPill.tsx`
```ts
function StreamingPill(props: { theme: Theme }): JSX.Element
```
Imports: `ActivityIndicator`. Spinner + "正在生成".

### TimelineSeparator — `components/TimelineSeparator.tsx`
```ts
const TimelineSeparator: () => JSX.Element   // 12px spacer, no props
```

### AgentTimelineBlock — `components/AgentTimelineBlock.tsx`
```ts
function AgentTimelineBlock(props: {
  children: React.ReactNode;
  theme: Theme;
  tone?: AgentRailTone;   // default "default"
}): JSX.Element
```
Imports: `agentRailColor`, type `AgentRailTone` from `../lib/timeline`. Left rail/
connector with tone-colored dot.

### SystemActivityCard — `components/SystemActivityCard.tsx`
```ts
function SystemActivityCard(props: {
  icon: string;
  title: string;
  text?: string;
  theme: Theme;
  running?: boolean;
}): JSX.Element
```
Imports: `AppSymbol`, `ActivityIndicator`. Collapsible when `text.length > 120`
(2-line clamp collapsed).

### SubagentCard — `components/SubagentCard.tsx`
```ts
function SubagentCard(props: {
  action: AgentSubagentAction;
  theme: Theme;
  running?: boolean;
}): JSX.Element
```
Imports: `AppSymbol`, `ActivityIndicator`; `subagentTitle`, `subagentStatusLabel`,
`subagentDisplayName` from `../lib/timeline`; `agentEventSurface`, `agentEventBorder`
from `../lib/format`; type `AgentSubagentAction`. Expanded by default.

### StructuredInputCard — `components/StructuredInputCard.tsx`
```ts
function StructuredInputCard(props: {
  input: AgentStructuredInput;
  theme: Theme;
  submitted?: boolean;
  submitting?: boolean;
  error?: string;
  onSubmit: (answers: Record<string, string[]>) => void;
}): JSX.Element
```
Imports: `AppSymbol`, `TextInput`, `Pressable`; `Haptics` from `expo-haptics`;
`agentEventSurface`, `agentEventBorder` from `../lib/format`; type
`AgentStructuredInput`. Local `selected`/`typed` state; `canSubmit` gate.

### PermissionRequestCard — `components/PermissionRequestCard.tsx`
```ts
function PermissionRequestCard(props: {
  item: AgentTimelineItem;
  theme: Theme;
  onPermission: (
    requestId: string,
    outcome: "allow" | "deny" | "cancelled",
    optionId?: string,
  ) => void;
}): JSX.Element
```
Imports: `AppSymbol`, `ActivityIndicator`, `Alert`; `isElevatedPermissionOption`
from `../lib/commands`; `agentEventSurface`, `agentEventBorder` from `../lib/format`;
`MarkdownContent`, `CodeBlock`; type `AgentTimelineItem`. Elevated option →
confirm Alert. Reads metadata: `permissionOutcome`, `permissionPending`,
`permissionLive`, `permissionExpired`, `optionId`, `permissionError`.

### PlanCard — `components/PlanCard.tsx`
```ts
function PlanCard(props: { steps: AgentPlanStep[]; theme: Theme }): JSX.Element
```
Imports: `AppSymbol`; `agentEventSurface`, `agentEventBorder` from `../lib/format`;
type `AgentPlanStep`.

### NoticeStrip — `components/NoticeStrip.tsx`
```ts
function NoticeStrip(props: {
  notices: AgentNotice[];
  theme: Theme;
  onDismiss: (id: string) => void;
}): JSX.Element | null
```
Imports: `AppSymbol`; `noticeAccent` from `../lib/timeline`; type `AgentNotice`.

### AssistantMessage — `components/AssistantMessage.tsx`
```ts
function AssistantMessage(props: {
  item: AgentTimelineItem;
  text: string;
  theme: Theme;
}): JSX.Element
```
Imports: `AppSymbol`, `Alert`, `Pressable`; `Haptics`; shared `copy` helper;
`agentEventBorder` from `../lib/format`; `MessageContent`, `StreamingPill`;
type `AgentTimelineItem`. "复制回复"→"已复制" pill.

### SystemMessageCard — `components/SystemMessageCard.tsx`
```ts
function SystemMessageCard(props: { text: string; theme: Theme }): JSX.Element
```
Imports: `AppSymbol`; `agentEventSurface`, `agentEventBorder` from `../lib/format`.

### UserMessageCard — `components/UserMessageCard.tsx`
```ts
function UserMessageCard(props: {
  item: AgentTimelineItem;
  text: string;
  theme: Theme;
  deliveryLabel: { text: string; pending: boolean } | null;
  onEdit?: (text: string) => void;
}): JSX.Element
```
Imports: `AppSymbol`, `ActivityIndicator`, `Pressable`; `UserMessageContent`,
`StreamingPill`; type `AgentTimelineItem`. Steer border styling; edit pill.

### ErrorCard — `components/ErrorCard.tsx`
```ts
function ErrorCard(props: { text: string; theme: Theme }): JSX.Element
```
Imports: `AppSymbol`. `errorLight` bg, "Agent 出错了".

### FileChangeCard — `components/FileChangeCard.tsx`
```ts
const FileChangeCard: React.MemoExoticComponent<(props: {
  tool: AgentToolCall;
  theme: Theme;
}) => JSX.Element>
```
Imports: `AppSymbol`; `looksLikeDiff`, `diffStats`, `diffEntries` from `../lib/diff`;
`toolStatusMeta`, `agentEventSurface`, `agentEventBorder`, `shortPath` from
`../lib/format`; `DiffBlock`, `CodeBlock`; type `AgentToolCall`. `memo`. Local
`expanded` state.

### ToolCard — `components/ToolCard.tsx`
```ts
const ToolCard: React.MemoExoticComponent<(props: {
  tool: AgentToolCall;
  theme: Theme;
}) => JSX.Element>
```
Imports: `AppSymbol`, `ActivityIndicator`; `toolStatusMeta`, `agentEventSurface`,
`agentEventBorder` from `../lib/format`; `commandLanguage`, `humanizeCommand` from
`../lib/diff`; `CodeBlock`, `FileChangeCard` (delegates when name includes "文件");
type `AgentToolCall`. `memo`. Local `expanded` state.

### AgentConversationSkeleton — `components/AgentConversationSkeleton.tsx`
```ts
function AgentConversationSkeleton(props: { theme: Theme }): JSX.Element
```
Imports: `ActivityIndicator`. 4 placeholder bubbles.

### SlashCommandPanel — `components/SlashCommandPanel.tsx`
```ts
function SlashCommandPanel(props: {
  commands: AgentCommandDescriptor[];
  query: string;
  theme: Theme;
  onSelect: (command: AgentCommandDescriptor) => void;
  onClose: () => void;
}): JSX.Element
```
Imports: `AppSymbol`, `Pressable`, `ScrollView`; `filteredCommands`,
`commandCategoryLabel` from `../lib/commands`; `timelineSurface` from `../lib/format`;
type `AgentCommandDescriptor`.

### MentionPanel — `components/MentionPanel.tsx`
```ts
function MentionPanel(props: {
  entries: AgentFileEntry[];
  loading: boolean;
  error?: string;
  currentDir: string;
  canNavigateUp: boolean;
  theme: Theme;
  onSelect: (entry: AgentFileEntry) => void;
  onNavigateUp: () => void;
  onClose: () => void;
}): JSX.Element
```
Imports: `AppSymbol`, `ActivityIndicator`, `Pressable`, `ScrollView`;
`timelineSurface`, `MONO_FONT` from `../lib/format`; type `AgentFileEntry`.

### QueuedFollowUpList — `components/QueuedFollowUpList.tsx`
```ts
function QueuedFollowUpList(props: {
  items: AgentTimelineItem[];
  theme: Theme;
  canSteer: boolean;
  onSteer: (item: AgentTimelineItem) => void;
  onDiscard: (item: AgentTimelineItem) => void;
}): JSX.Element | null
```
Imports: `AppSymbol`, `Pressable`, `ScrollView`; `queuedFollowUpText` from
`../lib/timeline`; type `AgentTimelineItem`.

### FilePreviewDrawer — `components/FilePreviewDrawer.tsx`
```ts
function FilePreviewDrawer(props: {
  visible: boolean;
  conversationId: string;
  cwd: string;
  workspace: AgentWorkspaceHandle;
  theme: Theme;
  topInset: number;
  bottomInset: number;
  onClose: () => void;
}): JSX.Element | null
```
Imports: `AppSymbol`, `ActivityIndicator`, `Pressable`, `ScrollView`, `Alert`;
`parentPath`, `fileName`, `formatBytes`, `languageFromPath`, `MONO_FONT`,
`FILE_PREVIEW_MAX_BYTES` from `../lib/format`; shared `copy` helper;
`HighlightedCodeLine`; types `AgentFileEntry`, `AgentFileReadResult`,
`AgentWorkspaceHandle`. Owns browse/read lifecycle (race guards + 16s timeout
fallback) — the only card permitted to call the workspace handle.

### TimelineItemView — `components/TimelineItemView.tsx` (dispatcher)
```ts
const TimelineItemView: React.MemoExoticComponent<(props: {
  item: AgentTimelineItem;
  theme: Theme;
  onPermission: (
    requestId: string,
    outcome: "allow" | "deny" | "cancelled",
    optionId?: string,
  ) => void;
  onStructuredInput: (requestId: string, answers: Record<string, string[]>) => void;
  onEditMessage?: (text: string) => void;
}) => JSX.Element | null>
```
Imports: `isEmptyActivityText` from `../lib/format`; type `AgentRailTone` from
`../lib/timeline`; `userMessageDeliveryLabel` from `../lib/timeline`; type
`AgentTimelineItem`; and every card above (`AgentTimelineBlock`, `SubagentCard`,
`StructuredInputCard`, `SystemActivityCard`, `AssistantMessage`,
`SystemMessageCard`, `UserMessageCard`, `ToolCard`, `FileChangeCard`, `PlanCard`,
`PermissionRequestCard`, `ErrorCard`). `memo`. Maps an item by `kind`/`type` to the
correct card wrapped in `AgentTimelineBlock` (assistant/user messages render
without the rail wrapper, per source).
```
