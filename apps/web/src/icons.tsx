import type { LucideProps } from "lucide-react";
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
  LockKeyhole,
  LockKeyholeOpen,
  Box,
  Gauge,
  ListTodo,
  Command,
  CircleHelp,
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
  Bot,
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
  shield: LockKeyhole,
  unlocked: LockKeyholeOpen,
  model: Box,
  effort: Gauge,
  plan: ListTodo,
  commands: Command,
  question: CircleHelp,
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
  steward: Bot,
} as const;
export type IconName = keyof typeof icons;
export function Icon({
  name,
  size = 18,
  ...props
}: Omit<LucideProps, "name"> & {
  name: IconName;
  "data-icon"?: string;
}) {
  const Component = icons[name];
  return (
    <Component
      size={size}
      strokeWidth={1.75}
      aria-hidden="true"
      {...props}
    />
  );
}
