import type { CSSProperties } from "react";

const paths = {
  grid: "M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z",
  plus: "M12 5v14 M5 12h14",
  search: "M10.5 18a7.5 7.5 0 1 1 0-15 7.5 7.5 0 0 1 0 15 M16 16l5 5",
  computer: "M3 4h18v13H3z M8 21h8 M12 17v4",
  chevron: "m9 5 7 7-7 7",
  down: "m6 9 6 6 6-6",
  arrow: "M5 12h14 m-6-6 6 6-6 6",
  folder: "M3 7V4h6l3 3h9v13H3z",
  clock: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20 M12 6v6l4 2",
  check: "m5 12 4 4L19 6",
  close: "m6 6 12 12 M6 18 18 6",
  settings: "M4 7h16 M4 17h16 M8 4v6 M16 14v6",
  shield: "m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6z m-4 9 3 3 5-6",
  terminal: "m4 5 7 7-7 7 M13 19h7",
  file: "M14 2H4v20h16V8z M14 2v6h6 M8 13h8 M8 17h6",
  branch:
    "M6 3v12a4 4 0 0 0 4 4h3 M6 7h8a4 4 0 0 0 4-4 M3 18h6v4H3z M15 1h6v4h-6z",
  panel: "M3 4h18v16H3z M15 4v16",
  send: "M12 20V4 m-7 7 7-7 7 7",
  attach: "m8 12 6-6a3 3 0 0 1 4 4l-8 8a5 5 0 0 1-7-7l9-9 M6 14l8-8",
  stop: "M6 6h12v12H6z",
  globe:
    "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20 M2 12h20 M12 2c-6 6-6 14 0 20 M12 2c6 6 6 14 0 20",
  server: "M3 3h18v7H3z M3 14h18v7H3z M7 6v1 M7 17v1 M12 6h5 M12 17h5",
  logout: "M10 3H4v18h6 M10 12h12 m-5-5 5 5-5 5",
  menu: "M4 6h16 M4 12h16 M4 18h16",
  moon: "M20 15A9 9 0 0 1 9 4a9 9 0 1 0 11 11",
} as const;
export type IconName = keyof typeof paths;
export function Icon({
  name,
  size = 18,
  style,
}: {
  name: IconName;
  size?: number;
  style?: CSSProperties;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={style}
    >
      <path d={paths[name]} />
    </svg>
  );
}
