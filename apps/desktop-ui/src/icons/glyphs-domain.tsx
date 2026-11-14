import type { ReactNode } from "react";

/**
 * LinkShell's 17 bespoke domain icons (`24x24` coordinate grid, `[2..22]` optical live area).
 * Crafted specifically for LinkShell's multi-computer agent, transport, worktree, screen,
 * and macOS Seamless App-Window Fusion (`融合模式`) workflows.
 */
export const DOMAIN_ICON_GLYPHS = {
  /**
   * 融合模式 (Fusion Mode — Signature Icon):
   * Recessed dashed remote desktop frame seamlessly projecting a solid foreground native
   * app window with titlebar & window control dot.
   */
  "fusion-mode": (
    <>
      <path d="M4 15.5V6.25A2.25 2.25 0 0 1 6.25 4H15.5" strokeDasharray="2.2 2.2" />
      <rect x="8" y="8" width="12.5" height="12" rx="2.5" />
      <path d="M8 11.75H20.5" />
      <circle cx="10.75" cy="9.9" r="0.75" fill="currentColor" stroke="none" />
    </>
  ),

  /** 远端完整桌面屏幕 (Remote Full Screen): Widescreen display + viewport focus brackets. */
  "remote-screen": (
    <>
      <rect x="2.75" y="4" width="18.5" height="13" rx="2.25" />
      <path d="M9 20.25H15M12 17V20.25" />
      <path d="M6.25 9V7.25H8M17.75 12V13.75H16" />
    </>
  ),

  /** 本机 Host 守护服务 (Local Host Daemon): Dual-plane service rack with live LEDs. */
  "host-daemon": (
    <>
      <rect x="3.5" y="4.5" width="17" height="6.5" rx="2" />
      <rect x="3.5" y="13" width="17" height="6.5" rx="2" />
      <circle cx="7" cy="7.75" r="0.95" fill="currentColor" stroke="none" />
      <circle cx="7" cy="16.25" r="0.95" fill="currentColor" stroke="none" />
      <path d="M10.5 7.75H17M10.5 16.25H14.5" />
    </>
  ),

  /** 加密网关中继 (Gateway E2EE Relay): Peer endpoints bridged via central E2E diamond hub. */
  "gateway-relay": (
    <>
      <circle cx="4.5" cy="12" r="2" />
      <circle cx="19.5" cy="12" r="2" />
      <path d="M6.5 12H7.5M16.5 12H17.5" />
      <path d="M12 6.5L16.5 12L12 17.5L7.5 12Z" />
      <path d="M12 10.5V13.5" />
    </>
  ),

  /** WebRTC 点对点直连 (Direct P2P Channel): Peer nodes linked directly via high-speed pulse. */
  "direct-p2p": (
    <>
      <circle cx="4.75" cy="12" r="2.25" />
      <circle cx="19.25" cy="12" r="2.25" />
      <path d="M7 12H10L11.5 8.5L12.5 15.5L14 12H17" />
    </>
  ),

  /** 扫码与配对码绑定 (Device QR / Code Pairing): Three finder squares + matrix bars. */
  "pair-qr": (
    <>
      <rect x="3.5" y="3.5" width="6.5" height="6.5" rx="1.25" />
      <rect x="14" y="3.5" width="6.5" height="6.5" rx="1.25" />
      <rect x="3.5" y="14" width="6.5" height="6.5" rx="1.25" />
      <path d="M14 14H17V17H14ZM20.5 14V20.5H16.5" />
    </>
  ),

  /** Git 隔离工作树 (Isolated Worktree): Main commit trunk branching into workspace box. */
  worktree: (
    <>
      <circle cx="6.5" cy="5.5" r="2" />
      <circle cx="6.5" cy="18.5" r="2" />
      <path d="M6.5 7.5V16.5" />
      <path d="M6.5 11.5C10.5 11.5 11 8.5 14.5 8.5" />
      <rect x="14.5" y="5.5" width="6" height="6" rx="1.5" />
      <path d="M17.5 11.5V17" />
      <circle cx="17.5" cy="18.5" r="1.5" />
    </>
  ),

  /** 会话分叉 (Session Fork): Single timeline origin splitting symmetrically into two heads. */
  "session-fork": (
    <>
      <circle cx="12" cy="19" r="2" />
      <circle cx="7" cy="5.5" r="2" />
      <circle cx="17" cy="5.5" r="2" />
      <path d="M12 17V13.25M12 13.25C12 10.25 7 10.25 7 7.5M12 13.25C12 10.25 17 10.25 17 7.5" />
    </>
  ),

  /** 子智能体委派 (Subagent Delegation): Parent agent ring delegating to autonomous child node. */
  subagent: (
    <>
      <circle cx="8" cy="8" r="3.5" />
      <path d="M11 10.25C13.5 11.75 14.25 13 15.25 14.75" />
      <path d="M17 13L20.5 16.5L17 20L13.5 16.5Z" />
    </>
  ),

  /** 工具权限审批护盾 (Approval Shield): Architectural shield + inner checkmark. */
  "approval-shield": (
    <>
      <path d="M12 3L19.5 6.25V11.75C19.5 16.4 16.3 19.9 12 21.25C7.7 19.9 4.5 16.4 4.5 11.75V6.25L12 3Z" />
      <path d="M9 12.25L11.1 14.35L15.25 9.75" />
    </>
  ),

  /** 待确认审批护盾 (Pending Approval Shield): Architectural shield + clock hands. */
  "approval-pending": (
    <>
      <path d="M12 3L19.5 6.25V11.75C19.5 16.4 16.3 19.9 12 21.25C7.7 19.9 4.5 16.4 4.5 11.75V6.25L12 3Z" />
      <path d="M12 8.25V12.25L14.5 13.75" />
    </>
  ),

  /** 代码变更 +/- (Code Diff Changes): Rounded diff card with stacked plus and minus. */
  "diff-changes": (
    <>
      <rect x="3.5" y="3.5" width="17" height="17" rx="3" />
      <path d="M9 9.5H15M12 6.5V12.5M9 16.25H15" />
    </>
  ),

  /** 单一规范终端会话图标 (Canonical Terminal). */
  terminal: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2.75" />
      <path d="M7.25 9.5L10.5 12L7.25 14.5M12.5 14.5H16.5" />
    </>
  ),

  /** 本地端口预览 (Loopback Port Preview): Browser viewport chrome + launch vector. */
  "port-preview": (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2.75" />
      <path d="M3 8.5H21M10 16L14.5 11.5M11 11.5H14.5V15" />
    </>
  ),

  /** 防休眠已开启 (Keep-Awake Active): Precision cup with twin steady thermal lines. */
  "keep-awake": (
    <>
      <path d="M5 9.5H15.5V14.5A4.5 4.5 0 0 1 11 19H9.5A4.5 4.5 0 0 1 5 14.5Z" />
      <path d="M15.5 10.5H17.5A2 2 0 0 1 19.5 12.5V13A2 2 0 0 1 17.5 15H15.5" />
      <path d="M8.5 4.25V6.75M12 4.25V6.75" />
    </>
  ),

  /** 防休眠已关闭 (Keep-Awake Off): Precision cup with muted diagonal slash. */
  "keep-awake-off": (
    <>
      <path d="M5 9.5H14.5M15.5 12V14.5A4.5 4.5 0 0 1 11 19H9.5A4.5 4.5 0 0 1 5 14.5V9.5" />
      <path d="M15.5 10.5H17.5A2 2 0 0 1 19.5 12.5V13A2 2 0 0 1 17.8 14.95" />
      <path d="M4 4L20 20" />
    </>
  ),

  /** Token 与协作价值统计 (Usage Telemetry): Three instrument columns over baseline. */
  "usage-meter": (
    <>
      <path d="M4 19.5H20" />
      <rect x="5.75" y="13" width="2.5" height="6.5" rx="0.75" />
      <rect x="10.75" y="5.5" width="2.5" height="14" rx="0.75" />
      <rect x="15.75" y="9.5" width="2.5" height="10" rx="0.75" />
    </>
  ),
} satisfies Record<string, ReactNode>;

export type DomainIconName = keyof typeof DOMAIN_ICON_GLYPHS;
