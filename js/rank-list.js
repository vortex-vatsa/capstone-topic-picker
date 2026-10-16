// The ranking editor: two zones in one list. Questions above the "Not ranked" divider are the
// group's ranking, in order; questions below it are unranked (decision 13). Each question carries
// an optional one-line note.
//
// Dragging uses Pointer Events rather than the HTML5 drag-and-drop API, which doesn't fire on
// touch screens. Because the divider is an ordinary sibling, dragging a question past it, or
// stepping past it with the ↑/↓ buttons or arrow keys, moves the question between zones. The
// Add/Remove button does the same in one step for touch and keyboard users.
//
// Moves relocate the *neighbour* wherever possible, never the item being moved: re-inserting the
// active element would drop its keyboard focus and its pointer capture mid-drag.

import { h, prefersReducedMotion } from "./dom.js";
import { icon } from "./icons.js";
import { LIMITS, charLength } from "./validate.js";

const AUTO_SCROLL_EDGE = 56;
const AUTO_SCROLL_SPEED = 10;

/**
 * @param {HTMLOListElement} list  should be position: relative so item offsetTop is list-relative
 * @param {{
 *   questions: Map<number, { id: number, title: string, stream: string, topicId: string }>,
 *   announce: (message: string) => void,
 *   onChange: () => void,
 * }} options
 */
export function createRankList(list, { questions, announce, onChange }) {
  let locked = false;
  let drag = null;

  const divider = h(
    "li",
    { class: "rank-divider", role: "separator", "aria-label": "Not ranked" },
    h("span", { class: "rank-divider__title", text: "Not ranked" }),
    h("span", { class: "rank-divider__hint", text: "Unranked questions count as equally least wanted." }),
  );

  const items = () => /** @type {HTMLLIElement[]} */ ([...list.querySelectorAll(":scope > .rank-item")]);
  const isRanked = (li) => Boolean(li.compareDocumentPosition(divider) & Node.DOCUMENT_POSITION_FOLLOWING);
  const getRanking = () => items().filter(isRanked).map((li) => Number(li.dataset.id));
  // Zone membership is part of the layout: crossing the divider changes the ranking even though
  // the sequence of question ids stays the same.
  const layoutKey = () => [...list.children].map((el) => el.dataset.id ?? "|").join();
  const noteInput = (li) => /** @type {HTMLInputElement} */ (li.querySelector(".rank-item__note"));

  /**
   * Notes indexed by question id (index 0 = question 1), matching the API. A note explains why a
   * group wants a question, so unranked questions send none; the typed text stays in the input in
   * case the question is ranked again.
   */
  function getNotes() {
    const notes = new Array(questions.size).fill("");
    for (const li of items()) {
      if (!li.classList.contains("is-unranked")) notes[Number(li.dataset.id) - 1] = noteInput(li).value;
    }
    return notes;
  }

  function buildItem(id, note) {
    const q = questions.get(id);
    const label = `Q${id}, ${q.title}`;
    const noteId = `note-q${id}`;
    const counter = h("span", {
      id: `${noteId}-count`,
      class: "rank-item__count",
      text: `${charLength(note)}/${LIMITS.noteMax}`,
    });

    const handle = h(
      "button",
      {
        type: "button",
        class: "rank-item__handle",
        "aria-label": `Reorder ${label}`,
        "aria-describedby": "ranking-help",
      },
      icon("drag"),
    );
    const up = h(
      "button",
      { type: "button", class: "rank-item__arrow", "aria-label": `Move ${label} up` },
      icon("arrow-up"),
    );
    const down = h(
      "button",
      { type: "button", class: "rank-item__arrow", "aria-label": `Move ${label} down` },
      icon("arrow-down"),
    );
    const toggle = h("button", { type: "button", class: "btn btn--secondary rank-item__toggle" });

    const li = h(
      "li",
      { class: "rank-item", dataset: { id: String(id), label, topic: q.topicId } },
      h("span", { class: "rank-item__pos", "aria-hidden": "true" }),
      h("span", { class: "visually-hidden rank-item__unranked", text: "Not ranked." }),
      handle,
      h(
        "div",
        { class: "rank-item__text" },
        h("span", { class: "rank-item__title", text: `Q${id} · ${q.title}` }),
        h("span", { class: "rank-item__stream", text: `Topic ${q.topicId} · ${q.stream}` }),
      ),
      h("div", { class: "rank-item__controls" }, up, down, toggle),
      // The note spans the full row below, so it stays usable at phone widths.
      h(
        "div",
        { class: "rank-item__note-area" },
        h("label", { class: "visually-hidden", for: noteId, text: `Note for Q${id} (optional)` }),
        h(
          "div",
          { class: "rank-item__note-row" },
          h("input", {
            id: noteId,
            class: "rank-item__note",
            type: "text",
            value: note,
            maxlength: String(LIMITS.noteMax),
            placeholder: "Why this question? (optional)",
            autocomplete: "off",
            "aria-describedby": counter.id,
            oninput: (event) => {
              counter.textContent = `${charLength(event.target.value)}/${LIMITS.noteMax}`;
              onChange();
            },
          }),
          counter,
        ),
        // Inputs can't wrap, so a locked list shows the note as text instead.
        h("p", { class: "rank-item__note-text" }),
      ),
    );

    up.addEventListener("click", () => {
      move(li, -1);
      if (up.disabled) down.focus();
    });
    down.addEventListener("click", () => {
      move(li, 1);
      if (down.disabled) up.focus();
    });
    toggle.addEventListener("click", () => toggleZone(li, toggle));
    handle.addEventListener("keydown", (event) => {
      const all = list.children.length;
      const steps = { ArrowUp: -1, ArrowDown: 1, Home: -all, End: all };
      if (!(event.key in steps)) return;
      event.preventDefault();
      move(li, steps[event.key]);
    });
    handle.addEventListener("pointerdown", (event) => startDrag(event, li, handle));

    return li;
  }

  // ---- shared move logic ---------------------------------------------------------------------

  function move(li, delta) {
    if (locked) return;
    const before = layoutKey();
    for (let i = 0; i < Math.abs(delta); i++) {
      const moved = delta < 0 ? swapWithPrevious(li) : swapWithNext(li);
      if (!moved) break;
    }
    if (before !== layoutKey()) settled(li);
  }

  /** Add to the end of the ranking, or remove to the top of the unranked zone. */
  function toggleZone(li, toggle) {
    if (locked) return;
    if (isRanked(li)) list.insertBefore(li, divider.nextElementSibling);
    else list.insertBefore(li, divider);
    // This one moves the item itself, so put focus back on the button that was pressed.
    toggle.focus();
    settled(li);
  }

  function swapWithPrevious(li) {
    const prev = li.previousElementSibling;
    if (!prev) return false;
    animateShift(prev, () => list.insertBefore(prev, li.nextElementSibling));
    return true;
  }

  function swapWithNext(li) {
    const next = li.nextElementSibling;
    if (!next) return false;
    animateShift(next, () => list.insertBefore(next, li));
    return true;
  }

  // FLIP: measure, mutate, then animate from the old position so the neighbour glides into place.
  function animateShift(el, mutate) {
    const before = el.offsetTop;
    mutate();
    const offset = before - el.offsetTop;
    if (offset && !prefersReducedMotion()) {
      el.animate([{ transform: `translateY(${offset}px)` }, { transform: "none" }], {
        duration: 180,
        easing: "cubic-bezier(.2,.8,.2,1)",
      });
    }
  }

  function settled(li) {
    refreshPositions();
    const ranking = getRanking();
    const position = ranking.indexOf(Number(li.dataset.id)) + 1;
    announce(
      position
        ? `${li.dataset.label}: ranked ${position} of ${ranking.length}.`
        : `${li.dataset.label}: not ranked.`,
    );
    onChange();
  }

  function refreshPositions() {
    let rank = 0;
    for (const li of items()) {
      const ranked = isRanked(li);
      if (ranked) rank += 1;
      li.querySelector(".rank-item__pos").textContent = ranked ? String(rank) : "–";
      li.querySelector(".rank-item__unranked").hidden = ranked;
      li.classList.toggle("is-unranked", !ranked);
      li.classList.toggle("is-top", ranked && rank === 1);

      const [up, down] = li.querySelectorAll(".rank-item__arrow");
      up.disabled = locked || li === list.firstElementChild;
      down.disabled = locked || li === list.lastElementChild;
      const toggle = li.querySelector(".rank-item__toggle");
      toggle.textContent = ranked ? "Remove" : "Add";
      toggle.setAttribute(
        "aria-label",
        ranked ? `Remove ${li.dataset.label} from ranking` : `Add ${li.dataset.label} to ranking`,
      );
      toggle.disabled = locked;
      li.querySelector(".rank-item__handle").disabled = locked;
      noteInput(li).readOnly = locked;
      li.querySelector(".rank-item__note-text").textContent = locked ? noteInput(li).value : "";
    }
    list.classList.toggle("has-empty-ranking", rank === 0);
  }

  // ---- pointer drag --------------------------------------------------------------------------

  function startDrag(event, li, handle) {
    if (locked || drag || (event.pointerType === "mouse" && event.button !== 0)) return;
    event.preventDefault();
    handle.setPointerCapture(event.pointerId);
    handle.focus({ preventScroll: true });

    const listTop = list.getBoundingClientRect().top;
    drag = {
      li,
      handle,
      pointerId: event.pointerId,
      grabOffset: event.clientY - listTop - li.offsetTop,
      startLayout: layoutKey(),
      clientY: event.clientY,
      scroller: list.closest("[data-scroll-container]"),
      frame: 0,
    };
    li.classList.add("is-dragging");
    list.classList.add("is-sorting");
    markInsertion(li);

    handle.addEventListener("pointermove", onPointerMove);
    handle.addEventListener("pointerup", endDrag);
    handle.addEventListener("pointercancel", endDrag);
    drag.frame = requestAnimationFrame(autoScroll);
  }

  function onPointerMove(event) {
    if (!drag || event.pointerId !== drag.pointerId) return;
    drag.clientY = event.clientY;
    positionDragged();
  }

  function positionDragged() {
    const { li } = drag;
    const listTop = list.getBoundingClientRect().top;
    const half = li.offsetHeight / 2;
    // Keep the item's centre within the list so it can't be flung out of view.
    const desired = clamp(drag.clientY - drag.grabOffset - listTop, -half, list.offsetHeight - half);
    const centre = desired + half;
    const midpoint = (el) => el.offsetTop + el.offsetHeight / 2;

    // offsetTop ignores transforms, so neighbours mid-animation can't cause swap ping-pong.
    let swapped = true;
    while (swapped) {
      swapped = false;
      const next = li.nextElementSibling;
      const prev = li.previousElementSibling;
      if (next && centre > midpoint(next)) swapped = swapWithNext(li);
      else if (prev && centre < midpoint(prev)) swapped = swapWithPrevious(li);
    }
    li.style.transform = `translateY(${desired - li.offsetTop}px)`;
    markInsertion(li);
  }

  // The insertion line is drawn by CSS (.rank-list.is-sorting::after) where the item will land.
  function markInsertion(li) {
    list.style.setProperty("--insert-y", `${li.offsetTop}px`);
  }

  function autoScroll() {
    if (!drag) return;
    const scroller = drag.scroller;
    if (scroller) {
      const box = scroller.getBoundingClientRect();
      let step = 0;
      if (drag.clientY < box.top + AUTO_SCROLL_EDGE) step = -AUTO_SCROLL_SPEED;
      else if (drag.clientY > box.bottom - AUTO_SCROLL_EDGE) step = AUTO_SCROLL_SPEED;
      if (step) {
        const before = scroller.scrollTop;
        scroller.scrollTop += step;
        if (scroller.scrollTop !== before) positionDragged();
      }
    }
    drag.frame = requestAnimationFrame(autoScroll);
  }

  function endDrag(event) {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const { li, handle, startLayout, frame } = drag;
    drag = null;
    cancelAnimationFrame(frame);
    handle.removeEventListener("pointermove", onPointerMove);
    handle.removeEventListener("pointerup", endDrag);
    handle.removeEventListener("pointercancel", endDrag);

    const leftover = li.style.transform;
    li.style.transform = "";
    if (leftover && !prefersReducedMotion()) {
      li.animate([{ transform: leftover }, { transform: "none" }], { duration: 160, easing: "ease-out" });
    }
    li.classList.remove("is-dragging");
    list.classList.remove("is-sorting");

    if (startLayout !== layoutKey()) settled(li);
  }

  return {
    getNotes,
    /** The ranking to save: the questions above the divider, in order. */
    getRanking,
    /**
     * @param {number[]} order  every question id: the ranked ones first, then the unranked
     * @param {string[]} notes  indexed by question id - 1
     * @param {number} rankedCount  how many of `order` sit above the divider
     */
    setOrder(order, notes, rankedCount) {
      const built = order.map((id) => buildItem(id, notes[id - 1] ?? ""));
      list.replaceChildren(...built.slice(0, rankedCount), divider, ...built.slice(rankedCount));
      refreshPositions();
    },
    focusNote(questionId) {
      list.querySelector(`#note-q${questionId}`)?.focus();
    },
    /** Locked lists show the ranking but can't be changed (rankings are frozen after reveal). */
    setLocked(value) {
      locked = value;
      list.classList.toggle("is-locked", value);
      refreshPositions();
    },
  };
}

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
