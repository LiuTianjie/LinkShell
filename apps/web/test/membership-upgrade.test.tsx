import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  ITOOL_MEMBERSHIP_URL,
  ITOOL_YEARLY_UPGRADE_URL,
  MEMBERSHIP_PRODUCT_TOTAL,
  MONTHLY_PRODUCT_COUNT,
  MONTHLY_UPGRADE_COPY,
} from "@linkshell/client-core";
import { MembershipStatus } from "../src/live/AccountMembership";

const noop = () => {};
const render = (membership: Parameters<typeof MembershipStatus>[0]["membership"]) =>
  renderToStaticMarkup(createElement(MembershipStatus, { membership, loading: false, disabled: false, onRefresh: noop }));

describe("the yearly upgrade for monthly members", () => {
  it("shows monthly members what they have and leads to the yearly checkout", () => {
    const markup = render({ plan: "pro", tier: "monthly", expiresAt: "2026-12-11T00:00:00.000Z" });
    expect(markup).toContain(`${MONTHLY_UPGRADE_COPY.zh.unlocked} ·`);
    expect(markup).toContain(`href="${ITOOL_YEARLY_UPGRADE_URL.replace(/&/g, "&amp;")}"`);
    expect(markup).toContain(`>${MONTHLY_UPGRADE_COPY.zh.action}</a>`);
  });

  it("stays out of the way for yearly members and free accounts", () => {
    const yearly = render({ plan: "pro", tier: "yearly", expiresAt: "2027-11-11T00:00:00.000Z" });
    expect(yearly).not.toContain(MONTHLY_UPGRADE_COPY.zh.unlocked);
    expect(yearly).not.toContain("checkout=yearly");
    const free = render({ plan: "free" });
    expect(free).not.toContain(MONTHLY_UPGRADE_COPY.zh.unlocked);
    expect(free).toContain(`href="${ITOOL_MEMBERSHIP_URL}"`);
  });

  it("keeps the Mac app's copy of the addresses and counts the same as client-core's", () => {
    const swift = readFileSync(new URL("../../mac/Sources/LinkShell/DesktopModel.swift", import.meta.url), "utf8");
    expect(swift).toContain(`static let membershipURL = "${ITOOL_MEMBERSHIP_URL}"`);
    expect(swift).toContain(`static let yearlyUpgradeURL = "${ITOOL_YEARLY_UPGRADE_URL}"`);
    expect(swift).toContain(`static let productTotal = ${MEMBERSHIP_PRODUCT_TOTAL}`);
    expect(swift).toContain(`static let monthlyProductCount = ${MONTHLY_PRODUCT_COUNT}`);
    expect(swift).toContain('static let monthlyUnlocked = "已解锁 \\(monthlyProductCount)/\\(productTotal) 款产品"');
    expect(swift).toContain(`static let upgradeAction = "${MONTHLY_UPGRADE_COPY.zh.action}"`);
  });
});
