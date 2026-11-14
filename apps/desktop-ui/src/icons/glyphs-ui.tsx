import type { ReactNode } from "react";

/**
 * Canonical UI vocabulary for LinkShell Desktop (`24x24` coordinate space, `[2..22]` optical area).
 * Eliminates semantic drift across panels, menus, toolbars, files, git, and system controls:
 * one canonical glyph per concept, zero external icon library sprawl.
 */
export const UI_ICON_GLYPHS = {
  /* --- Shell & Panel Navigation --- */
  "sidebar-toggle": (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2.5" />
      <path d="M9 4V20" />
    </>
  ),
  "inspector-toggle": (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2.5" />
      <path d="M15 4V20" />
    </>
  ),
  "bottom-dock": (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2.5" />
      <path d="M3 14.5H21" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="6.75" />
      <path d="M16 16L20.5 20.5" />
    </>
  ),
  command: (
    <path d="M18 3a3 3 0 0 0-3 3v12a3 3 0 0 0 3 3 3 3 0 0 0 3-3 3 3 0 0 0-3-3H6a3 3 0 0 0-3 3 3 3 0 0 0 3 3 3 3 0 0 0 3-3V6a3 3 0 0 0-3-3 3 3 0 0 0-3 3 3 3 0 0 0 3 3h12a3 3 0 0 0 3-3 3 3 0 0 0-3-3Z" />
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3.1" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.08a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.08a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" />
    </>
  ),

  /* --- Core Symbols, Chevrons & Directional Arrows --- */
  plus: <path d="M12 4.75V19.25M4.75 12H19.25" />,
  minus: <path d="M5 12H19" />,
  close: <path d="M6 6L18 18M18 6L6 18" />,
  check: <path d="M4.75 12.75L9.5 17.5L19.25 6.75" />,
  "chevron-right": <path d="M9 6L15 12L9 18" />,
  "chevron-down": <path d="M6 9L12 15L18 9" />,
  "chevron-left": <path d="M15 6L9 12L15 18" />,
  "chevron-up": <path d="M6 15L12 9L18 15" />,
  "chevrons-up-down": <path d="M8 9L12 5L16 9M8 15L12 19L16 15" />,
  "arrow-up": <path d="M12 19V5M6 11L12 5L18 11" />,
  "arrow-down": <path d="M12 5V19M6 13L12 19L18 13" />,
  "arrow-left": <path d="M19 12H5M11 6L5 12L11 18" />,
  "arrow-right": <path d="M5 12H19M13 6L19 12L13 18" />,
  "corner-down-left": <path d="M20 5V11A3 3 0 0 1 17 14H4M9 9L4 14L9 19" />,

  /* --- Transport, Playback & Window Actions --- */
  "stop-square": (
    <rect x="6.5" y="6.5" width="11" height="11" rx="2" fill="currentColor" stroke="none" />
  ),
  play: <polygon points="6.5,4.75 19.25,12 6.5,19.25" />,
  pause: <path d="M8.5 5.5V18.5M15.5 5.5V18.5" />,
  refresh: (
    <>
      <path d="M20 11A8 8 0 0 0 6.3 6.3L4 8.5" />
      <path d="M4 4.5V8.5H8" />
      <path d="M4 13A8 8 0 0 0 17.7 17.7L20 15.5" />
      <path d="M20 19.5V15.5H16" />
    </>
  ),
  "external-link": (
    <>
      <path d="M14 4H20V10M20 4L11 13" />
      <path d="M18 13.5V18.25A1.75 1.75 0 0 1 16.25 20H5.75A1.75 1.75 0 0 1 4 18.25V7.75A1.75 1.75 0 0 1 5.75 6H10.5" />
    </>
  ),
  "more-horizontal": (
    <>
      <circle cx="5.5" cy="12" r="1.25" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.25" fill="currentColor" stroke="none" />
      <circle cx="18.5" cy="12" r="1.25" fill="currentColor" stroke="none" />
    </>
  ),
  "more-vertical": (
    <>
      <circle cx="12" cy="5.5" r="1.25" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.25" fill="currentColor" stroke="none" />
      <circle cx="12" cy="18.5" r="1.25" fill="currentColor" stroke="none" />
    </>
  ),

  /* --- Computers, Devices, Network & Security --- */
  "computer-mac": (
    <>
      <path d="M4.5 6.25A1.75 1.75 0 0 1 6.25 4.5H17.75A1.75 1.75 0 0 1 19.5 6.25V15.5H4.5V6.25Z" />
      <path d="M2.5 15.5H21.5L20.25 18.25A1.5 1.5 0 0 1 18.9 19H5.1A1.5 1.5 0 0 1 3.75 18.25L2.5 15.5Z" />
    </>
  ),
  "computer-pc": (
    <>
      <rect x="3" y="4" width="18" height="12.5" rx="2" />
      <path d="M8.5 20H15.5M12 16.5V20" />
    </>
  ),
  "computer-linux": (
    <>
      <rect x="4.5" y="3.5" width="15" height="17" rx="2.25" />
      <path d="M8 7.5H16M8 11H13.5" />
      <circle cx="12" cy="16" r="1.5" />
    </>
  ),
  "phone-device": (
    <>
      <rect x="6.5" y="2.75" width="11" height="18.5" rx="2.5" />
      <path d="M10.5 18H13.5" />
    </>
  ),
  "wifi-lan": (
    <>
      <path d="M2.75 8.75a14.5 14.5 0 0 1 18.5 0" />
      <path d="M6 12.25a10 10 0 0 1 12 0" />
      <path d="M9.25 15.75a5.5 5.5 0 0 1 5.5 0" />
      <circle cx="12" cy="19" r="1.15" fill="currentColor" stroke="none" />
    </>
  ),
  globe: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M3.25 12H20.75" />
      <path d="M12 3C14.75 5.6 16.25 8.7 16.25 12C16.25 15.3 14.75 18.4 12 21C9.25 18.4 7.75 15.3 7.75 12C7.75 8.7 9.25 5.6 12 3Z" />
    </>
  ),
  lock: (
    <>
      <rect x="4.75" y="10.75" width="14.5" height="9.75" rx="2.25" />
      <path d="M8 10.75V7.5a4 4 0 0 1 8 0v3.25" />
    </>
  ),
  unlock: (
    <>
      <rect x="4.75" y="10.75" width="14.5" height="9.75" rx="2.25" />
      <path d="M8 10.75V7.25a4 4 0 0 1 7.6-1.75" />
    </>
  ),
  key: (
    <>
      <circle cx="8" cy="15" r="4.25" />
      <path d="M11.1 11.9L19.75 3.25M16.25 6.75L18.75 9.25M18.5 4.5L21 7" />
    </>
  ),
  user: (
    <>
      <circle cx="12" cy="8" r="3.75" />
      <path d="M4.75 19.75a7.25 7.25 0 0 1 14.5 0" />
    </>
  ),
  "log-out": (
    <>
      <path d="M9.5 20H5.75A1.75 1.75 0 0 1 4 18.25V5.75A1.75 1.75 0 0 1 5.75 4H9.5" />
      <path d="M15.5 16.5L20 12L15.5 7.5M20 12H9" />
    </>
  ),

  /* --- Files, Folders & Git --- */
  folder: (
    <path d="M3.25 6.5A2 2 0 0 1 5.25 4.5H9.4a1.75 1.75 0 0 1 1.35.64l1.3 1.56a1 1 0 0 0 .77.36h5.93a2 2 0 0 1 2 2V17.5a2 2 0 0 1-2 2H5.25a2 2 0 0 1-2-2V6.5Z" />
  ),
  "folder-open": (
    <>
      <path d="M3.25 18V6.5A2 2 0 0 1 5.25 4.5H9.4a1.75 1.75 0 0 1 1.35.64l1.3 1.56a1 1 0 0 0 .77.36H18.5a2 2 0 0 1 2 2V10" />
      <path d="M3.25 18L5.4 11.25A1.75 1.75 0 0 1 7.07 10H20.2a1.3 1.3 0 0 1 1.24 1.69L19.6 18a2 2 0 0 1-1.91 1.4H4.65A1.4 1.4 0 0 1 3.25 18Z" />
    </>
  ),
  "folder-plus": (
    <>
      <path d="M3.25 6.5A2 2 0 0 1 5.25 4.5H9.4a1.75 1.75 0 0 1 1.35.64l1.3 1.56a1 1 0 0 0 .77.36h5.93a2 2 0 0 1 2 2V17.5a2 2 0 0 1-2 2H5.25a2 2 0 0 1-2-2V6.5Z" />
      <path d="M12 10.5V16M9.25 13.25H14.75" />
    </>
  ),
  file: (
    <>
      <path d="M14 3.5H6.5A2 2 0 0 0 4.5 5.5V18.5A2 2 0 0 0 6.5 20.5H17.5A2 2 0 0 0 19.5 18.5V9L14 3.5Z" />
      <path d="M14 3.5V9H19.5" />
    </>
  ),
  "file-code": (
    <>
      <path d="M14 3.5H6.5A2 2 0 0 0 4.5 5.5V18.5A2 2 0 0 0 6.5 20.5H17.5A2 2 0 0 0 19.5 18.5V9L14 3.5Z" />
      <path d="M14 3.5V9H19.5" />
      <path d="M10.25 12.25L8 14.5L10.25 16.75M13.75 12.25L16 14.5L13.75 16.75" />
    </>
  ),
  "file-text": (
    <>
      <path d="M14 3.5H6.5A2 2 0 0 0 4.5 5.5V18.5A2 2 0 0 0 6.5 20.5H17.5A2 2 0 0 0 19.5 18.5V9L14 3.5Z" />
      <path d="M14 3.5V9H19.5M8.5 13H15.5M8.5 16.5H13.5" />
    </>
  ),
  "git-branch": (
    <>
      <circle cx="6.5" cy="6" r="2.25" />
      <circle cx="6.5" cy="18" r="2.25" />
      <circle cx="17.5" cy="8" r="2.25" />
      <path d="M6.5 8.25V15.75M17.5 10.25C17.5 14 13.5 14.5 6.5 14.5" />
    </>
  ),
  "git-commit": (
    <>
      <circle cx="12" cy="12" r="3.25" />
      <path d="M3 12H8.75M15.25 12H21" />
    </>
  ),
  "git-merge": (
    <>
      <circle cx="6.5" cy="6" r="2.25" />
      <circle cx="6.5" cy="18" r="2.25" />
      <circle cx="17.5" cy="15.5" r="2.25" />
      <path d="M6.5 8.25V15.75M6.5 8.25C6.5 12.5 11 15.5 15.25 15.5" />
    </>
  ),
  "git-pull-request": (
    <>
      <circle cx="6.5" cy="6" r="2.25" />
      <circle cx="6.5" cy="18" r="2.25" />
      <circle cx="17.5" cy="18" r="2.25" />
      <path d="M6.5 8.25V15.75M13 6H15.75A1.75 1.75 0 0 1 17.5 7.75V15.75M15 3.75L12.75 6L15 8.25" />
    </>
  ),

  /* --- Editing, Clipboard, Media & Lifecycle --- */
  copy: (
    <>
      <rect x="8.5" y="8.5" width="11.5" height="11.5" rx="2" />
      <path d="M5.5 15.5H5A2 2 0 0 1 3 13.5V5A2 2 0 0 1 5 3H13.5A2 2 0 0 1 15.5 5V5.5" />
    </>
  ),
  clipboard: (
    <>
      <path d="M9 4.5H6.5A2 2 0 0 0 4.5 6.5V18.5A2 2 0 0 0 6.5 20.5H17.5A2 2 0 0 0 19.5 18.5V6.5A2 2 0 0 0 17.5 4.5H15" />
      <rect x="9" y="3" width="6" height="3.5" rx="1.25" />
    </>
  ),
  edit: (
    <>
      <path d="M15.75 4.25a2.12 2.12 0 0 1 3 3L8 18L4 19L5 15L15.75 4.25Z" />
      <path d="M13.75 6.25L16.75 9.25" />
    </>
  ),
  trash: (
    <>
      <path d="M4 6.5H20M9.5 6.5V4.75A1.25 1.25 0 0 1 10.75 3.5H13.25A1.25 1.25 0 0 1 14.5 4.75V6.5" />
      <path d="M6.25 6.5L7 18.5A2 2 0 0 0 9 20.5H15A2 2 0 0 0 17 18.5L17.75 6.5" />
      <path d="M10 10.5V16.5M14 10.5V16.5" />
    </>
  ),
  archive: (
    <>
      <rect x="3" y="4" width="18" height="4.5" rx="1.25" />
      <path d="M4.75 8.5V18.25A1.75 1.75 0 0 0 6.5 20H17.5A1.75 1.75 0 0 0 19.25 18.25V8.5M10 12.5H14" />
    </>
  ),
  "archive-restore": (
    <>
      <rect x="3" y="4" width="18" height="4.5" rx="1.25" />
      <path d="M4.75 8.5V18.25A1.75 1.75 0 0 0 6.5 20H17.5A1.75 1.75 0 0 0 19.25 18.25V8.5" />
      <path d="M12 16.75V11.25M9.5 13.75L12 11.25L14.5 13.75" />
    </>
  ),
  download: (
    <>
      <path d="M12 4V15.25M7.5 11L12 15.5L16.5 11" />
      <path d="M4.5 17.25V18.5A1.5 1.5 0 0 0 6 20H18A1.5 1.5 0 0 0 19.5 18.5V17.25" />
    </>
  ),
  upload: (
    <>
      <path d="M12 15.5V4.25M7.5 8.5L12 4L16.5 8.5" />
      <path d="M4.5 17.25V18.5A1.5 1.5 0 0 0 6 20H18A1.5 1.5 0 0 0 19.5 18.5V17.25" />
    </>
  ),
  paperclip: (
    <path d="M18.5 11.25L10.75 19a5 5 0 0 1-7.07-7.07l8.25-8.25a3.25 3.25 0 0 1 4.6 4.6l-8.25 8.25a1.5 1.5 0 0 1-2.12-2.12l7.5-7.5" />
  ),
  image: (
    <>
      <rect x="3.5" y="4" width="17" height="16" rx="2.5" />
      <circle cx="8.75" cy="9.25" r="1.5" />
      <path d="M20.5 15.5L15.75 11L6.5 20" />
    </>
  ),
  eye: (
    <>
      <path d="M2.5 12S6 5.5 12 5.5S21.5 12 21.5 12S18 18.5 12 18.5S2.5 12 2.5 12Z" />
      <circle cx="12" cy="12" r="2.75" />
    </>
  ),
  "eye-off": (
    <>
      <path d="M9.9 5.75A9.8 9.8 0 0 1 12 5.5C18 5.5 21.5 12 21.5 12a16.8 16.8 0 0 1-3.1 4.15M6.35 6.45C3.95 8.1 2.5 12 2.5 12S6 18.5 12 18.5a9.9 9.9 0 0 0 5.55-1.65" />
      <path d="M10.1 10.1a2.75 2.75 0 0 0 3.8 3.8M3.5 3.5L20.5 20.5" />
    </>
  ),
  maximize: <path d="M8 3.75H3.75V8M16 3.75H20.25V8M20.25 16V20.25H16M3.75 16V20.25H8" />,
  minimize: <path d="M8.5 3.75V8.5H3.75M15.5 3.75V8.5H20.25M15.5 20.25V15.5H20.25M8.5 20.25V15.5H3.75" />,
  sliders: (
    <>
      <path d="M4 6.5H10M14 6.5H20M4 12H14M18 12H20M4 17.5H7M11 17.5H20" />
      <circle cx="12" cy="6.5" r="2" />
      <circle cx="16" cy="12" r="2" />
      <circle cx="9" cy="17.5" r="2" />
    </>
  ),

  /* --- Status, Feedback, Workbench & Agent Helpers --- */
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11V16" />
      <circle cx="12" cy="7.75" r="0.9" fill="currentColor" stroke="none" />
    </>
  ),
  "alert-triangle": (
    <>
      <path d="M10.3 4.25L2.9 17.25A2 2 0 0 0 4.64 20.25H19.36A2 2 0 0 0 21.1 17.25L13.7 4.25a2 2 0 0 0-3.4 0Z" />
      <path d="M12 9.25V13.5" />
      <circle cx="12" cy="16.75" r="0.95" fill="currentColor" stroke="none" />
    </>
  ),
  "alert-circle": (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7.75V12.5" />
      <circle cx="12" cy="15.85" r="0.95" fill="currentColor" stroke="none" />
    </>
  ),
  "check-circle": (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M8.5 12.25L10.9 14.65L15.75 9.5" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7.25V12L15.25 13.75" />
    </>
  ),
  sparkles: (
    <>
      <path d="M11 3.5L12.7 8.3L17.5 10L12.7 11.7L11 16.5L9.3 11.7L4.5 10L9.3 8.3L11 3.5Z" />
      <path d="M18.5 14.5V19.5M16 17H21" />
    </>
  ),
  code: <path d="M8.5 7.5L4 12L8.5 16.5M15.5 7.5L20 12L15.5 16.5M13.5 5.5L10.5 18.5" />,
  "list-checks": (
    <>
      <path d="M4 7L5.75 8.75L8.75 5.5M4 14L5.75 15.75L8.75 12.5" />
      <path d="M11.5 7H20M11.5 14H20M11.5 19H20" />
    </>
  ),
  puzzle: (
    <path d="M13.5 4.5a2 2 0 1 0-3 2.1V7H6.5A2 2 0 0 0 4.5 9v3.5h.4a2 2 0 1 1 0 3H4.5V19a1.5 1.5 0 0 0 1.5 1.5h3.5v-.4a2 2 0 1 1 3 0v.4H16a1.5 1.5 0 0 0 1.5-1.5v-3.5h.4a2 2 0 1 0 0-3h-.4V9A2 2 0 0 0 15.5 7H13.5v-.4Z" />
  ),
  "split-columns": (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2.5" />
      <path d="M12 4V20M6 9H9M15 9H18M6 13H9M15 13H18" />
    </>
  ),
  "unified-diff": (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2.5" />
      <path d="M7 9H17M7 12.5H17M7 16H13.5" />
    </>
  ),
  "send-to-agent": (
    <>
      <path d="M3.75 11.25L20 4L13.25 20.25L10.75 13.25L3.75 11.25Z" />
      <path d="M10.75 13.25L20 4" />
    </>
  ),
  pin: (
    <>
      <path d="M9 4H15L14 9.5L17.5 12.5V14.5H6.5V12.5L10 9.5L9 4Z" />
      <path d="M12 14.5V20.5" />
    </>
  ),
  filter: <polygon points="3.5,5 20.5,5 14,12.5 14,19 10,20.5 10,12.5" />,

  /* --- Companion System & Telemetry Icons --- */
  spinner: <path d="M12 3.25a8.75 8.75 0 1 1-6.19 2.56" />,
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2.75V5M12 19V21.25M2.75 12H5M19 12H21.25M5.46 5.46L7.05 7.05M16.95 16.95L18.54 18.54M18.54 5.46L16.95 7.05M7.05 16.95L5.46 18.54" />
    </>
  ),
  moon: <path d="M19.5 14.5A7.75 7.75 0 0 1 9.5 4.5a7.75 7.75 0 1 0 10 10Z" />,
  mic: (
    <>
      <rect x="9" y="3.25" width="6" height="10.5" rx="3" />
      <path d="M5.75 11a6.25 6.25 0 0 0 12.5 0M12 17.25V20.5M8.75 20.5H15.25" />
    </>
  ),
  link: (
    <>
      <path d="M10 13a4.5 4.5 0 0 0 6.36 0l2.83-2.83a4.5 4.5 0 0 0-6.36-6.36L11.2 5.44" />
      <path d="M14 11a4.5 4.5 0 0 0-6.36 0L4.8 13.83a4.5 4.5 0 0 0 6.36 6.36l1.63-1.63" />
    </>
  ),
  unlink: (
    <>
      <path d="M18.8 10.2l.39-.39a4.5 4.5 0 0 0-6.36-6.36l-.39.39M5.2 13.8l-.39.39a4.5 4.5 0 0 0 6.36 6.36l.39-.39" />
      <path d="M4 4L20 20" />
    </>
  ),
  cpu: (
    <>
      <rect x="6" y="6" width="12" height="12" rx="2" />
      <rect x="9.5" y="9.5" width="5" height="5" rx="0.75" />
      <path d="M9.5 3V6M14.5 3V6M9.5 18V21M14.5 18V21M3 9.5H6M3 14.5H6M18 9.5H21M18 14.5H21" />
    </>
  ),
  activity: <path d="M3 12H6.75L9.5 5L14.5 19L17.25 12H21" />,
  "help-circle": (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M9.5 9.25a2.5 2.5 0 0 1 4.85.85c0 1.65-2.35 2.2-2.35 3.4" />
      <circle cx="12" cy="16.75" r="0.9" fill="currentColor" stroke="none" />
    </>
  ),
  shield: (
    <path d="M12 3L19.5 6.25V11.75C19.5 16.4 16.3 19.9 12 21.25C7.7 19.9 4.5 16.4 4.5 11.75V6.25L12 3Z" />
  ),
} satisfies Record<string, ReactNode>;

export type UiIconName = keyof typeof UI_ICON_GLYPHS;
