import type { CSSProperties } from "react";
import {
  LayoutGrid,
  Plus,
  Search,
  Monitor,
  ChevronRight,
  ChevronDown,
  ArrowRight,
  Folder,
  Clock,
  Check,
  X,
  Settings2,
  ShieldCheck,
  Terminal,
  FileText,
  GitBranch,
  PanelRight,
  ArrowUp,
  Paperclip,
  Square,
  Globe,
  Server,
  LogOut,
  Menu,
  Moon,
} from "lucide-react";

const icons = {
  grid: LayoutGrid,
  plus: Plus,
  search: Search,
  computer: Monitor,
  chevron: ChevronRight,
  down: ChevronDown,
  arrow: ArrowRight,
  folder: Folder,
  clock: Clock,
  check: Check,
  close: X,
  settings: Settings2,
  shield: ShieldCheck,
  terminal: Terminal,
  file: FileText,
  branch: GitBranch,
  panel: PanelRight,
  send: ArrowUp,
  attach: Paperclip,
  stop: Square,
  globe: Globe,
  server: Server,
  logout: LogOut,
  menu: Menu,
  moon: Moon,
} as const;
export type IconName = keyof typeof icons;
export function Icon({
  name,
  size = 18,
  style,
  ...props
}: {
  name: IconName;
  size?: number;
  style?: CSSProperties;
  "data-icon"?: string;
}) {
  const Component = icons[name];
  return (
    <Component
      size={size}
      strokeWidth={1.65}
      aria-hidden="true"
      style={style}
      {...props}
    />
  );
}
