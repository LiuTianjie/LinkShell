import { describe, expect, it } from "vitest";
import { BROWSE_DIRECTORY_ACTION, newSessionDirectory } from "../src/lib/new-session-directory";

describe("new sessions on a computer without history", () => {
  it("uses the computer's home for both terminals and agents when projects are empty", () => {
    expect(newSessionDirectory(undefined, [], "/Users/new-user")).toBe("/Users/new-user");
  });

  it("picks up machine information and projects that arrive after the sheet opens", () => {
    expect(newSessionDirectory(undefined, [], undefined)).toBe("");
    expect(newSessionDirectory(undefined, [], "/home/new-user")).toBe("/home/new-user");
    expect(newSessionDirectory(undefined, [{ cwd: "/work/project" }], "/home/new-user")).toBe("/work/project");
    expect(newSessionDirectory("/work/chosen", [{ cwd: "/work/project" }], "/home/new-user")).toBe("/work/chosen");
  });

  it("round-trips the browse action through the native menu's NUL-terminated string boundary", () => {
    const nativeString = (id: string) => id.split("\0", 1)[0];
    expect(nativeString("\0other")).toBe("");
    expect(nativeString(BROWSE_DIRECTORY_ACTION)).toBe(BROWSE_DIRECTORY_ACTION);
    expect(BROWSE_DIRECTORY_ACTION.startsWith("/")).toBe(false);
  });
});
