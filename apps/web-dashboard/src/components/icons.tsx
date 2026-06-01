import type { SVGProps } from "react";

// Minimal Lucide-style line-icon set (24×24, currentColor) replacing the emoji
// icons that made the UI look crude. One consistent stroke weight + viewBox.

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Svg({ size = 16, children, ...props }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {children}
    </svg>
  );
}

export const IconTerminal = (p: IconProps) => (
  <Svg {...p}><path d="m4 17 6-6-6-6" /><path d="M12 19h8" /></Svg>
);
export const IconFolder = (p: IconProps) => (
  <Svg {...p}><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" /></Svg>
);
export const IconFile = (p: IconProps) => (
  <Svg {...p}><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" /><path d="M14 2v4a2 2 0 0 0 2 2h4" /></Svg>
);
export const IconDevice = (p: IconProps) => (
  <Svg {...p}><rect width="20" height="14" x="2" y="3" rx="2" /><path d="M8 21h8M12 17v4" /></Svg>
);
export const IconPaperclip = (p: IconProps) => (
  <Svg {...p}><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" /></Svg>
);
export const IconSend = (p: IconProps) => (
  <Svg {...p}><path d="M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z" /><path d="m21.854 2.147-10.94 10.939" /></Svg>
);
export const IconStop = (p: IconProps) => (
  <Svg {...p}><rect width="14" height="14" x="5" y="5" rx="2" /></Svg>
);
export const IconClose = (p: IconProps) => (
  <Svg {...p}><path d="M18 6 6 18M6 6l12 12" /></Svg>
);
export const IconMenu = (p: IconProps) => (
  <Svg {...p}><path d="M4 6h16M4 12h16M4 18h16" /></Svg>
);
export const IconChevronRight = (p: IconProps) => (
  <Svg {...p}><path d="m9 18 6-6-6-6" /></Svg>
);
export const IconChevronLeft = (p: IconProps) => (
  <Svg {...p}><path d="m15 18-6-6 6-6" /></Svg>
);
export const IconChevronDown = (p: IconProps) => (
  <Svg {...p}><path d="m6 9 6 6 6-6" /></Svg>
);
export const IconArrowUp = (p: IconProps) => (
  <Svg {...p}><path d="m5 12 7-7 7 7M12 19V5" /></Svg>
);
export const IconRefresh = (p: IconProps) => (
  <Svg {...p}><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" /><path d="M21 3v5h-5M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" /><path d="M8 16H3v5" /></Svg>
);
export const IconPlus = (p: IconProps) => (
  <Svg {...p}><path d="M5 12h14M12 5v14" /></Svg>
);
export const IconWrench = (p: IconProps) => (
  <Svg {...p}><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" /></Svg>
);
export const IconImage = (p: IconProps) => (
  <Svg {...p}><rect width="18" height="18" x="3" y="3" rx="2" ry="2" /><circle cx="9" cy="9" r="2" /><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" /></Svg>
);
export const IconCheck = (p: IconProps) => (
  <Svg {...p}><path d="M20 6 9 17l-5-5" /></Svg>
);
export const IconShield = (p: IconProps) => (
  <Svg {...p}><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" /></Svg>
);
export const IconCornerUp = (p: IconProps) => (
  <Svg {...p}><path d="M5 9 1 5l4-4" /><path d="M1 5h14a4 4 0 0 1 4 4v10" transform="translate(2 4)" /></Svg>
);
export const IconLogo = (p: IconProps) => (
  <Svg {...p}><path d="m7 8-4 4 4 4M17 8l4 4-4 4M14 4l-4 16" /></Svg>
);
export const IconSun = (p: IconProps) => (
  <Svg {...p}><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" /></Svg>
);
export const IconMoon = (p: IconProps) => (
  <Svg {...p}><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" /></Svg>
);
export const IconMonitor = (p: IconProps) => (
  <Svg {...p}><rect width="20" height="14" x="2" y="3" rx="2" /><path d="M8 21h8M12 17v4" /></Svg>
);
export const IconPlug = (p: IconProps) => (
  <Svg {...p}><path d="M12 22v-5M9 8V2M15 8V2M18 8v3a6 6 0 0 1-12 0V8Z" /></Svg>
);
export const IconUsers = (p: IconProps) => (
  <Svg {...p}><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" /></Svg>
);
export const IconCopy = (p: IconProps) => (
  <Svg {...p}><rect width="14" height="14" x="8" y="8" rx="2" ry="2" /><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" /></Svg>
);
export const IconPencil = (p: IconProps) => (
  <Svg {...p}><path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" /><path d="M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z" /></Svg>
);
export const IconArchive = (p: IconProps) => (
  <Svg {...p}><rect width="20" height="5" x="2" y="3" rx="1" /><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8" /><path d="M10 12h4" /></Svg>
);
export const IconTrash = (p: IconProps) => (
  <Svg {...p}><path d="M3 6h18" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /><path d="M10 11v6M14 11v6" /></Svg>
);
export const IconSearch = (p: IconProps) => (
  <Svg {...p}><circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" /></Svg>
);
export const IconDots = (p: IconProps) => (
  <Svg {...p}><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /><circle cx="5" cy="12" r="1" /></Svg>
);
export const IconCommand = (p: IconProps) => (
  <Svg {...p}><path d="M15 6v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3" /></Svg>
);
export const IconExternal = (p: IconProps) => (
  <Svg {...p}><path d="M15 3h6v6" /><path d="M10 14 21 3" /><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /></Svg>
);
export const IconGlobe = (p: IconProps) => (
  <Svg {...p}><circle cx="12" cy="12" r="10" /><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20M2 12h20" /></Svg>
);
export const IconPhone = (p: IconProps) => (
  <Svg {...p}><rect width="14" height="20" x="5" y="2" rx="2" ry="2" /><path d="M12 18h.01" /></Svg>
);
export const IconComment = (p: IconProps) => (
  <Svg {...p}><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></Svg>
);

/** Real LinkShell brand logo (shared with the mobile app icon). */
export function BrandLogo({ size = 28, className }: { size?: number; className?: string }) {
  return (
    <img
      src="/logos/linkshell.png"
      alt="LinkShell"
      width={size}
      height={size}
      className={`rounded-lg object-contain ${className ?? ""}`}
      style={{ width: size, height: size }}
    />
  );
}

// ── Brand marks (fill-based, currentColor) ──────────────────────────

function BrandSvg({ size = 16, children, ...props }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      {...props}
    >
      {children}
    </svg>
  );
}

// OpenAI / Codex — the official blossom/knot mark.
export const IconOpenAI = (p: IconProps) => (
  <BrandSvg {...p}>
    <path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.1419.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997z" />
  </BrandSvg>
);

// Claude / Anthropic — the radial sunburst spark mark.
export const IconClaude = (p: IconProps) => (
  <BrandSvg {...p}>
    <path d="M12 2.2c.32 0 .58.26.58.58l.34 6.06 3.7-4.36a.58.58 0 0 1 .9.73l-3.2 5.16 5.5-2.62a.58.58 0 0 1 .5 1.05l-5.74 2.1 6.06.34a.58.58 0 0 1 0 1.16l-6.06.34 5.74 2.1a.58.58 0 0 1-.5 1.05l-5.5-2.62 3.2 5.16a.58.58 0 0 1-.9.73l-3.7-4.36-.34 6.06a.58.58 0 0 1-1.16 0l-.34-6.06-3.7 4.36a.58.58 0 0 1-.9-.73l3.2-5.16-5.5 2.62a.58.58 0 0 1-.5-1.05l5.74-2.1-6.06-.34a.58.58 0 0 1 0-1.16l6.06-.34-5.74-2.1a.58.58 0 0 1 .5-1.05l5.5 2.62-3.2-5.16a.58.58 0 0 1 .9-.73l3.7 4.36.34-6.06c0-.32.26-.58.58-.58z" />
  </BrandSvg>
);

/** Real provider brand logo (PNG, shared with the mobile app). Falls back to a
 *  wrench icon for unknown providers. */
export function ProviderIcon({ provider, size = 14, className }: { provider: string; size?: number; className?: string }) {
  const src =
    provider === "codex"
      ? "/logos/codex.png"
      : provider === "claude"
        ? "/logos/claude.png"
        : provider === "gemini"
          ? "/logos/gemini.png"
          : provider === "copilot"
            ? "/logos/copilot.png"
            : null;
  if (!src) return <IconWrench size={size} className={className ?? "text-content-faint"} />;
  return (
    <img
      src={src}
      alt={provider}
      width={size}
      height={size}
      className={`shrink-0 rounded-sm object-contain ${className ?? ""}`}
      style={{ width: size, height: size }}
    />
  );
}
