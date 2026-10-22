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
  "relative grid w-full items-start gap-x-2.5 gap-y-0.5 rounded-lg border border-l-2 py-2.5 pr-3 pl-3 text-left has-[>svg]:grid-cols-[auto_1fr] [&>svg]:row-span-2 [&>svg]:size-4 [&>svg]:translate-y-px",
  {
    variants: {
      variant: {
        default:
          "border-border border-l-border bg-card text-card-foreground [&>svg]:text-muted-foreground",
        info: "border-[color-mix(in_srgb,var(--info)_22%,transparent)] border-l-info bg-[color-mix(in_srgb,var(--info)_6%,transparent)] text-foreground [&>svg]:text-info",
        warning:
          "border-[color-mix(in_srgb,var(--warning)_26%,transparent)] border-l-warning bg-[color-mix(in_srgb,var(--warning)_7%,transparent)] text-foreground [&>svg]:text-warning",
        destructive:
          "border-[color-mix(in_srgb,var(--danger)_24%,transparent)] border-l-destructive bg-[color-mix(in_srgb,var(--danger)_7%,transparent)] text-foreground [&>svg]:text-destructive",
        success:
          "border-[color-mix(in_srgb,var(--success)_24%,transparent)] border-l-success bg-[color-mix(in_srgb,var(--success)_6%,transparent)] text-foreground [&>svg]:text-success",
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
