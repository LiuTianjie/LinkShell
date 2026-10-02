import { afterEach, describe, expect, it } from "vitest";
import { baseName, clockTime, compactNumber, duration, fileSize, relativeTime, setHostHome, shortPath } from "@/lib/format";

// A Wednesday afternoon, in whatever time zone the test runs.
const now = new Date(2026, 8, 30, 15, 0).getTime();
const at = (...date: [number, number, number, number?, number?]) => new Date(...date).getTime();

describe("when something happened", () => {
  it("counts minutes within the hour, then gives the time of day", () => {
    expect(relativeTime(now - 20_000, now)).toBe("刚刚");
    expect(relativeTime(now - 5 * 60_000, now)).toBe("5 分钟前");
    expect(relativeTime(at(2026, 8, 30, 9, 5), now)).toBe("09:05");
  });

  it("names yesterday and the days of the past week, then gives the date", () => {
    expect(relativeTime(at(2026, 8, 29, 23, 59), now)).toBe("昨天");
    expect(relativeTime(at(2026, 8, 27, 12), now)).toBe("周日");
    expect(relativeTime(at(2026, 8, 3, 12), now)).toBe("9月3日");
    expect(relativeTime(at(2025, 8, 3, 12), now)).toBe("2025年9月3日");
  });

  it("adds the day to the time only when it isn't today", () => {
    expect(clockTime(now - 5 * 60_000, now)).toBe("14:55");
    expect(clockTime(at(2026, 8, 30, 9, 5), now)).toBe("09:05");
    expect(clockTime(at(2026, 8, 29, 9, 5), now)).toBe("昨天 09:05");
  });
});

describe("amounts", () => {
  it("says how long something took", () => {
    expect(duration(200)).toBe("1 秒");
    expect(duration(59_000)).toBe("59 秒");
    expect(duration(120_000)).toBe("2 分钟");
    expect(duration(125_000)).toBe("2 分 5 秒");
    expect(duration(3_600_000)).toBe("1 小时");
    expect(duration(3_900_000)).toBe("1 小时 5 分");
  });

  it("shortens counts and sizes", () => {
    expect(compactNumber(999)).toBe("999");
    expect(compactNumber(1500)).toBe("1.5k");
    expect(compactNumber(25_000)).toBe("25k");
    expect(compactNumber(1_200_000)).toBe("1.2M");
    expect(fileSize(812)).toBe("812 B");
    expect(fileSize(3482)).toBe("3.4 KB");
    expect(fileSize(5 * 1024 * 1024)).toBe("5.0 MB");
    expect(fileSize(3 * 1024 ** 3)).toBe("3.0 GB");
  });
});

describe("paths on the computer", () => {
  afterEach(() => setHostHome(undefined));

  it("names a project by its folder, whichever way the slashes go", () => {
    expect(baseName("/Users/me/code/linkshell/")).toBe("linkshell");
    expect(baseName("C:\\code\\linkshell")).toBe("linkshell");
    expect(baseName("/")).toBe("/");
  });

  it("writes the computer's home directory as ~", () => {
    setHostHome("/data/people/me/");
    expect(shortPath("/data/people/me/code")).toBe("~/code");
    expect(shortPath("/data/people/me")).toBe("~");
    // Another directory that only starts with the same letters isn't inside it.
    expect(shortPath("/data/people/meera/code")).toBe("/data/people/meera/code");
  });

  it("guesses the home directory before the computer has said where it is", () => {
    expect(shortPath("/Users/me/code")).toBe("~/code");
    expect(shortPath("/home/me/code")).toBe("~/code");
    expect(shortPath("/opt/code")).toBe("/opt/code");
  });
});
