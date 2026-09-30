import { unwrapShellCommand } from "@linkshell/wire";
import { describe, expect, it } from "vitest";

describe("unwrapShellCommand", () => {
  it("unwraps simple and concatenated quoting", () => {
    expect(unwrapShellCommand("/bin/zsh -lc 'npm test'")).toBe("npm test");
    expect(unwrapShellCommand("bash -c \"echo \\\"hi\\\"\"")).toBe('echo "hi"');
    // Codex splices quotes: 'sed -n '"'1,9p' a.sh"  →  sed -n '1,9p' a.sh
    expect(unwrapShellCommand("/bin/zsh -lc 'sed -n '\"'1,9p' a.sh\"")).toBe("sed -n '1,9p' a.sh");
    expect(unwrapShellCommand("/bin/zsh -lc 'it'\"'\"'s'")).toBe("it's");
  });

  it("leaves anything else alone", () => {
    expect(unwrapShellCommand("npm test")).toBe("npm test");
    expect(unwrapShellCommand("/bin/zsh -lc 'unterminated")).toBe("/bin/zsh -lc 'unterminated");
    expect(unwrapShellCommand("/bin/zsh -lc 'a' extra")).toBe("/bin/zsh -lc 'a' extra");
  });

  it("unwraps Codex's spliced quoting across a long script", () => {
    // Shape Codex produces: single-quoted script, each inner ' spliced as '"'…
    const real = `/bin/zsh -lc 'export TZ=UTC; for f in a b; do if [ -f "$f" ]; then printf '"'%s\\n' \\"'"'$f"; fi; done; sed -n '"'1,260p' scripts/test.sh"`;
    const script = unwrapShellCommand(real);
    expect(script.startsWith("export TZ=UTC; for f in a b; do")).toBe(true);
    expect(script.endsWith("sed -n '1,260p' scripts/test.sh")).toBe(true);
  });
});
