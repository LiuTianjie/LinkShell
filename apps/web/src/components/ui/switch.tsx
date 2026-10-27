import * as React from "react";
import { cn } from "@/lib/utils";
import { Switch as SwitchPrimitive } from "radix-ui";

// The thumb takes the colour that contrasts with its track in both schemes: the primary is
// ink (dark on light, light on dark), so on it the thumb is the primary's foreground.
function Switch({
  className,
  ...props
}: React.ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        "peer inline-flex h-[18px] w-8 shrink-0 items-center rounded-full border border-transparent bg-[var(--quaternaryLabel)] transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-primary",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className="pointer-events-none block size-3.5 rounded-full bg-[var(--plain)] ring-0 transition-transform data-[state=checked]:translate-x-[15px] data-[state=checked]:bg-primary-foreground data-[state=unchecked]:translate-x-px"
      />
    </SwitchPrimitive.Root>
  );
}

export { Switch };
