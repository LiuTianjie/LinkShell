import { copyFileSync } from "node:fs";
copyFileSync(new URL("../src/terminal-state.wasm.gz", import.meta.url), new URL("../dist/host/src/terminal-state.wasm.gz", import.meta.url));
