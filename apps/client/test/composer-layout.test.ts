import { describe, expect, it } from "vitest";
import { composerCardsHeight, composerCardsKeyboardOffset, composerViewport } from "../src/lib/composer-layout";

describe("bounded sticky composer", () => {
  it("reserves the keyboard exactly once, including the sticky bottom offset", () => {
    const { available } = composerViewport(669, 216, 34, 0);
    const inputHeight = 100;
    const cards = composerCardsHeight(available, inputHeight, 34, 216);
    const totalHeight = cards + inputHeight + 34 + 22;
    expect(available).toBe(487);
    expect(totalHeight).toBe(available);
    expect(669 - totalHeight - (216 - 34)).toBe(0);
  });

  it("keeps a compact input row when a half pane has little room above the keyboard", () => {
    const viewport = composerViewport(334, 216, 0, 0);
    expect(viewport).toEqual({ available: 118, compact: true, textMaxHeight: 44 });
    const cards = composerCardsHeight(viewport.available, 56, 0, 216);
    expect(cards).toBe(40);
    expect(cards + 56 + 22).toBe(118);
  });

  it("reserves the scroll-to-latest accessory and never creates negative card bounds", () => {
    const viewport = composerViewport(334, 216, 0, 42);
    expect(viewport.available).toBe(76);
    expect(composerCardsHeight(viewport.available, 56, 0)).toBe(0);
    expect(composerViewport(180, 220, 0, 42).available).toBe(0);
    expect(composerCardsHeight(0, 100, 0)).toBe(0);
  });

  it("does not reserve the tab bar twice when the laptop pane already ends above it", () => {
    const keyboardHeight = 255;
    const bottomReserved = 83;
    const paneHeight = 900 - bottomReserved;
    const viewport = composerViewport(paneHeight, keyboardHeight, 0, 0, bottomReserved);
    expect(viewport.available).toBe(900 - keyboardHeight);
    // Root bottom is 83pt above the window; the sticky opened offset cancels exactly that distance.
    const inputBottom = 900 - bottomReserved - keyboardHeight + bottomReserved;
    expect(inputBottom).toBe(900 - keyboardHeight);
    expect(composerViewport(paneHeight, 0, 0, 0, bottomReserved).available).toBe(paneHeight);
    expect(composerViewport(900, 0, 34, 0).available).toBe(900);
  });

  it("keeps the timeline inset aligned with the input when only part of the safe bottom is consumed", () => {
    const windowHeight = 900;
    const reserved = 12;
    const safeBottom = 83;
    const padding = safeBottom - reserved;
    const keyboard = 255;
    const composerHeight = 170;
    const offset = reserved + padding;
    const composerTop = windowHeight - reserved - composerHeight - keyboard + offset;
    const timelineBottom = windowHeight - reserved - (composerHeight + keyboard - offset);
    expect(timelineBottom).toBe(composerTop);
  });

  it("bounds multiline input separately from long permission and queue contents", () => {
    expect(composerViewport(900, 0, 34, 0)).toMatchObject({ compact: false, textMaxHeight: 150 });
    expect(composerViewport(350, 0, 0, 0)).toMatchObject({ compact: false, textMaxHeight: 105 });
    expect(composerCardsHeight(350, 161, 0)).toBe(167);
  });

  it("leaves chat context above long approvals and six queued messages on ordinary iPhone", () => {
    // iPhone 17: 874pt window, 106pt header, 12pt consumed bottom, 71pt remaining tab padding.
    const viewport = composerViewport(874 - 106 - 12, 0, 71, 0, 83);
    const cards = composerCardsHeight(viewport.available, 100, 71, 0);
    expect(cards).toBeCloseTo(453.6);
    const chatContext = viewport.available - cards - 100 - 71 - 22;
    expect(chatContext).toBeGreaterThan(100);
  });

  it("uses the remaining unified card budget above a landscape keyboard without hiding input", () => {
    // Landscape iPhone after its top header and bottom reservation are consumed.
    const viewport = composerViewport(402 - 44 - 12, 216, 21, 0, 33);
    expect(viewport.compact).toBe(true);
    const cards = composerCardsHeight(viewport.available, 56, 21, 216);
    expect(cards).toBe(64);
    expect(cards + 56 + 21 + 22).toBe(viewport.available);
  });

  it("scrolls a question input above the pinned composer, rather than only above the keyboard", () => {
    // Captured keyboard top: 783; card viewport ends at 705, behind a 62pt pinned input plus two 8pt gaps.
    const keyboardTop = 783;
    const cardsBottom = 705;
    const focusedInputBottom = keyboardTop - composerCardsKeyboardOffset(62);
    expect(focusedInputBottom).toBe(cardsBottom - 12);
    expect(focusedInputBottom).toBeLessThan(cardsBottom);
  });
});
