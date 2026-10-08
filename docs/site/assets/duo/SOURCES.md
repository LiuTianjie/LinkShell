# iPhone Duo viewer assets

Retrieved 2026-10-08 from Apple's public iPhone Duo product page:
https://www.apple.com/iphone-duo/

- Scene, model, materials, and textures: `https://www.apple.com/v/iphone-duo/d/static/`; original paths, byte sizes, and SHA-256 digests are in `apple-sources.json`.
- Graphics runtime: `https://www.apple.com/v/iphone-duo/d/built/scripts/vendors~lotus-lib.built.js`.
- Model scripts: `https://www.apple.com/v/iphone-duo/d/built/scripts/overview/main.built.js`.
- `graphics.js` retains 32 dependency modules needed by Lotus, DetailChunk, Wipe, AnimationScrubber, CameraMixerOffset, FadeThroughBlack, Hinge, and StencilMasking. The webpack bootstrap is replaced by a local module loader; Apple page, shopping, and analytics entrypoints are not included. Embedded third-party notices are retained.

Apple model and runtime assets remain third-party material, outside LinkShell's MIT license. The asset provenance is recorded here rather than treating these as LinkShell-authored graphics.

`viewer.js` and `viewer.css` integrate the viewer with LinkShell's bilingual static site. They replace wallpaper rendering with native LinkShell screenshots, retain hinge movement and blur, center the camera in a compact stage, and load only as the section approaches the viewport (explicit opt-in with reduced motion).

`closed.png`, `portrait.png`, `laptop.png`, and `standing.png` were exported from the running LinkShell Dev app in the iPhone Duo simulator, in dark mode. `../promo/iphone-duo-expanded-dark.png` is the existing expanded-screen capture. Inner portrait captures and the outer landscape capture are rotated into their respective display UV coordinates at runtime; the screenshot files are unchanged. These textures demonstrate captured app layouts, not a live app session inside the website.
