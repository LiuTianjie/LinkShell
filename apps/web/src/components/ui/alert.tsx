import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import {
  Info,
  TriangleAlert,
  CircleX,
  CircleCheck,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";

// A restrained, Linear-grade alert: a soft semantic tint, a tinted left rail,
// one matching icon, and a clear title/description hierarchy. Colours come
// only from semantic tokens (--info / --warning / --danger / --success), mixed
// softly with color-mix so nothing reads as a harsh block.
const alertVariants = cva(
  "relative grid w-full items-start gap-x-2.5 gap-y-0.5 rounded-lg border py-2.5 pr-3 pl-3 text-left has-[>svg]:grid-cols-[auto_1fr] [&>svg]:row-span-2 [&>svg]:size-4 [&>svg]:translate-y-px",
  {
    variants: {
      variant: {
        default:
          "border-border bg-card text-card-foreground [&>svg]:text-muted-foreground",
        info: "border-transparent bg-[var(--accentSoft)] text-foreground [&>svg]:text-info",
        warning:
          "border-transparent bg-[var(--waitingSoft)] text-foreground [&>svg]:text-warning",
        destructive:
          "border-transparent bg-[var(--dangerSoft)] text-foreground [&>svg]:text-destructive",
        success:
          "border-transparent bg-[var(--okSoft)] text-foreground [&>svg]:text-success",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

const variantIcon: Record<string, LucideIcon> = {
  default: Info,
  info: Info,
  warning: TriangleAlert,
  destructive: CircleX,
  success: CircleCheck,
};

function Alert({
  className,
  variant,
  icon = true,
  children,
  ...props
}: React.ComponentProps<"div"> &
  VariantProps<typeof alertVariants> & { icon?: boolean }) {
  const Icon = variantIcon[variant ?? "default"] ?? Info;
  return (
    <div
      data-slot="alert"
      data-variant={variant ?? "default"}
      role="alert"
      className={cn(alertVariants({ variant }), className)}
      {...props}
    >
      {icon ? <Icon aria-hidden /> : null}
      {children}
    </div>
  );
}

function AlertTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-title"
      className={cn(
        "col-start-2 text-[13px] leading-5 font-semibold tracking-[-0.003em] [&_a]:underline [&_a]:underline-offset-2",
        className,
      )}
      {...props}
    />
  );
}

function AlertDescription({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-description"
      className={cn(
        "col-start-2 text-[13px] leading-[1.55] text-muted-foreground [&_a]:underline [&_a]:underline-offset-2",
        className,
      )}
      {...props}
    />
  );
}

export { Alert, AlertTitle, AlertDescription };
