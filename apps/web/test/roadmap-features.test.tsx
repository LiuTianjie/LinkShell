import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  diffLines,
  itoolMembershipUrl,
  itoolYearlyUpgradeUrl,
} from "@linkshell/client-core";
import { MembershipStatus, ReferralCard } from "../src/live/AccountMembership";
import { ComputerResourceReadings } from "../src/live/ComputerMetricsVisuals";
import { setWebLocalePreference } from "../src/live/i18n";
import { membershipOf } from "../src/live/management-model";
import { formatDiffReviewPrompt } from "../src/live/Panels";
import { atFileMention } from "../src/live/Session";
import { DiffView } from "../src/live/Timeline";

afterEach(() => {
  setWebLocalePreference("zh");
});

describe("Web localization & Trial/Referral growth UI", () => {
  it("renders 7-day trial badge, <=2 day renewal banner, and locale-aware checkout URLs across zh/en/ja", () => {
    const noop = () => {};
    const twoDaysLater = new Date(Date.now() + 36 * 60 * 60 * 1000).toISOString();
    const fiveDaysLater = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString();

    setWebLocalePreference("zh");
    const zhExpiring = renderToStaticMarkup(
      createElement(MembershipStatus, {
        membership: {
          plan: "pro",
          tier: "monthly",
          isTrial: true,
          trialEndsAt: twoDaysLater,
          expiresAt: twoDaysLater,
        },
        loading: false,
        disabled: false,
        onRefresh: noop,
      }),
    );
    expect(zhExpiring).toContain("7 天免费试用");
    expect(zhExpiring).toContain("开通正式会员");
    expect(zhExpiring).toContain(`href="${itoolMembershipUrl("zh")}"`);

    const zhHealthyTrial = renderToStaticMarkup(
      createElement(MembershipStatus, {
        membership: {
          plan: "pro",
          tier: "monthly",
          isTrial: true,
          trialEndsAt: fiveDaysLater,
          expiresAt: fiveDaysLater,
        },
        loading: false,
        disabled: false,
        onRefresh: noop,
      }),
    );
    expect(zhHealthyTrial).toContain("7 天免费试用");
    expect(zhHealthyTrial).not.toContain("免费试用仅剩");

    setWebLocalePreference("en");
    const enTrial = renderToStaticMarkup(
      createElement(MembershipStatus, {
        membership: {
          plan: "pro",
          tier: "monthly",
          isTrial: true,
          trialEndsAt: twoDaysLater,
          expiresAt: twoDaysLater,
        },
        loading: false,
        disabled: false,
        onRefresh: noop,
      }),
    );
    expect(enTrial).toContain("7-day free trial");
    expect(enTrial).toContain("Activate Membership");
    expect(enTrial).toContain(`href="${itoolMembershipUrl("en")}"`);

    setWebLocalePreference("ja");
    const jaMonthly = renderToStaticMarkup(
      createElement(MembershipStatus, {
        membership: {
          plan: "pro",
          tier: "monthly",
          expiresAt: "2027-05-01T00:00:00.000Z",
        },
        loading: false,
        disabled: false,
        onRefresh: noop,
      }),
    );
    expect(jaMonthly).toContain(
      `href="${itoolYearlyUpgradeUrl("ja").replace(/&/g, "&amp;")}"`,
    );

    const referralMarkup = renderToStaticMarkup(
      createElement(ReferralCard, {
        userId: "user-123",
        referral: {
          code: "LINK777",
          shareUrl: "https://itool.tech/ja/pro?from=linkshell&ref=LINK777",
          invited: 3,
          rewarded: 2,
          earnedDays: 44,
        },
      }),
    );
    expect(referralMarkup).toContain("友だち招待");
    expect(referralMarkup).toContain("+44");
  });

  it("models trial accounts and remaining days in desktop management", () => {
    const now = Date.parse("2026-11-12T00:00:00.000Z");
    const tomorrow = "2026-11-13T12:00:00.000Z";
    const status = membershipOf(
      {
        state: "signed-in",
        plan: "pro",
        tier: "monthly",
        planExpiresAt: tomorrow,
        isTrial: true,
        trialEndsAt: tomorrow,
      },
      now,
    );
    expect(status.kind).toBe("pro");
    if (status.kind === "pro") {
      expect(status.isTrial).toBe(true);
      expect(status.daysRemaining).toBe(2);
    }
  });
});

describe("Upgraded Changes panel & inline diff review", () => {
  it("formats batch inline review comments cleanly in zh/en/ja", () => {
    const annotations = [
      {
        path: "src/app.ts",
        lineNumber: 42,
        sign: "+" as const,
        code: "const count = anyVal;",
        comment: "Avoid implicit any; add an explicit number type.",
      },
    ];
    const enPrompt = formatDiffReviewPrompt(annotations, "en");
    expect(enPrompt).toContain("`src/app.ts` line 42");
    expect(enPrompt).toContain("Avoid implicit any; add an explicit number type.");

    const jaPrompt = formatDiffReviewPrompt(annotations, "ja");
    expect(jaPrompt).toContain("42行目");

    const zhPrompt = formatDiffReviewPrompt(annotations, "zh");
    expect(zhPrompt).toContain("第 42 行");
  });

  it("renders inline line comments inside DiffView when review props are supplied", () => {
    const lines = diffLines("const a = 1;\n", "const a = 2;\n");
    const html = renderToStaticMarkup(
      createElement(DiffView, {
        lines,
        comments: {
          1: "Please rename `a` to `initialRetryCount`.",
        },
        onSelectLine: () => {},
      }),
    );
    expect(html).toContain("Please rename `a` to `initialRetryCount`.");
    expect(html).toContain("data-interactive=\"\"");
    expect(html).toContain("data-commented=\"\"");
  });
});

describe("Composer @file autocomplete parser", () => {
  it("matches @file tokens at the caret while ignoring emails and slash commands", () => {
    expect(atFileMention("@src/live/App", 13)).toEqual({
      start: 0,
      end: 13,
      query: "src/live/App",
    });
    expect(atFileMention("Inspect @packages/wire/rpc.ts before editing", 29)).toEqual({
      start: 8,
      end: 29,
      query: "packages/wire/rpc.ts",
    });
    expect(atFileMention("email me at dev@itool.tech", 26)).toBeUndefined();
    expect(atFileMention("/model", 6)).toBeUndefined();
  });
});

describe("Port preview runtime error bridge injection", () => {
  it("injects errorBootstrap into text/html preview responses without altering plain text", async () => {
    const workerSource = readFileSync(
      new URL("../public/preview/worker.js", import.meta.url),
      "utf8",
    );
    const listeners = new Map<string, (event: {
      request: Request;
      clientId: string;
      resultingClientId: string;
      respondWith: (response: Promise<Response>) => void;
    }) => void>();

    const postMessage = vi.fn((message, ports) => {
      if (message.type === "restore") {
        ports[0].postMessage({ bootstrap: "function() {}" });
      } else if (message.path === "/index.html") {
        ports[0].postMessage({
          type: "http-head",
          status: 200,
          headers: [["content-type", "text/html; charset=utf-8"]],
        });
        ports[0].postMessage({
          type: "http-chunk",
          body: new TextEncoder().encode("<!doctype html><html><head><title>App</title></head><body>ok</body></html>").buffer,
        });
        ports[0].postMessage({ type: "http-end" });
      } else {
        ports[0].postMessage({
          type: "http-head",
          status: 200,
          headers: [["content-type", "text/plain"]],
        });
        ports[0].postMessage({
          type: "http-chunk",
          body: new TextEncoder().encode("plain-body").buffer,
        });
        ports[0].postMessage({ type: "http-end" });
      }
      ports[0].close();
    });

    const bridge = {
      id: "bridge",
      url: "https://preview.test/preview/bridge.html#token",
      postMessage,
    };
    const page = { id: "page", url: "https://preview.test/preview/view/token/" };

    runInNewContext(workerSource, {
      self: {
        location: { origin: "https://preview.test" },
        addEventListener: (name: string, fn: (event: never) => void) => listeners.set(name, fn),
      },
      clients: {
        matchAll: async () => [bridge, page],
        get: async (id: string) => (id === "page" ? page : id === "bridge" ? bridge : undefined),
      },
      URL,
      Response,
      Request,
      Headers,
      MessageChannel,
      ReadableStream,
      TextEncoder,
      TextDecoder,
      Uint8Array,
      crypto,
      setTimeout,
      clearTimeout,
      fetch: async () => new Response("fallback"),
    });

    const fetchFromWorker = (path: string) => {
      let out!: Promise<Response>;
      listeners.get("fetch")!({
        request: new Request("https://preview.test" + path),
        clientId: "page",
        resultingClientId: "",
        respondWith: (value) => {
          out = value;
        },
      });
      return out;
    };

    const htmlRes = await fetchFromWorker("/preview/view/token/index.html");
    const htmlBody = await htmlRes.text();
    expect(htmlBody).toContain("preview-runtime-error");
    expect(htmlBody).toContain("unhandledrejection");

    const txtRes = await fetchFromWorker("/preview/view/token/readme.txt");
    expect(await txtRes.text()).toBe("plain-body");
  });
});

describe("Computer power telemetry readings", () => {
  it("renders clean battery label without trailing percent sign across zh/en/ja", () => {
    const sample = {
      sampledAt: 1000,
      sampleIntervalMs: 5000,
      cpu: { usage: 25, cores: 8, model: "M3" },
      memory: { totalBytes: 16 * 1024 ** 3, usedBytes: 8 * 1024 ** 3 },
      power: { onBattery: true, percent: 82 },
    };
    setWebLocalePreference("zh");
    expect(renderToStaticMarkup(createElement(ComputerResourceReadings, { metrics: sample }))).toContain("<dt>电池</dt><dd>82%</dd>");
    setWebLocalePreference("en");
    expect(renderToStaticMarkup(createElement(ComputerResourceReadings, { metrics: sample }))).toContain("<dt>Battery</dt><dd>82%</dd>");
    setWebLocalePreference("ja");
    expect(renderToStaticMarkup(createElement(ComputerResourceReadings, { metrics: sample }))).toContain("<dt>バッテリー</dt><dd>82%</dd>");
  });
});
