# Computer illustrations

Generated with the built-in imagegen tool. Resized to 192 × 192 transparent PNGs for small UI thumbnails; these original thumbnails depict form factors, not individual SKUs. A computer name is never a hardware signal.

## laptop.png

Use case: product-mockup. A production UI asset for a mobile computer selector. One isolated computer, front view slightly elevated, centered, fills 85% of a square canvas. Refined realistic miniature product rendering, silver aluminum, soft studio lighting from upper left, clearly readable silhouette at 64px. Transparent background with genuine alpha. No floor, no backdrop, no circle, no text, no logo, no watermark, no separate accessories. Subject: open slim silver laptop, dark bezel, subtle muted midnight blue screen, keyboard visible, nearly straight-on symmetric view.

## mini.png

Use case: product-mockup. A production UI asset for a mobile computer selector. One isolated computer, front view slightly elevated, centered, fills 85% of a square canvas. Refined realistic miniature product rendering, silver aluminum, soft studio lighting from upper left, clearly readable silhouette at 64px. Transparent background with genuine alpha. No floor, no backdrop, no circle, no text, no logo, no watermark, no separate accessories. Subject: compact silver desktop mini computer, low rounded-square enclosure, two small front USB-C ports, slightly elevated view showing top and front, no screen.

## computer.png

Use case: product-mockup. A production UI asset for a mobile computer selector. One isolated computer, front view slightly elevated, centered, fills 85% of a square canvas. Refined realistic miniature product rendering, silver aluminum, soft studio lighting from upper left, clearly readable silhouette at 64px. Transparent background with genuine alpha. No floor, no backdrop, no circle, no text, no logo, no watermark, no separate accessories. Subject: standalone modern silver desktop monitor on short silver stand, muted midnight blue screen, dark thin bezel, nearly straight-on symmetric view.

## Host workspace artwork

`notebook.webp`, `air.webp`, `mini.webp`, `studio.webp`, `tower.webp`, and `generic.webp` are transparent, tightly cropped product renders for the mobile computer workspace:

- `notebook.webp`: Pro laptop fallback (e.g. `MacBook Pro`, `MacBook`, or generic `notebook` form factor).
- `air.webp`: Ultra-slim laptop fallback (`MacBook Air`).
- `mini.webp`: Compact desktop mini (`Mac mini` / `mac-mini` form factor).
- `studio.webp`: Tall silver workstation cube (`Mac Studio`).
- `tower.webp`: Generic Windows PC display and tower (`win32` with `tower` or `desktop` form factor).
- `computer.png`: Reported `all-in-one` desktop display.
- `generic.webp`: Refined neutral standalone display for hosts whose enclosure is unknown (older hosts before hardware reporting, offline unvisited computers, locked computers, or generic Linux/Mac Pro desktops before `machine.artwork` loads). A computer name or OS alone never implies a specific Apple model.

On a capable Mac the preferred art is AppKit’s `NSImageNameComputer` for that very Mac. Its Host trims the transparent margins and serves a size-limited WebP through authenticated `machine.artwork` on demand. The image hash, not a nickname or asset URL, is cached. No Apple system artwork is bundled or requested from a public image service. Photorealistic product renders above serve as fallbacks for older hosts and headless/non-Apple systems.
