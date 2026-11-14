import { createElement, type ReactElement, type ReactNode, type SVGProps } from "react";

const ALLOWED_SVG_TAGS = new Set([
  "svg",
  "defs",
  "linearGradient",
  "radialGradient",
  "stop",
  "g",
  "path",
  "polygon",
  "polyline",
  "rect",
  "circle",
  "ellipse",
  "line",
]);

const ATTR_NAME_MAP: Record<string, string> = {
  class: "className",
  "clip-path": "clipPath",
  "clip-rule": "clipRule",
  "fill-opacity": "fillOpacity",
  "fill-rule": "fillRule",
  gradientTransform: "gradientTransform",
  gradientUnits: "gradientUnits",
  "stop-color": "stopColor",
  "stop-opacity": "stopOpacity",
  "stroke-dasharray": "strokeDasharray",
  "stroke-dashoffset": "strokeDashoffset",
  "stroke-linecap": "strokeLinecap",
  "stroke-linejoin": "strokeLinejoin",
  "stroke-miterlimit": "strokeMiterlimit",
  "stroke-opacity": "strokeOpacity",
  "stroke-width": "strokeWidth",
  viewBox: "viewBox",
};

interface SvgAstFrame {
  tag: string;
  props: Record<string, unknown>;
  children: SvgAstFrame[];
}

const TAG_TOKEN_RE = /<\/([a-zA-Z][a-zA-Z0-9-]*)\s*>|<([a-zA-Z][a-zA-Z0-9-]*)([^>]*?)(\/?)>/g;
const ATTR_TOKEN_RE = /([a-zA-Z_:][a-zA-Z0-9_.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

function parseAttributes(attrSource: string): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  ATTR_TOKEN_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ATTR_TOKEN_RE.exec(attrSource)) !== null) {
    const rawName = match[1]!;
    const rawValue = match[2] ?? match[3] ?? "";
    if (rawName === "xmlns" || rawName.toLowerCase().startsWith("on")) continue;
    const mapped = ATTR_NAME_MAP[rawName] ?? rawName;
    props[mapped] = rawValue;
  }
  return props;
}

function frameToReactElement(frame: SvgAstFrame, key: string): ReactNode {
  if (!ALLOWED_SVG_TAGS.has(frame.tag)) return null;
  const children: ReactNode[] = [];
  for (let i = 0; i < frame.children.length; i++) {
    const child = frameToReactElement(frame.children[i]!, `${key}-${i}`);
    if (child !== null) children.push(child);
  }
  return createElement(
    frame.tag,
    { ...frame.props, key },
    children.length > 0 ? children : undefined,
  );
}

/**
 * Scopes internal SVG paint server IDs (`id="..."` and `url(#...)`) to a per-instance
 * prefix so multiple mounted `AgentMark` / `SubagentGlyph` instances never collide in `<defs>`.
 */
export function scopeSvgPaintIds(svgMarkup: string, prefix: string): string {
  const safePrefix = prefix.replace(/[^a-zA-Z0-9_-]/g, "");
  return svgMarkup
    .replace(/(?<=[\s<])id="([^"]+)"/g, `id="${safePrefix}-$1"`)
    .replace(/url\(#([^)]+)\)/g, `url(#${safePrefix}-$1)`);
}

/**
 * Converts a trusted static SVG string (`agentMarks` / `subagentGlyphs`) into a React `<svg>`
 * element tree without `dangerouslySetInnerHTML` or browser-only `DOMParser` dependencies,
 * working identically in Chromium 152, jsdom, and Node SSR tests.
 */
export function renderTrustedSvg(
  svgMarkup: string,
  idPrefix: string,
  overrideProps?: SVGProps<SVGSVGElement>,
): ReactElement | null {
  const scoped = scopeSvgPaintIds(svgMarkup, idPrefix);
  const stack: SvgAstFrame[] = [];
  let root: SvgAstFrame | null = null;

  TAG_TOKEN_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TAG_TOKEN_RE.exec(scoped)) !== null) {
    const closingTag = match[1];
    if (closingTag) {
      if (stack.length > 0 && stack[stack.length - 1]!.tag === closingTag) {
        stack.pop();
      }
      continue;
    }

    const openTag = match[2]!;
    const attrSource = match[3] ?? "";
    const selfClosing = match[4] === "/";
    const frame: SvgAstFrame = {
      tag: openTag,
      props: parseAttributes(attrSource),
      children: [],
    };

    if (stack.length === 0) {
      root = frame;
    } else {
      stack[stack.length - 1]!.children.push(frame);
    }

    if (!selfClosing) {
      stack.push(frame);
    }
  }

  if (!root || root.tag !== "svg") return null;

  const children: ReactNode[] = [];
  for (let i = 0; i < root.children.length; i++) {
    const child = frameToReactElement(root.children[i]!, `n-${i}`);
    if (child !== null) children.push(child);
  }

  return createElement(
    "svg",
    {
      ...root.props,
      ...overrideProps,
    },
    children.length > 0 ? children : undefined,
  );
}
