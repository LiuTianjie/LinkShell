import type { SessionConfigOption } from "@linkshell/wire";
import { ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { SessionConfigIcon, sessionConfigLabel, valueDescription, valueName } from "./ComposerControls";

export function creationOptionLabel(option: SessionConfigOption): string {
  return sessionConfigLabel(option);
}

/** Pre-session choices use the same agent-provided values as the conversation settings. */
export function NewSessionConfig({ options, disabled, onChange }: { options: SessionConfigOption[]; disabled: boolean; onChange: (id: string, value: string) => void }) {
  return [...options].sort((a, b) => Number(b.category === "effort") - Number(a.category === "effort")).map((option) => {
    const label = creationOptionLabel(option);
    const current = option.values.find((entry) => entry.value === option.current);
    return (
      <DropdownMenu key={option.id}>
        <DropdownMenuTrigger asChild>
          <Button type="button" variant="toolbar" size="sm" className="new-session-pill" data-risky={option.category === "mode" && /bypass|full|yolo|never/i.test(option.current) ? "" : undefined} disabled={disabled} aria-label={`选择${label}`} title={`${label}：${valueName(current?.name ?? option.current)}`}>
            <SessionConfigIcon category={option.category} value={option.current} />
            <span>{valueName(current?.name ?? option.current)}</span>
            <ChevronDown data-icon="inline-end" className="new-session-caret" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" align="start" sideOffset={8} collisionPadding={12} className="new-session-menu">
          <DropdownMenuLabel>{label}</DropdownMenuLabel>
          <DropdownMenuRadioGroup value={option.current} onValueChange={(value) => onChange(option.id, value)}>
            {option.values.map((entry) => (
              <DropdownMenuRadioItem key={entry.value} value={entry.value}>
                <span className="new-session-option">
                  <span>{valueName(entry.name)}</span>
                  {entry.description && <small>{valueDescription(entry.description)}</small>}
                </span>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    );
  });
}
