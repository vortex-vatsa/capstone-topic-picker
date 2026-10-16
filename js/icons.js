// A small hand-drawn icon set: 20 × 20 grid, 1.5 px strokes in currentColor, so icons take the
// colour of the text around them. Built with createElementNS from static shape data; no icon
// font, no library, nothing parsed from strings.

const SVG_NS = "http://www.w3.org/2000/svg";
const DOT = { fill: "currentColor", stroke: "none" };

/** @type {Record<string, [string, Record<string, string | number>][]>} */
const SHAPES = {
  lock: [
    ["rect", { x: 4.5, y: 9, width: 11, height: 8, rx: 1.5 }],
    ["path", { d: "M7 9V6.5a3 3 0 0 1 6 0V9" }],
  ],
  drag: [
    ["circle", { cx: 7.5, cy: 5, r: 1.15, ...DOT }],
    ["circle", { cx: 12.5, cy: 5, r: 1.15, ...DOT }],
    ["circle", { cx: 7.5, cy: 10, r: 1.15, ...DOT }],
    ["circle", { cx: 12.5, cy: 10, r: 1.15, ...DOT }],
    ["circle", { cx: 7.5, cy: 15, r: 1.15, ...DOT }],
    ["circle", { cx: 12.5, cy: 15, r: 1.15, ...DOT }],
  ],
  "arrow-up": [["path", { d: "M10 15.5V4.5M5.5 9 10 4.5 14.5 9" }]],
  "arrow-down": [["path", { d: "M10 4.5v11M5.5 11l4.5 4.5 4.5-4.5" }]],
  check: [["path", { d: "m4.5 10.5 3.5 3.5 7.5-8" }]],
  open: [["circle", { cx: 10, cy: 10, r: 7, "stroke-dasharray": "2.5 2.5" }]],
  clock: [
    ["circle", { cx: 10, cy: 10, r: 7 }],
    ["path", { d: "M10 6v4l2.75 1.75" }],
  ],
  copy: [
    ["rect", { x: 7, y: 7, width: 9, height: 9, rx: 1.5 }],
    ["path", { d: "M13 7V5.5A1.5 1.5 0 0 0 11.5 4h-6A1.5 1.5 0 0 0 4 5.5v6A1.5 1.5 0 0 0 5.5 13H7" }],
  ],
  share: [
    ["circle", { cx: 14.5, cy: 5, r: 2 }],
    ["circle", { cx: 5.5, cy: 10, r: 2 }],
    ["circle", { cx: 14.5, cy: 15, r: 2 }],
    ["path", { d: "m7.3 9.1 5.4-3.1M7.3 10.9l5.4 3.1" }],
  ],
  users: [
    ["circle", { cx: 7.5, cy: 7, r: 2.75 }],
    ["path", { d: "M2.5 16c.6-2.6 2.6-4 5-4s4.4 1.4 5 4" }],
    ["circle", { cx: 13.75, cy: 7.5, r: 2.25 }],
    ["path", { d: "M14 12.1c1.8.2 3.1 1.5 3.5 3.9" }],
  ],
  close: [["path", { d: "m5 5 10 10M15 5 5 15" }]],
};

/**
 * @param {keyof typeof SHAPES} name
 * @returns {SVGSVGElement} decorative (aria-hidden); the surrounding control carries the label
 */
export function icon(name) {
  const shapes = SHAPES[name];
  if (!shapes) throw new Error(`Unknown icon: ${name}`);

  const svg = document.createElementNS(SVG_NS, "svg");
  for (const [key, value] of Object.entries({
    viewBox: "0 0 20 20",
    width: 20,
    height: 20,
    fill: "none",
    stroke: "currentColor",
    "stroke-width": 1.5,
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    "aria-hidden": "true",
    focusable: "false",
    class: `icon icon--${name}`,
  })) {
    svg.setAttribute(key, String(value));
  }
  for (const [tag, attributes] of shapes) {
    const shape = document.createElementNS(SVG_NS, tag);
    for (const [key, value] of Object.entries(attributes)) shape.setAttribute(key, String(value));
    svg.append(shape);
  }
  return svg;
}

/** Fills every static `[data-icon]` placeholder in the page markup. */
export function hydrateIcons(root = document) {
  for (const el of root.querySelectorAll("[data-icon]")) {
    el.prepend(icon(/** @type {keyof typeof SHAPES} */ (el.dataset.icon)));
  }
}
