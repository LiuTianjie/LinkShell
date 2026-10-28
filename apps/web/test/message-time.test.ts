import { describe, expect, it } from "vitest";
import { messageTime } from "../src/live/session-time";

describe("messageTime", () => {
  const now = new Date(2026, 9, 28, 19, 30).getTime();
  it("is the time today, with the weekday within a week, else with the date", () => {
    expect(messageTime(new Date(2026, 9, 28, 9, 5).getTime(), now)).toBe("09:05");
    expect(messageTime(new Date(2026, 9, 26, 22, 0).getTime(), now)).toMatch(/^周一 22:00$/);
    expect(messageTime(new Date(2026, 9, 1, 8, 0).getTime(), now)).toBe("10月1日 08:00");
    expect(messageTime(new Date(2025, 11, 31, 8, 0).getTime(), now)).toBe("2025年12月31日 08:00");
  });
});
