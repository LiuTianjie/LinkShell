import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
export function Choice({
  value,
  onValueChange,
  options,
  label,
  placeholder = "请选择",
  disabled,
  id,
}: {
  value: string;
  onValueChange: (value: string) => void;
  options: { value: string; label: string; disabled?: boolean }[];
  label: string;
  placeholder?: string;
  disabled?: boolean;
  id?: string;
}) {
  return (
    <Select
      // Radix reserves the empty string for the placeholder; host options may use it.
      value={
        options.some((option) => option.value === value) ? `item:${value}` : ""
      }
      onValueChange={(value) => onValueChange(value.slice(5))}
      disabled={disabled || !options.length}
    >
      <SelectTrigger id={id} aria-label={label} className="w-full min-w-0">
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent
        position="popper"
        align="start"
        className="max-w-[calc(100vw-2rem)]"
      >
        <SelectGroup>
          {options.map((option) => (
            <SelectItem
              key={option.value}
              value={`item:${option.value}`}
              disabled={option.disabled}
            >
              {option.label}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}
