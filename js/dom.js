// Tiny element builder. Text always goes in through text nodes, never through HTML parsing, so
// group and member names (untrusted input) can't inject markup.

/**
 * @param {string} tag
 * @param {Record<string, unknown>} [props]  `class`, `text`, `dataset`, `on<event>` or any attribute
 * @param {...(Node | string | null | false | Array<Node | string | null | false>)} children
 */
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key === "class") el.className = String(value);
    else if (key === "text") el.textContent = String(value);
    else if (key === "dataset") Object.assign(el.dataset, value);
    else if (key.startsWith("on") && typeof value === "function") {
      el.addEventListener(key.slice(2), value);
    } else el.setAttribute(key, value === true ? "" : String(value));
  }
  // append() turns strings into text nodes.
  el.append(...children.flat().filter((c) => c != null && c !== false));
  return el;
}

export const prefersReducedMotion = () =>
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;
