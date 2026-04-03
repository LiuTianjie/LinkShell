export interface TerminalCellStyle {
  fg?: string;
  bg?: string;
  bold?: boolean;
  inverse?: boolean;
}

interface TerminalCell {
  char: string;
  written: boolean;
  style: TerminalCellStyle;
}

interface TerminalLine {
  id: number;
  version: number;
  cells: TerminalCell[];
}

interface SavedCursorState {
  row: number;
  col: number;
  style: TerminalCellStyle;
}

export interface TerminalRenderSegment {
  text: string;
  style: TerminalCellStyle;
}

export interface TerminalRenderLine {
  id: number;
  version: number;
  cacheKey: string;
  plainText: string;
  segments: TerminalRenderSegment[];
}

export interface TerminalRenderSnapshot {
  lines: TerminalRenderLine[];
  plainText: string;
}

export interface TerminalBufferState {
  cols: number;
  rows: number;
  cursorRow: number;
  cursorCol: number;
  currentStyle: TerminalCellStyle;
  lines: TerminalLine[];
  nextLineId: number;
  savedCursor: SavedCursorState | null;
  pendingEscape: string | null;
}

export interface TerminalSnapshotOptions {
  cursorRow?: number;
  cursorCol?: number;
  cursorStyle?: TerminalCellStyle;
}

const MAX_BUFFER_LINES = 1200;

const ANSI_COLORS = {
  dark: [
    "#000000",
    "#cd3131",
    "#0dbc79",
    "#e5e510",
    "#2472c8",
    "#bc3fbc",
    "#11a8cd",
    "#e5e5e5",
  ],
  bright: [
    "#666666",
    "#f14c4c",
    "#23d18b",
    "#f5f543",
    "#3b8eea",
    "#d670d6",
    "#29b8db",
    "#ffffff",
  ],
} as const;

export function createTerminalBuffer(cols = 80, rows = 24): TerminalBufferState {
  return {
    cols: clampPositive(cols),
    rows: clampPositive(rows),
    cursorRow: 0,
    cursorCol: 0,
    currentStyle: {},
    lines: [createEmptyLine(0)],
    nextLineId: 1,
    savedCursor: null,
    pendingEscape: null,
  };
}

export function clearTerminalBuffer(state: TerminalBufferState): void {
  state.cursorRow = 0;
  state.cursorCol = 0;
  state.currentStyle = {};
  state.lines = [createEmptyLine(state.nextLineId++)];
  state.savedCursor = null;
  state.pendingEscape = null;
}

export function replaceTerminalBuffer(
  state: TerminalBufferState,
  chunks: string[],
  cols = state.cols,
  rows = state.rows,
): void {
  state.cols = clampPositive(cols);
  state.rows = clampPositive(rows);
  state.cursorRow = 0;
  state.cursorCol = 0;
  state.currentStyle = {};
  state.lines = [createEmptyLine(state.nextLineId++)];
  state.savedCursor = null;
  state.pendingEscape = null;

  for (const chunk of chunks) {
    appendTerminalChunk(state, chunk);
  }
}

export function setTerminalSize(
  state: TerminalBufferState,
  cols: number,
  rows: number,
): void {
  state.cols = clampPositive(cols);
  state.rows = clampPositive(rows);
  state.cursorCol = Math.max(0, Math.min(state.cursorCol, state.cols - 1));
  state.cursorRow = Math.max(0, Math.min(state.cursorRow, state.lines.length - 1));
}

export function appendTerminalChunk(
  state: TerminalBufferState,
  chunk: string,
): void {
  const source = state.pendingEscape ? state.pendingEscape + chunk : chunk;
  state.pendingEscape = null;
  let index = 0;

  while (index < source.length) {
    const char = source[index];

    if (char === "\u001b") {
      const result = consumeEscapeSequence(state, source, index);
      if (result.pending) {
        state.pendingEscape = result.pending;
        break;
      }
      if (result.consumed > 0) {
        index += result.consumed;
        continue;
      }
    }

    if (char === "\n") {
      moveToNextLine(state, true);
      index++;
      continue;
    }

    if (char === "\r") {
      state.cursorCol = 0;
      index++;
      continue;
    }

    if (char === "\b") {
      state.cursorCol = Math.max(0, state.cursorCol - 1);
      index++;
      continue;
    }

    if (char === "\t") {
      const nextStop = Math.min(
        state.cols - 1,
        Math.floor(state.cursorCol / 8) * 8 + 8,
      );
      while (state.cursorCol < nextStop) {
        writePrintable(state, " ");
      }
      index++;
      continue;
    }

    if (char >= " ") {
      writePrintable(state, char);
    }

    index++;
  }
}

export function createTerminalSnapshot(
  state: TerminalBufferState,
  options: TerminalSnapshotOptions = {},
  previousSnapshot?: TerminalRenderSnapshot,
): TerminalRenderSnapshot {
  const maxLineCount = Math.min(MAX_BUFFER_LINES, state.lines.length);
  const startIndex = Math.max(0, state.lines.length - maxLineCount);
  const cursorRow = options.cursorRow;
  const cursorCol = options.cursorCol;
  const cursorStyle = options.cursorStyle ?? {};
  const renderedLines: TerminalRenderLine[] = [];

  for (let lineIndex = startIndex; lineIndex < state.lines.length; lineIndex++) {
    const nextLine = createTerminalRenderLine(
      state,
      lineIndex,
      cursorRow,
      cursorCol,
      cursorStyle,
    );
    const previousLine = previousSnapshot?.lines[renderedLines.length];

    if (
      previousLine
      && previousLine.id === nextLine.id
      && previousLine.version === nextLine.version
      && previousLine.cacheKey === nextLine.cacheKey
    ) {
      renderedLines.push(previousLine);
      continue;
    }

    renderedLines.push(nextLine);
  }

  return {
    lines: renderedLines,
    plainText: renderedLines.map((line) => line.plainText).join("\n"),
  };
}

function consumeEscapeSequence(
  state: TerminalBufferState,
  chunk: string,
  start: number,
): {
  consumed: number;
  pending?: string;
} {
  const next = chunk[start + 1];
  if (!next) {
    return { consumed: 0, pending: chunk.slice(start) };
  }

  if (next === "[") {
    let cursor = start + 2;
    while (cursor < chunk.length) {
      const code = chunk.charCodeAt(cursor);
      if (code >= 0x40 && code <= 0x7e) {
        handleCsi(state, chunk.slice(start + 2, cursor), chunk[cursor]);
        return { consumed: cursor - start + 1 };
      }
      cursor++;
    }
    return { consumed: 0, pending: chunk.slice(start) };
  }

  if (next === "]") {
    let cursor = start + 2;
    while (cursor < chunk.length) {
      if (chunk[cursor] === "\u0007") {
        return { consumed: cursor - start + 1 };
      }
      if (chunk[cursor] === "\u001b" && chunk[cursor + 1] === "\\") {
        return { consumed: cursor - start + 2 };
      }
      cursor++;
    }
    return { consumed: 0, pending: chunk.slice(start) };
  }

  if (next === "7") {
    state.savedCursor = {
      row: state.cursorRow,
      col: state.cursorCol,
      style: { ...state.currentStyle },
    };
    return { consumed: 2 };
  }

  if (next === "8") {
    if (state.savedCursor) {
      state.cursorRow = state.savedCursor.row;
      state.cursorCol = state.savedCursor.col;
      state.currentStyle = { ...state.savedCursor.style };
      ensureCursorLine(state);
    }
    return { consumed: 2 };
  }

  return { consumed: 2 };
}

function handleCsi(
  state: TerminalBufferState,
  paramsSection: string,
  final: string,
): void {
  const privatePrefix = paramsSection.startsWith("?");
  const normalizedParams = privatePrefix ? paramsSection.slice(1) : paramsSection;
  const params = normalizedParams.length > 0
    ? normalizedParams.split(";").map((value) => Number.parseInt(value || "0", 10))
    : [0];

  switch (final) {
    case "A":
      state.cursorRow = Math.max(0, state.cursorRow - getCsiParam(params, 1, 1));
      ensureCursorLine(state);
      break;
    case "B":
      state.cursorRow += getCsiParam(params, 1, 1);
      ensureCursorLine(state);
      break;
    case "C":
      state.cursorCol = Math.min(
        state.cols - 1,
        state.cursorCol + getCsiParam(params, 1, 1),
      );
      break;
    case "D":
      state.cursorCol = Math.max(0, state.cursorCol - getCsiParam(params, 1, 1));
      break;
    case "E":
      state.cursorRow += getCsiParam(params, 1, 1);
      state.cursorCol = 0;
      ensureCursorLine(state);
      break;
    case "F":
      state.cursorRow = Math.max(0, state.cursorRow - getCsiParam(params, 1, 1));
      state.cursorCol = 0;
      ensureCursorLine(state);
      break;
    case "G":
      state.cursorCol = clampColumn(state, getCsiParam(params, 1, 1) - 1);
      break;
    case "H":
    case "f":
      state.cursorRow = Math.max(0, getCsiParam(params, 1, 1) - 1);
      state.cursorCol = clampColumn(state, getCsiParam(params, 2, 1) - 1);
      ensureCursorLine(state);
      break;
    case "J":
      clearDisplay(state, getCsiParam(params, 1, 0));
      break;
    case "K":
      clearLine(state, getCsiParam(params, 1, 0));
      break;
    case "m":
      applySgr(state, params);
      break;
    case "P":
      deleteCharacters(state, getCsiParam(params, 1, 1));
      break;
    case "X":
      eraseCharacters(state, getCsiParam(params, 1, 1));
      break;
    case "s":
      state.savedCursor = {
        row: state.cursorRow,
        col: state.cursorCol,
        style: { ...state.currentStyle },
      };
      break;
    case "u":
      if (state.savedCursor) {
        state.cursorRow = state.savedCursor.row;
        state.cursorCol = state.savedCursor.col;
        state.currentStyle = { ...state.savedCursor.style };
        ensureCursorLine(state);
      }
      break;
    case "h":
    case "l":
    default:
      break;
  }
}

function clearDisplay(state: TerminalBufferState, mode: number): void {
  if (mode === 2 || mode === 3) {
    clearTerminalBuffer(state);
    return;
  }

  if (mode === 1) {
    for (let lineIndex = 0; lineIndex < state.cursorRow; lineIndex++) {
      state.lines[lineIndex].cells = [];
      touchLine(state.lines[lineIndex]);
    }
    const currentLine = ensureCursorLine(state);
    for (let cellIndex = 0; cellIndex <= state.cursorCol; cellIndex++) {
      currentLine.cells[cellIndex] = createWrittenSpaceCell();
    }
    touchLine(currentLine);
    return;
  }

  const currentLine = ensureCursorLine(state);
  currentLine.cells.splice(state.cursorCol);
  touchLine(currentLine);
  for (let lineIndex = state.cursorRow + 1; lineIndex < state.lines.length; lineIndex++) {
    state.lines[lineIndex].cells = [];
    touchLine(state.lines[lineIndex]);
  }
}

function clearLine(state: TerminalBufferState, mode: number): void {
  const line = ensureCursorLine(state);

  if (mode === 2) {
    line.cells = [];
    touchLine(line);
    return;
  }

  if (mode === 1) {
    for (let index = 0; index <= state.cursorCol; index++) {
      line.cells[index] = createWrittenSpaceCell();
    }
    touchLine(line);
    return;
  }

  line.cells.splice(state.cursorCol);
  touchLine(line);
}

function deleteCharacters(state: TerminalBufferState, count: number): void {
  const line = ensureCursorLine(state);
  const deleteCount = Math.max(1, count);
  line.cells.splice(state.cursorCol, deleteCount);
  touchLine(line);
}

function eraseCharacters(state: TerminalBufferState, count: number): void {
  const line = ensureCursorLine(state);
  const eraseCount = Math.max(1, count);
  for (let index = 0; index < eraseCount; index++) {
    line.cells[state.cursorCol + index] = createWrittenSpaceCell();
  }
  touchLine(line);
}

function applySgr(state: TerminalBufferState, params: number[]): void {
  if (params.length === 0) {
    state.currentStyle = {};
    return;
  }

  for (let index = 0; index < params.length; index++) {
    const code = params[index] ?? 0;

    if (code === 0) {
      state.currentStyle = {};
      continue;
    }

    if (code === 1) {
      state.currentStyle.bold = true;
      continue;
    }

    if (code === 22) {
      state.currentStyle.bold = false;
      continue;
    }

    if (code === 7) {
      state.currentStyle.inverse = true;
      continue;
    }

    if (code === 27) {
      state.currentStyle.inverse = false;
      continue;
    }

    if (code === 39) {
      delete state.currentStyle.fg;
      continue;
    }

    if (code === 49) {
      delete state.currentStyle.bg;
      continue;
    }

    if (code >= 30 && code <= 37) {
      state.currentStyle.fg = ANSI_COLORS.dark[code - 30];
      continue;
    }

    if (code >= 40 && code <= 47) {
      state.currentStyle.bg = ANSI_COLORS.dark[code - 40];
      continue;
    }

    if (code >= 90 && code <= 97) {
      state.currentStyle.fg = ANSI_COLORS.bright[code - 90];
      continue;
    }

    if (code >= 100 && code <= 107) {
      state.currentStyle.bg = ANSI_COLORS.bright[code - 100];
      continue;
    }

    if (code === 38 || code === 48) {
      const target = code === 38 ? "fg" : "bg";
      const mode = params[index + 1];
      if (mode === 5) {
        const paletteIndex = params[index + 2];
        if (typeof paletteIndex === "number") {
          state.currentStyle[target] = convert256Color(paletteIndex);
        }
        index += 2;
        continue;
      }
      if (mode === 2) {
        const red = params[index + 2] ?? 0;
        const green = params[index + 3] ?? 0;
        const blue = params[index + 4] ?? 0;
        state.currentStyle[target] = rgbToHex(red, green, blue);
        index += 4;
      }
    }
  }
}

function writePrintable(state: TerminalBufferState, char: string): void {
  if (state.cursorCol >= state.cols) {
    moveToNextLine(state, false);
  }

  const line = ensureCursorLine(state);
  line.cells[state.cursorCol] = {
    char,
    written: true,
    style: { ...state.currentStyle },
  };
  touchLine(line);

  state.cursorCol += 1;

  if (state.cursorCol >= state.cols) {
    moveToNextLine(state, false);
  }
}

function moveToNextLine(state: TerminalBufferState, resetColumn: boolean): void {
  state.cursorRow += 1;
  if (resetColumn) {
    state.cursorCol = 0;
  } else if (state.cursorCol >= state.cols) {
    state.cursorCol = 0;
  }
  ensureCursorLine(state);
  trimBuffer(state);
}

function ensureCursorLine(state: TerminalBufferState): TerminalLine {
  while (state.lines.length <= state.cursorRow) {
    state.lines.push(createEmptyLine(state.nextLineId++));
  }
  return state.lines[state.cursorRow];
}

function trimBuffer(state: TerminalBufferState): void {
  if (state.lines.length <= MAX_BUFFER_LINES) {
    return;
  }
  const overflow = state.lines.length - MAX_BUFFER_LINES;
  state.lines.splice(0, overflow);
  state.cursorRow = Math.max(0, state.cursorRow - overflow);
  if (state.savedCursor) {
    state.savedCursor.row = Math.max(0, state.savedCursor.row - overflow);
  }
}

function pushSegment(
  segments: TerminalRenderSegment[],
  text: string,
  style: TerminalCellStyle,
): void {
  const previous = segments[segments.length - 1];
  if (previous && sameStyle(previous.style, style)) {
    previous.text += text;
    return;
  }

  segments.push({
    text,
    style: { ...style },
  });
}

function createTerminalRenderLine(
  state: TerminalBufferState,
  lineIndex: number,
  cursorRow?: number,
  cursorCol?: number,
  cursorStyle: TerminalCellStyle = {},
): TerminalRenderLine {
  const line = state.lines[lineIndex];
  const isCursorLine = cursorRow === lineIndex;
  const cursorCellIndex = isCursorLine ? Math.max(0, cursorCol ?? 0) : -1;
  const lastCellIndex = line.cells.reduce((max, cell, idx) => (
    isBlankCell(cell) ? max : idx
  ), -1);
  const renderLength = Math.max(
    lastCellIndex + 1,
    isCursorLine ? cursorCellIndex + 1 : 0,
  );
  const segments: TerminalRenderSegment[] = [];
  let plainText = "";

  for (let cellIndex = 0; cellIndex < renderLength; cellIndex++) {
    const cell = line.cells[cellIndex] ?? createEmptyCell();
    const style = isCursorLine && cellIndex === cursorCellIndex
      ? mergeStyles(cell.style, cursorStyle)
      : cell.style;
    const char = isCursorLine && cellIndex === cursorCellIndex && cell.char === " "
      ? " "
      : cell.char;

    plainText += char;
    pushSegment(segments, char, style);
  }

  return {
    id: line.id,
    version: line.version,
    cacheKey: `${line.version}:${isCursorLine ? cursorCellIndex : -1}:${isCursorLine ? serializeStyle(cursorStyle) : ""}`,
    plainText,
    segments: segments.length > 0 ? segments : [{ text: "", style: {} }],
  };
}

function sameStyle(a: TerminalCellStyle, b: TerminalCellStyle): boolean {
  return a.fg === b.fg
    && a.bg === b.bg
    && Boolean(a.bold) === Boolean(b.bold)
    && Boolean(a.inverse) === Boolean(b.inverse);
}

function mergeStyles(base: TerminalCellStyle, overlay: TerminalCellStyle): TerminalCellStyle {
  return {
    ...base,
    ...overlay,
  };
}

function serializeStyle(style: TerminalCellStyle): string {
  return `${style.fg ?? ""}|${style.bg ?? ""}|${style.bold ? "1" : "0"}|${style.inverse ? "1" : "0"}`;
}

function isBlankCell(cell: TerminalCell): boolean {
  const hasStyle =
    Boolean(cell.style.bg)
    || Boolean(cell.style.fg)
    || Boolean(cell.style.bold)
    || Boolean(cell.style.inverse);

  return cell.written === false && cell.char === " " && !hasStyle;
}

function touchLine(line: TerminalLine): void {
  line.version += 1;
}

function createEmptyCell(): TerminalCell {
  return {
    char: " ",
    style: {},
    written: false,
  };
}

function createWrittenSpaceCell(): TerminalCell {
  return {
    char: " ",
    style: {},
    written: true,
  };
}

function convert256Color(value: number): string {
  if (value < 16) {
    return value < 8 ? ANSI_COLORS.dark[value] : ANSI_COLORS.bright[value - 8];
  }

  if (value >= 232) {
    const level = Math.round(((value - 232) / 23) * 255);
    return rgbToHex(level, level, level);
  }

  const index = value - 16;
  const red = Math.floor(index / 36);
  const green = Math.floor((index % 36) / 6);
  const blue = index % 6;
  const scale = [0, 95, 135, 175, 215, 255];
  return rgbToHex(
    scale[Math.min(5, Math.max(0, red))] ?? 0,
    scale[Math.min(5, Math.max(0, green))] ?? 0,
    scale[Math.min(5, Math.max(0, blue))] ?? 0,
  );
}

function rgbToHex(red: number, green: number, blue: number): string {
  return `#${[red, green, blue]
    .map((channel) => clampChannel(channel).toString(16).padStart(2, "0"))
    .join("")}`;
}

function clampChannel(value: number): number {
  return Math.max(0, Math.min(255, value));
}

function createEmptyLine(id: number): TerminalLine {
  return {
    id,
    version: 0,
    cells: [],
  };
}

function clampPositive(value: number): number {
  return Math.max(1, Math.floor(value) || 1);
}

function clampColumn(state: TerminalBufferState, value: number): number {
  return Math.max(0, Math.min(state.cols - 1, value));
}

function getCsiParam(params: number[], position: number, fallback: number): number {
  const value = params[position - 1];
  if (value === undefined || Number.isNaN(value)) {
    return fallback;
  }
  return value;
}
