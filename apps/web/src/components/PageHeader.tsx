import { type ReactNode } from "react";

/**
 * A page's heading. `detail` is a short fact (a count, a computer), never a
 * sentence of explanation: that belongs in the page.
 */
export function PageHeader({
  title,
  detail,
  actions,
  leading,
  className,
}: {
  title: ReactNode;
  detail?: ReactNode;
  actions?: ReactNode;
  leading?: ReactNode;
  className?: string;
}) {
  return (
    <header className={["page-header", className].filter(Boolean).join(" ")}>
      {leading}
      <div className="page-header-copy">
        <h1>{title}</h1>
        {detail && <span className="page-header-detail">{detail}</span>}
      </div>
      {actions && <div className="page-header-actions">{actions}</div>}
    </header>
  );
}
