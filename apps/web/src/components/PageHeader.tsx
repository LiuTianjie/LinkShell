import { useEffect, useRef, useState, type ReactNode } from "react";
import { isDesktop } from "../live/desktop";

/**
 * A page's title row. On the desktop it is the page's toolbar, as in Codex: one 46 px row with
 * the title and the page's actions, pinned while the page scrolls under it, a hairline only once
 * something is under it, and room for the window's traffic lights when the sidebar is hidden.
 * Elsewhere it is the page's heading. `detail` is a short fact (a count, a computer), never a
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
  const ref = useRef<HTMLElement>(null);
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const header = ref.current;
    if (!isDesktop || !header) return;
    // The nearest scroller decides when the row needs its rule.
    let scroller: HTMLElement | null = header.parentElement;
    while (scroller && !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement;
    if (!scroller) return;
    const target = scroller;
    const update = () => setScrolled(target.scrollTop > 0);
    update();
    target.addEventListener("scroll", update, { passive: true });
    return () => target.removeEventListener("scroll", update);
  }, []);
  return (
    <header ref={ref} className={["page-header", className].filter(Boolean).join(" ")} data-scrolled={scrolled || undefined}>
      {leading}
      <div className="page-header-copy">
        <h1>{title}</h1>
        {detail && <span className="page-header-detail">{detail}</span>}
      </div>
      {actions && <div className="page-header-actions">{actions}</div>}
    </header>
  );
}
