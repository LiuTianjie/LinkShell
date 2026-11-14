import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { DesktopIcon, type DesktopIconName } from "../icons";
import { Popover, PopoverContent, PopoverTrigger, type PopoverPlacement } from "./Popover";
import { Tooltip } from "./Tooltip";
import { cn, isImeComposing } from "./utils";
import { usePrimitiveLabels } from "./labels";

export interface ComboboxOption {
  value: string;
  label: string;
  description?: string;
  keywords?: string[];
  group?: string;
  badge?: ReactNode;
  icon?: DesktopIconName | ReactNode;
  disabled?: boolean;
}

export interface ComboboxProps {
  value: string;
  onValueChange: (value: string) => void;
  options: ComboboxOption[];
  placeholder?: string;
  searchPlaceholder?: string;
  emptyText?: string;
  ariaLabel?: string;
  size?: "sm" | "md" | "chip";
  placement?: PopoverPlacement;
  leadingIcon?: DesktopIconName | ReactNode;
  disabled?: boolean;
  disabledReason?: ReactNode;
  className?: string;
  popoverClassName?: string;
}

function renderComboboxIcon(icon?: DesktopIconName | ReactNode): ReactNode {
  if (!icon) return null;
  if (typeof icon === "string") {
    return <DesktopIcon name={icon as DesktopIconName} size="sm" />;
  }
  return icon;
}

export function Combobox({
  value,
  onValueChange,
  options,
  placeholder: placeholderProp,
  searchPlaceholder: searchPlaceholderProp,
  emptyText: emptyTextProp,
  ariaLabel,
  size = "md",
  placement = "bottom-start",
  leadingIcon,
  disabled = false,
  disabledReason,
  className,
  popoverClassName,
}: ComboboxProps) {
  const labels = usePrimitiveLabels();
  const placeholder = placeholderProp ?? labels.select;
  const searchPlaceholder = searchPlaceholderProp ?? labels.filter;
  const emptyText = emptyTextProp ?? labels.noMatches;
  const listboxId = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  const selected = useMemo(
    () => options.find((opt) => opt.value === value),
    [options, value],
  );

  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return options;
    return options.filter((opt) => {
      if (opt.label.toLowerCase().includes(normalized)) return true;
      if (opt.value.toLowerCase().includes(normalized)) return true;
      if (opt.description?.toLowerCase().includes(normalized)) return true;
      return opt.keywords?.some((kw) => kw.toLowerCase().includes(normalized)) ?? false;
    });
  }, [options, query]);

  useEffect(() => {
    if (!open) {
      setQuery("");
      return;
    }
    const idx = filtered.findIndex((item) => item.value === value && !item.disabled);
    setActiveIndex(idx >= 0 ? idx : Math.max(0, filtered.findIndex((item) => !item.disabled)));
    queueMicrotask(() => {
      searchInputRef.current?.focus({ preventScroll: true });
    });
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!open) return;
    const firstEnabled = filtered.findIndex((item) => !item.disabled);
    setActiveIndex(firstEnabled >= 0 ? firstEnabled : 0);
  }, [query, open, filtered]);

  const commitOption = (opt: ComboboxOption | undefined) => {
    if (!opt || opt.disabled) return;
    onValueChange(opt.value);
    setOpen(false);
  };

  const stepActive = (delta: 1 | -1) => {
    if (filtered.length === 0) return;
    let next = activeIndex;
    for (let i = 0; i < filtered.length; i += 1) {
      next = (next + delta + filtered.length) % filtered.length;
      if (!filtered[next]?.disabled) {
        setActiveIndex(next);
        const optionEl = listRef.current?.querySelector<HTMLElement>(
          `[data-option-index="${next}"]`,
        );
        if (typeof optionEl?.scrollIntoView === "function") {
          optionEl.scrollIntoView({ block: "nearest" });
        }
        return;
      }
    }
  };

  const triggerButton = (
    <button
      type="button"
      disabled={disabled}
      aria-label={ariaLabel}
      aria-haspopup="listbox"
      data-size={size}
      className={cn("ls-combobox-trigger", className)}
    >
      {leadingIcon || selected?.icon ? (
        <span className="ls-combobox-trigger__icon" aria-hidden="true">
          {renderComboboxIcon(leadingIcon ?? selected?.icon)}
        </span>
      ) : null}
      <span
        className="ls-combobox-trigger__label"
        data-placeholder={!selected ? "true" : undefined}
      >
        {selected ? selected.label : placeholder}
      </span>
      <span className="ls-combobox-trigger__caret" aria-hidden="true">
        <DesktopIcon name="chevrons-up-down" size="xs" />
      </span>
    </button>
  );

  if (disabled) {
    return disabledReason ? (
      <Tooltip content={disabledReason} wrapDisabled>
        {triggerButton}
      </Tooltip>
    ) : (
      triggerButton
    );
  }

  const activeOption = filtered[activeIndex];
  const activeOptionDomId = activeOption
    ? `${listboxId}-opt-${activeIndex}`
    : undefined;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger>{triggerButton}</PopoverTrigger>
      <PopoverContent
        placement={placement}
        className={cn("ls-combobox-popover", popoverClassName)}
      >
        {open ? (
          <>
            <div className="ls-combobox__search-row">
              <span className="ls-combobox__search-icon" aria-hidden="true">
                <DesktopIcon name="search" size="sm" />
              </span>
              <input
                ref={searchInputRef}
                type="search"
                role="combobox"
                aria-expanded={open}
                aria-controls={listboxId}
                aria-activedescendant={activeOptionDomId}
                aria-autocomplete="list"
                value={query}
                placeholder={searchPlaceholder}
                className="ls-combobox__input"
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  // MWG `ime-safe-enter-submit`: never hijack Enter / arrows during CJK IME composition!
                  if (isImeComposing(event)) return;
                  if (event.key === "ArrowDown") {
                    event.preventDefault();
                    stepActive(1);
                  } else if (event.key === "ArrowUp") {
                    event.preventDefault();
                    stepActive(-1);
                  } else if (event.key === "Enter") {
                    event.preventDefault();
                    commitOption(filtered[activeIndex]);
                  } else if (event.key === "Escape") {
                    event.preventDefault();
                    setOpen(false);
                  }
                }}
              />
            </div>

            <div
              ref={listRef}
              id={listboxId}
              role="listbox"
              className="ls-combobox__list"
            >
              {filtered.length === 0 ? (
                <div className="ls-combobox__empty">{emptyText}</div>
              ) : (
                filtered.map((opt, index) => {
                  const isSelected = opt.value === value;
                  const isActive = index === activeIndex;
                  const prevGroup = index > 0 ? filtered[index - 1]?.group : undefined;
                  const showGroup = Boolean(opt.group && opt.group !== prevGroup);

                  return (
                    <div key={opt.value} role="presentation">
                      {showGroup ? (
                        <div className="ls-combobox__group-label" role="presentation">
                          {opt.group}
                        </div>
                      ) : null}
                      <div
                        id={`${listboxId}-opt-${index}`}
                        role="option"
                        aria-selected={isSelected}
                        aria-disabled={opt.disabled || undefined}
                        data-option-index={index}
                        data-active={isActive ? "true" : undefined}
                        data-selected={isSelected ? "true" : undefined}
                        className="ls-combobox__option"
                        onPointerMove={() => {
                          if (!opt.disabled && activeIndex !== index) {
                            setActiveIndex(index);
                          }
                        }}
                        onClick={() => commitOption(opt)}
                      >
                        <span className="ls-combobox__check" aria-hidden="true">
                          {isSelected ? <DesktopIcon name="check" size="xs" /> : null}
                        </span>
                        {opt.icon ? (
                          <span className="ls-combobox__option-icon" aria-hidden="true">
                            {renderComboboxIcon(opt.icon)}
                          </span>
                        ) : null}
                        <span className="ls-combobox__option-body">
                          <span className="ls-combobox__option-label">{opt.label}</span>
                          {opt.description ? (
                            <span className="ls-combobox__option-desc">
                              {opt.description}
                            </span>
                          ) : null}
                        </span>
                        {opt.badge ? (
                          <span className="ls-combobox__option-badge">{opt.badge}</span>
                        ) : null}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
