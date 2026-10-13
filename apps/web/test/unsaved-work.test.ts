import { expect, it } from "vitest";
import { hasUnsavedWork, registerUnsavedWork } from "../src/live/unsaved-work";

it("keeps navigation guarded until every dirty editor has saved or closed", () => {
  const first = registerUnsavedWork();
  const second = registerUnsavedWork();
  try {
    expect(hasUnsavedWork()).toBe(true);
    first();
    first();
    expect(hasUnsavedWork()).toBe(true);
    second();
    expect(hasUnsavedWork()).toBe(false);
  } finally {
    first();
    second();
  }
});
