import { cn } from "@/lib/utils";

function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      // Its tint and sweep come from common.css, so a utility background here would hide the sweep.
      className={cn("rounded-md", className)}
      {...props}
    />
  );
}

export { Skeleton };
