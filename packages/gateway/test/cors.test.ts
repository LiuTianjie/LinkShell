import { describe, expect, it, vi } from "vitest";
import { setCors } from "../src/cors.js";

describe("CORS headers", () => {
  it("allows session deletion requests from browser-based clients", () => {
    const headers = new Map<string, string>();
    const response = {
      setHeader: vi.fn((name: string, value: string) => {
        headers.set(name, value);
      }),
    };

    setCors(response as any);

    expect(headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(headers.get("Access-Control-Allow-Methods")?.split(/,\s*/)).toEqual([
      "GET",
      "POST",
      "DELETE",
      "OPTIONS",
    ]);
    expect(headers.get("Access-Control-Allow-Headers")).toContain("Authorization");
  });
});
