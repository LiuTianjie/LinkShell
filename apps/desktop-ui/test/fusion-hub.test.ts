import { describe, expect, it } from "vitest";
import { fusionLayout, fusionSei, popupPlacement, windowPlacement } from "../src/fusion-hub/sei";

const slice = (nal: number) => new Uint8Array([0, 0, 0, 1, nal, 0x88, 0x84, 0x00, 0x00, 0x03, 0x01]);

describe("Fusion hub page", () => {
  it("reads the window metadata the Mac's encoder puts in front of a picture", () => {
    const layout = [120, 80, 1200, 800, 0.05, 0.1, 0.5, 0.6, 0, 0, 1200, 800, 2, 7, 4711];
    const unit = new Uint8Array([...fusionSei(layout), ...slice(0x65)]);
    expect(fusionLayout(unit)).toEqual(layout);
  });

  it("reads a popup layer's list, and survives emulation-prevention bytes in the JSON", () => {
    // Zeros in a row inside the payload force 0x03 escapes into the NAL.
    const layout = [[4800, 101, 0, 0, 0, 0], [4801, 3, 10.5, 20.25, 220, 300]];
    const unit = new Uint8Array([...slice(0x41), ...fusionSei(layout)]);
    expect(fusionLayout(unit)).toEqual(layout);
  });

  it("ignores pictures without our SEI", () => {
    expect(fusionLayout(slice(0x65))).toBeUndefined();
    expect(fusionLayout(new Uint8Array([0, 0, 1, 6, 5, 16, ...new Array(16).fill(1), 0x80]))).toBeUndefined();
  });

  it("places the picture so the window's crop fills the window", () => {
    // The window is the middle half of a 2560-point display picture, wholly visible.
    const at = windowPlacement([640, 100, 1280, 800, 0.25, 0.1, 0.5, 0.5, 0, 0, 1280, 800, 1, 0, 1]);
    expect(at).toEqual({ left: -640, top: -160, width: 2560, height: 1600 });
    // Only the window's lower part is on the display: the visible part lands below its top.
    const partial = windowPlacement([0, -100, 400, 300, 0, 0, 0.25, 0.2, 0, 100, 400, 200, 1, 0, 1]);
    expect(partial).toEqual({ left: 0, top: 100, width: 1600, height: 1000 });
    expect(windowPlacement([1, 2, 3])).toBeUndefined();
  });

  it("cuts a popup from its display's layer", () => {
    expect(popupPlacement({ x: 300, y: 40 }, { x: 0, y: -30, w: 2560, h: 1472 })).toEqual({ left: -300, top: -70, width: 2560, height: 1472 });
  });
});
