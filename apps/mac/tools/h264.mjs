// Reads what a check needs out of an H.264 stream, by the letter of the standard (ITU-T H.264
// §7.3): the NAL units of an Annex B buffer, a sequence parameter set (profile, level, size,
// how many frames a decoder may have to hold back), a picture parameter set, and the quantizer
// a slice starts with — the lower, the finer the picture. Used by stream-check.mjs.

/** The NAL units of an Annex B buffer: each `{ type, refIdc, data }`, `data` without its start code. */
export function nalUnits(buffer) {
  const starts = [];
  for (let i = 0; i + 2 < buffer.length; i++) {
    if (buffer[i] === 0 && buffer[i + 1] === 0 && buffer[i + 2] === 1) {
      starts.push(i + 3);
      i += 2;
    }
  }
  return starts.map((start, index) => {
    let end = index + 1 < starts.length ? starts[index + 1] - 3 : buffer.length;
    // A four-byte start code's first zero belongs to it, not to the unit before.
    if (index + 1 < starts.length && end > start && buffer[end - 1] === 0) end -= 1;
    const data = buffer.subarray(start, end);
    return { type: data[0] & 0x1f, refIdc: (data[0] >> 5) & 3, data };
  });
}

/** Bits of a NAL unit's payload, with the bytes that keep start codes out of it (00 00 03) taken out. */
class Bits {
  constructor(nal) {
    const bytes = [];
    for (let i = 1; i < nal.length; i++) {
      if (i + 2 < nal.length && nal[i] === 0 && nal[i + 1] === 0 && nal[i + 2] === 3) {
        bytes.push(0, 0);
        i += 2;
      } else bytes.push(nal[i]);
    }
    this.bytes = bytes;
    this.at = 0;
  }
  u(count) {
    let value = 0;
    for (let i = 0; i < count; i++) {
      const byte = this.bytes[this.at >> 3];
      if (byte === undefined) throw new Error("the NAL unit ends before it should");
      value = value * 2 + ((byte >> (7 - (this.at & 7))) & 1);
      this.at += 1;
    }
    return value;
  }
  ue() {
    let zeros = 0;
    while (this.u(1) === 0) zeros += 1;
    return 2 ** zeros - 1 + this.u(zeros);
  }
  se() {
    const code = this.ue();
    return code % 2 ? (code + 1) / 2 : -code / 2;
  }
}

const PROFILES = { 66: "Baseline", 77: "Main", 88: "Extended", 100: "High" };

function skipScalingList(bits, size) {
  let last = 8;
  let next = 8;
  for (let i = 0; i < size; i++) {
    if (next !== 0) next = (last + bits.se() + 256) % 256;
    last = next === 0 ? last : next;
  }
}

function skipHrd(bits) {
  const count = bits.ue() + 1;
  bits.u(8);
  for (let i = 0; i < count; i++) {
    bits.ue();
    bits.ue();
    bits.u(1);
  }
  bits.u(20);
}

/** A sequence parameter set (NAL type 7). `reorder` is undefined when the stream doesn't say. */
export function parseSps(nal) {
  const bits = new Bits(nal);
  const sps = { profileIdc: bits.u(8), constraints: bits.u(8), levelIdc: bits.u(8), id: bits.ue(), chroma: 1, separatePlanes: false };
  if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].includes(sps.profileIdc)) {
    sps.chroma = bits.ue();
    if (sps.chroma === 3) sps.separatePlanes = bits.u(1) === 1;
    bits.ue();
    bits.ue();
    bits.u(1);
    if (bits.u(1)) for (let i = 0; i < (sps.chroma === 3 ? 12 : 8); i++) if (bits.u(1)) skipScalingList(bits, i < 6 ? 16 : 64);
  }
  sps.frameNumBits = bits.ue() + 4;
  sps.pocType = bits.ue();
  if (sps.pocType === 0) sps.pocBits = bits.ue() + 4;
  else if (sps.pocType === 1) {
    sps.deltaPocAlwaysZero = bits.u(1) === 1;
    bits.se();
    bits.se();
    for (let count = bits.ue(); count > 0; count--) bits.se();
  }
  sps.refFrames = bits.ue();
  bits.u(1);
  const widthMbs = bits.ue() + 1;
  const heightUnits = bits.ue() + 1;
  sps.frameMbsOnly = bits.u(1) === 1;
  if (!sps.frameMbsOnly) bits.u(1);
  bits.u(1);
  let crop = [0, 0, 0, 0];
  if (bits.u(1)) crop = [bits.ue(), bits.ue(), bits.ue(), bits.ue()];
  // 4:2:0: a crop unit is two pixels each way (twice that down, for fields).
  const unitX = sps.chroma === 0 || sps.chroma === 3 ? 1 : 2;
  const unitY = (sps.chroma === 1 ? 2 : 1) * (sps.frameMbsOnly ? 1 : 2);
  sps.width = widthMbs * 16 - (crop[0] + crop[1]) * unitX;
  sps.height = heightUnits * 16 * (sps.frameMbsOnly ? 1 : 2) - (crop[2] + crop[3]) * unitY;
  if (bits.u(1)) {
    if (bits.u(1) && bits.u(8) === 255) bits.u(32);
    if (bits.u(1)) bits.u(1);
    if (bits.u(1)) {
      bits.u(3);
      sps.fullRange = bits.u(1) === 1;
      if (bits.u(1)) [sps.primaries, sps.transfer, sps.matrix] = [bits.u(8), bits.u(8), bits.u(8)];
    }
    if (bits.u(1)) {
      bits.ue();
      bits.ue();
    }
    if (bits.u(1)) {
      bits.u(32);
      bits.u(32);
      bits.u(1);
    }
    const nalHrd = bits.u(1);
    if (nalHrd) skipHrd(bits);
    const vclHrd = bits.u(1);
    if (vclHrd) skipHrd(bits);
    if (nalHrd || vclHrd) bits.u(1);
    bits.u(1);
    if (bits.u(1)) {
      bits.u(1);
      for (let i = 0; i < 4; i++) bits.ue();
      sps.reorder = bits.ue();
      sps.buffering = bits.ue();
    }
  }
  // Constraint flag 1 with Baseline is Constrained Baseline; flags 4 and 5 with High, Constrained High.
  const constrained = sps.profileIdc === 66 ? (sps.constraints & 0x40) !== 0 : sps.profileIdc === 100 ? (sps.constraints & 0x0c) === 0x0c : false;
  sps.profile = `${constrained ? "Constrained " : ""}${PROFILES[sps.profileIdc] ?? sps.profileIdc}`;
  sps.level = sps.levelIdc / 10;
  /** What a page gives WebCodecs (packages/host/src/screen-viewer.ts). */
  sps.codec = `avc1.${[sps.profileIdc, sps.constraints, sps.levelIdc].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  return sps;
}

/** A picture parameter set (NAL type 8). */
export function parsePps(nal) {
  const bits = new Bits(nal);
  const pps = { id: bits.ue(), sps: bits.ue(), cabac: bits.u(1) === 1, bottomFieldPoc: bits.u(1) === 1 };
  if (bits.ue() !== 0) throw new Error("slice groups are not read");
  bits.ue();
  bits.ue();
  pps.weighted = bits.u(1) === 1;
  pps.weightedBi = bits.u(2);
  pps.initQp = 26 + bits.se();
  bits.se();
  bits.se();
  bits.u(2);
  pps.redundant = bits.u(1) === 1;
  return pps;
}

/** A slice (NAL type 1 or 5): `{ type: "I" | "P" | "B", qp, frameNum }`. */
export function parseSlice(unit, sps, pps) {
  const bits = new Bits(unit.data);
  const idr = unit.type === 5;
  bits.ue();
  const kind = bits.ue() % 5;
  bits.ue();
  if (sps.separatePlanes) bits.u(2);
  const frameNum = bits.u(sps.frameNumBits);
  let field = false;
  if (!sps.frameMbsOnly) {
    field = bits.u(1) === 1;
    if (field) bits.u(1);
  }
  if (idr) bits.ue();
  if (sps.pocType === 0) {
    bits.u(sps.pocBits);
    if (pps.bottomFieldPoc && !field) bits.se();
  } else if (sps.pocType === 1 && !sps.deltaPocAlwaysZero) {
    bits.se();
    if (pps.bottomFieldPoc && !field) bits.se();
  }
  if (pps.redundant) bits.ue();
  const predicted = kind === 0 || kind === 3;
  if (kind === 1) bits.u(1);
  if ((predicted || kind === 1) && bits.u(1)) {
    bits.ue();
    if (kind === 1) bits.ue();
  }
  for (let list = 0; list < (kind === 1 ? 2 : predicted ? 1 : 0); list++) {
    if (!bits.u(1)) continue;
    for (;;) {
      const change = bits.ue();
      if (change === 3) break;
      bits.ue();
    }
  }
  if ((pps.weighted && predicted) || (pps.weightedBi === 1 && kind === 1)) throw new Error("weighted prediction is not read");
  if (unit.refIdc !== 0) {
    if (idr) bits.u(2);
    else if (bits.u(1)) {
      for (;;) {
        const operation = bits.ue();
        if (operation === 0) break;
        if (operation === 1 || operation === 3) bits.ue();
        if (operation === 2) bits.ue();
        if (operation === 3 || operation === 6) bits.ue();
        if (operation === 4) bits.ue();
      }
    }
  }
  if (pps.cabac && kind !== 2 && kind !== 4) bits.ue();
  return { type: kind === 2 || kind === 4 ? "I" : kind === 1 ? "B" : "P", qp: pps.initQp + bits.se(), frameNum };
}
