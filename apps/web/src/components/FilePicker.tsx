import { useRef, type ComponentProps, type ReactNode } from "react";
import { Upload } from "lucide-react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

export function FilePicker({
  children,
  title,
  "aria-label": ariaLabel,
  "aria-describedby": describedBy,
  buttonProps,
  ...props
}: Omit<ComponentProps<typeof Input>, "type" | "hidden" | "ref"> & {
  children: ReactNode;
  buttonProps?: Omit<
    ComponentProps<typeof Button>,
    "children" | "onClick" | "disabled" | "type"
  >;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <Button
        variant="outline"
        {...buttonProps}
        type="button"
        title={title}
        aria-label={ariaLabel}
        aria-describedby={describedBy}
        disabled={props.disabled}
        onClick={() => {
          if (!input.current) return;
          // Selecting the same file again must still trigger a failed upload's retry.
          input.current.value = "";
          input.current.click();
        }}
      >
        <Upload data-icon="inline-start" />
        {children}
      </Button>
      <Input
        {...props}
        type="file"
        hidden
        tabIndex={-1}
        className="hidden"
        ref={input}
      />
    </>
  );
}
