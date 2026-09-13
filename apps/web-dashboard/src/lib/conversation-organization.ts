import type { AgentConversation } from "./types";

export type OrganizationKind = "workspace" | "group" | "folder";

export interface OrganizationBucket {
  provider: string;
  key: string;
  label: string;
  kind: OrganizationKind;
  conversations: AgentConversation[];
}

export interface ProviderOrganization {
  provider: string;
  buckets: OrganizationBucket[];
}

export function folderLabel(cwd: string): string {
  if (!cwd || cwd === "—") return "(未知目录)";
  const parts = cwd.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || cwd;
}

export function publicWorkspaceRoots(roots: string[] | undefined): string[] {
  if (!roots?.length) return [];
  return roots.filter((root) => root && !root.includes("/.codex/visualizations/"));
}

export function workspaceLabel(roots: string[]): string {
  const names = roots.map(folderLabel);
  if (names.length === 0) return "工作区";
  if (names.length === 1) return names[0]!;
  if (names.length === 2) return `${names[0]} + ${names[1]}`;
  return `${names[0]} + ${names.length - 1} 个项目`;
}

/** Native grouping key for one conversation — Codex workspaces are not a single folder. */
export function conversationOrganization(conversation: AgentConversation): {
  key: string;
  label: string;
  kind: OrganizationKind;
} {
  if (conversation.provider === "codex") {
    const roots = publicWorkspaceRoots(conversation.workspaceRoots);
    if (roots.length > 1) {
      return {
        key: `ws:${[...roots].sort().join("\n")}`,
        label: workspaceLabel(roots),
        kind: "workspace",
      };
    }
  }
  if (conversation.provider === "claude" && conversation.group) {
    return { key: `group:${conversation.group}`, label: conversation.group, kind: "group" };
  }
  const cwd = conversation.cwd || "—";
  return { key: `cwd:${cwd}`, label: folderLabel(cwd), kind: "folder" };
}

export function buildProviderOrganization(conversations: AgentConversation[]): ProviderOrganization[] {
  const byProvider = new Map<string, Map<string, OrganizationBucket>>();
  for (const conversation of conversations) {
    const org = conversationOrganization(conversation);
    let buckets = byProvider.get(conversation.provider);
    if (!buckets) {
      buckets = new Map();
      byProvider.set(conversation.provider, buckets);
    }
    let bucket = buckets.get(org.key);
    if (!bucket) {
      bucket = {
        provider: conversation.provider,
        key: org.key,
        label: org.label,
        kind: org.kind,
        conversations: [],
      };
      buckets.set(org.key, bucket);
    }
    bucket.conversations.push(conversation);
  }
  const recency = (bucket: OrganizationBucket) =>
    bucket.conversations.reduce((max, conversation) => Math.max(max, conversation.lastActivityAt), 0);
  return [...byProvider.entries()]
    .map(([provider, buckets]) => ({
      provider,
      buckets: [...buckets.values()]
        .map((bucket) => ({
          ...bucket,
          conversations: [...bucket.conversations].sort((a, b) => b.lastActivityAt - a.lastActivityAt),
        }))
        .sort((a, b) => recency(b) - recency(a)),
    }))
    .sort((a, b) => a.provider.localeCompare(b.provider));
}

export function bucketDefaultCwd(bucket: OrganizationBucket): string | undefined {
  if (bucket.kind === "workspace") {
    const roots = publicWorkspaceRoots(bucket.conversations[0]?.workspaceRoots);
    return roots[0];
  }
  const cwd = bucket.conversations[0]?.cwd;
  return cwd && cwd !== "—" ? cwd : undefined;
}
