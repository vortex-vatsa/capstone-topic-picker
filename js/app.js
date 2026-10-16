// Page controller: loads the board, renders it, and runs the claim / manage / admin flows.
// All network access goes through api.js; all user-provided text is rendered via dom.js `h()`.

import { SUBMISSION_DEADLINE, TOPICS } from "./config.js";
import * as api from "./api.js";
import { assignQuestions, rankOf } from "./assign.js";
import { createChipInput } from "./chips.js";
import { createRankList } from "./rank-list.js";
import { confetti, finale } from "./celebrate.js";
import { h, prefersReducedMotion } from "./dom.js";
import { hydrateIcons, icon } from "./icons.js";
import { ordinal } from "./format.js";
import { averageRank, buildSummary, choiceLabel, headlineFor } from "./summary.js";
import { SLOT_COUNT, checkGroupName, checkMembers, checkNotes, checkPin } from "./validate.js";

const REFRESH_MS = 20_000;
const TOAST_MS = 5_000;
const OPTIONS_SHOWN = 12;
const REVEAL_SEEN_KEY = "capstone:reveal-seen";
const pinKey = (slot) => `capstone:pin:${slot}`;

const QUESTIONS = new Map(
  TOPICS.flatMap((topic) =>
    topic.questions.map((q) => [q.id, { ...q, topicId: topic.id, topicTitle: topic.title }]),
  ),
);
const QUESTION_IDS = [...QUESTIONS.keys()].sort((a, b) => a - b);
if (QUESTION_IDS.join() !== "1,2,3,4,5,6") {
  throw new Error("config.js: TOPICS must define question ids 1–6, each exactly once");
}
const EMPTY_NOTES = QUESTION_IDS.map(() => "");
/** The contract's standard way to name a question out of context: "Q1 · E-truck TCO & market". */
const questionLabel = (id) => `Q${id} · ${QUESTIONS.get(id).title}`;
const DEADLINE = parseDeadline(SUBMISSION_DEADLINE);

const $ = (id) => document.getElementById(id);

const state = {
  board: emptyBoard(),
  boardKey: "",
  loaded: false,
  refreshing: false,
  selectedOption: 0,
  showAllOptions: false,
  revealCelebrated: "",
};

// =============================================================================================
// Board loading

function emptyBoard() {
  return {
    revealed: false,
    slots: Array.from({ length: SLOT_COUNT }, (_, i) => ({
      slot: i + 1,
      claimed: false,
      group_name: null,
      members: [],
      submitted: false,
      updated_at: null,
      rankings: null,
    })),
  };
}

async function refresh() {
  if (!api.isConfigured() || state.refreshing) return;
  state.refreshing = true;
  try {
    const board = await api.getBoard();
    $("status-banner").hidden = true;
    const key = JSON.stringify(board);
    // Skipping identical boards keeps focus and scroll position stable during polling.
    if (key !== state.boardKey || !state.loaded) {
      if (board.revealed !== state.board.revealed) state.selectedOption = 0;
      state.board = board;
      state.boardKey = key;
      state.loaded = true;
      renderBoard();
    }
    celebrateRevealOnce(board);
  } catch (err) {
    // api.js already logged network detail; anything else is a bug in rendering.
    if (!(err instanceof api.ApiError)) console.error(err);
    const banner = $("status-banner");
    banner.textContent = "Couldn't load the latest board. Retrying automatically…";
    banner.hidden = false;
  } finally {
    state.refreshing = false;
  }
}

function celebrateRevealOnce(board) {
  if (!board.revealed) return;
  const signature = board.slots.map((s) => `${s.slot}:${s.rankings.join("")}`).join("|");
  // The in-memory copy stops a repeat every poll when localStorage is unavailable.
  if (state.revealCelebrated === signature || readLocal(REVEAL_SEEN_KEY) === signature) return;
  state.revealCelebrated = signature;
  writeLocal(REVEAL_SEEN_KEY, signature);

  $("allocation-title").scrollIntoView({
    behavior: prefersReducedMotion() ? "auto" : "smooth",
    block: "start",
  });
  finale();
  toast("All six groups have submitted. Allocation complete.", "success");
}

// =============================================================================================
// Rendering

function renderTopics() {
  $("topics").replaceChildren(
    ...TOPICS.map((topic) =>
      h(
        "article",
        { class: "topic", dataset: { topic: topic.id } },
        h(
          "header",
          { class: "topic__head" },
          h(
            "p",
            { class: "label" },
            h("span", { class: "bonbon", "aria-hidden": "true" }),
            `Topic ${topic.id} · ${topic.flavour}`,
          ),
          h("h3", { class: "topic__title", text: topic.title }),
        ),
        h(
          "ul",
          { class: "topic__questions" },
          topic.questions.map((q) =>
            h(
              "li",
              { class: "question" },
              h("p", { class: "label question__label", text: `Question ${twoDigits(q.id)} · ${q.stream}` }),
              h("h4", { class: "question__title", text: q.title }),
            ),
          ),
        ),
      ),
    ),
  );
}

function renderBoard() {
  renderProgress();
  preserveFocus(renderSlots);
  preserveFocus(renderAllocation);
}

/** Six slot markers: shape (icon) and words carry the state, not colour alone. */
const SLOT_STATES = {
  open: { icon: "open", text: "Not claimed" },
  registered: { icon: "clock", text: "Registered" },
  submitted: { icon: "check", text: "Ranking submitted" },
};

function renderProgress() {
  const { slots, revealed } = state.board;
  const claimed = slots.filter((s) => s.claimed).length;
  const submitted = slots.filter((s) => s.submitted).length;
  $("progress-summary").textContent = state.loaded
    ? `${claimed} of ${SLOT_COUNT} groups registered · ${submitted} ${submitted === 1 ? "ranking" : "rankings"} submitted`
    : "Loading groups…";
  $("progress-slots").replaceChildren(
    ...slots.map((s) => {
      const key = s.submitted ? "submitted" : s.claimed ? "registered" : "open";
      return h(
        "li",
        { class: `progress-slot is-${key}` },
        icon(SLOT_STATES[key].icon),
        h("span", { class: "progress-slot__name", text: s.claimed ? s.group_name : "Open" }),
        h("span", { class: "progress-slot__state", text: SLOT_STATES[key].text }),
      );
    }),
  );
  $("reveal-cta").hidden = !revealed;
  renderDeadline();
}

// Decision 11: the deadline is a nudge shown from config, not enforced by the database.
function renderDeadline() {
  const row = $("deadline-row");
  row.hidden = !DEADLINE || state.board.revealed;
  if (row.hidden) return;

  // The viewer's own locale and time zone: a date reads naturally only in one's own format.
  const when = new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(DEADLINE);
  const msLeft = DEADLINE.getTime() - Date.now();
  const overdue = msLeft <= 0;
  $("deadline").replaceChildren(
    overdue ? "Deadline passed" : `Rankings due ${when}`,
    h("span", {
      class: "ledger__hint",
      text: overdue
        ? "Late submissions are still accepted until all six are in."
        : relativeTime(msLeft),
    }),
  );
  row.classList.toggle("is-overdue", overdue);
}

function parseDeadline(raw) {
  if (raw === "REPLACE_ME") return null;
  const isoWithOffset = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(Z|[+-]\d{2}:\d{2})$/;
  const date = isoWithOffset.test(raw) ? new Date(raw) : null;
  if (!date || Number.isNaN(date.getTime())) {
    console.warn("config.js: SUBMISSION_DEADLINE must be ISO 8601 with an offset; hiding it.");
    return null;
  }
  return date;
}

function relativeTime(ms) {
  const format = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  const hours = ms / 3_600_000;
  if (hours >= 36) return format.format(Math.round(hours / 24), "day");
  if (hours >= 1.5) return format.format(Math.round(hours), "hour");
  return format.format(Math.max(1, Math.round(ms / 60_000)), "minute");
}

function renderSlots() {
  const list = $("slots");
  list.setAttribute("aria-busy", String(!state.loaded));
  list.replaceChildren(...state.board.slots.map(slotRow));
}

function slotRow(s) {
  const number = h("span", { class: "slot__num", "aria-hidden": "true", text: twoDigits(s.slot) });

  if (!state.loaded) {
    return h(
      "li",
      { class: "slot is-loading", "aria-label": `Slot ${s.slot}, loading` },
      number,
      h("div", { class: "slot__main" }, h("span", { class: "skeleton" })),
    );
  }

  if (!s.claimed) {
    return h(
      "li",
      { class: "slot is-open" },
      number,
      h(
        "div",
        { class: "slot__main" },
        h("h3", { class: "slot__name", text: "Open" }),
        h("p", { class: "slot__members", text: "Not yet claimed" }),
      ),
      h("p", { class: "slot__status" }),
      h(
        "div",
        { class: "slot__action" },
        h("button", {
          type: "button",
          class: "btn btn--primary",
          text: "Claim slot",
          "aria-label": `Claim slot ${s.slot}`,
          disabled: !api.isConfigured(),
          dataset: { focusKey: `claim-${s.slot}` },
          onclick: () => openClaim(s.slot),
        }),
      ),
    );
  }

  const [status, statusIcon] = state.board.revealed
    ? ["Locked", "lock"]
    : s.submitted
      ? ["Ranking submitted", "check"]
      : ["Ranking pending", "clock"];

  return h(
    "li",
    { class: `slot is-claimed${s.submitted ? " is-submitted" : ""}` },
    number,
    h(
      "div",
      { class: "slot__main" },
      h("h3", { class: "slot__name", text: s.group_name }),
      h(
        "p",
        { class: "slot__members" },
        icon("users"),
        h("span", { class: "visually-hidden", text: "Members: " }),
        s.members.join(", "),
      ),
    ),
    h("p", { class: "slot__status" }, icon(statusIcon), status),
    h(
      "div",
      { class: "slot__action" },
      h("button", {
        type: "button",
        class: "btn btn--secondary",
        text: "Manage",
        // Starts with the visible text so voice-control users can say what they see.
        "aria-label": `Manage ${s.group_name}`,
        dataset: { focusKey: `manage-${s.slot}` },
        onclick: () => manage(s.slot),
      }),
    ),
  );
}

const twoDigits = (n) => String(n).padStart(2, "0");

function renderAllocation() {
  const { revealed, slots } = state.board;
  $("sealed").hidden = revealed;
  $("revealed").hidden = !revealed;

  if (!revealed) {
    return;
  }

  const result = assignQuestions(slots);
  const count = result.optima.length;
  state.selectedOption = Math.min(state.selectedOption, count - 1);
  const shown = state.showAllOptions ? result.optima : result.optima.slice(0, OPTIONS_SHOWN);

  const average = averageRank(result, SLOT_COUNT);

  const showAll =
    count > shown.length &&
    h("button", {
      type: "button",
      class: "btn btn--secondary options__more",
      text: `Show all ${count} options`,
      dataset: { focusKey: "show-all-options" },
      onclick: () => {
        state.showAllOptions = true;
        preserveFocus(renderAllocation);
      },
    });

  $("revealed").replaceChildren(
    h(
      "div",
      { class: "reveal-summary" },
      h("p", { class: "label", text: "Allocation complete" }),
      h("p", { class: "reveal-summary__headline", text: headlineFor(result) }),
      h("p", {
        class: "reveal-summary__detail",
        text:
          count === 1
            ? `Average choice ${average}. This is the only allocation that achieves it.`
            : `Average choice ${average}. ${count} allocations are equally fair — agree on one together.`,
      }),
      h(
        "div",
        { class: "reveal-summary__actions" },
        h(
          "button",
          {
            type: "button",
            class: "btn btn--secondary",
            dataset: { focusKey: "copy-summary" },
            onclick: () => copySummary(result),
          },
          icon("copy"),
          "Copy summary",
        ),
        // The native share sheet is where WhatsApp lives on phones (decision 12).
        typeof navigator.share === "function" &&
          h(
            "button",
            {
              type: "button",
              class: "btn btn--secondary",
              dataset: { focusKey: "share-summary" },
              onclick: () => shareSummary(result),
            },
            icon("share"),
            "Share…",
          ),
      ),
      h("div", { id: "summary-fallback" }),
    ),
    h(
      "div",
      { class: "options", role: "group", "aria-label": count === 1 ? "Recommended allocation" : "Equally fair options" },
      shown.map((option, index) => optionCard(option, index, count)),
    ),
    showAll || "",
    heatmap(result.optima[state.selectedOption], count),
    notesByQuestion() || "",
  );
}

/** Groups' notes, grouped by question so a tie can be argued from each side's reasoning. */
function notesByQuestion() {
  const blocks = QUESTION_IDS.flatMap((id) => {
    const entries = state.board.slots
      .map((s) => ({ s, note: s.notes[id - 1], rank: rankOf(s.rankings, id, SLOT_COUNT) }))
      // A note on a question the group didn't rank would read as "unranked, but we want it".
      .filter((entry) => entry.note && entry.rank <= SLOT_COUNT)
      .sort((a, b) => a.rank - b.rank);
    if (entries.length === 0) return [];
    return h(
      "article",
      { class: "notes-question" },
      h("h4", { class: "notes-question__title", text: questionLabel(id) }),
      h(
        "ul",
        { class: "notes-question__list" },
        entries.map(({ s, note, rank }) =>
          h(
            "li",
            { class: "group-note" },
            h(
              "div",
              { class: "group-note__head" },
              h("span", { class: "group-note__group", text: s.group_name }),
              h("span", { class: `choice choice--${rank}`, text: choiceLabel(rank) }),
            ),
            h("p", { class: "group-note__text", text: note }),
          ),
        ),
      ),
    );
  });
  if (blocks.length === 0) return null;

  return h(
    "div",
    { class: "notes-block" },
    h("h3", { class: "notes-block__title", text: "Why groups want each question" }),
    h("p", { class: "hint", text: "Notes each group added to its ranking, sealed until the reveal." }),
    h("div", { class: "notes-grid" }, blocks),
  );
}

function summaryText(result) {
  return buildSummary({
    slots: state.board.slots,
    result,
    label: questionLabel,
    date: new Intl.DateTimeFormat(undefined, { dateStyle: "long" }).format(new Date()),
    url: location.href.split("#")[0],
  });
}

async function copySummary(result) {
  const text = summaryText(result);
  try {
    await navigator.clipboard.writeText(text);
    toast("Summary copied.", "success");
  } catch (err) {
    // No clipboard API (or permission denied): show the text selected, ready for Ctrl/⌘+C.
    console.error("[copy] clipboard unavailable", err?.name);
    const area = h("textarea", {
      class: "summary-fallback",
      readonly: true,
      rows: "10",
      "aria-label": "Allocation summary",
    });
    area.value = text;
    $("summary-fallback").replaceChildren(
      h("p", { class: "hint", text: "Copying isn't available in this browser. The summary is selected below; copy it manually." }),
      area,
    );
    area.focus();
    area.select();
  }
}

async function shareSummary(result) {
  try {
    await navigator.share({ title: document.title, text: summaryText(result) });
  } catch (err) {
    if (err?.name === "AbortError") return; // the share sheet was dismissed
    console.error("[share] failed", err?.name);
    toast("Sharing didn't work here. Use Copy summary instead.", "error");
  }
}

function optionCard(option, index, count) {
  const selected = index === state.selectedOption;
  const select = () => {
    if (state.selectedOption === index) return;
    state.selectedOption = index;
    preserveFocus(renderAllocation);
  };

  return h(
    "article",
    { class: `option${selected ? " is-selected" : ""}`, onclick: count > 1 ? select : null },
    h(
      "header",
      { class: "option__head" },
      h("h3", { class: "option__title", text: count === 1 ? "Recommended allocation" : `Option ${index + 1}` }),
      count > 1 && h("p", { class: "option__note", text: "Equally fair — agree on one together" }),
      count > 1 &&
        h("button", {
          type: "button",
          class: "btn btn--quiet option__toggle",
          "aria-pressed": String(selected),
          text: selected ? "Shown in table" : "Show in table",
          dataset: { focusKey: `option-${index}` },
          onclick: (event) => {
            event.stopPropagation();
            select();
          },
        }),
    ),
    h(
      "ol",
      { class: "option__rows" },
      state.board.slots.map((s) => {
        const questionId = option[s.slot];
        const rank = rankOf(s.rankings, questionId, SLOT_COUNT);
        const note = rank <= SLOT_COUNT ? s.notes[questionId - 1] : "";
        return h(
          "li",
          { class: "option__row" },
          h("span", { class: "option__group", text: s.group_name }),
          h("span", { class: `choice choice--${rank}`, text: choiceLabel(rank) }),
          h(
            "span",
            { class: "option__question" },
            h("span", { class: "visually-hidden", text: "gets " }),
            h("strong", { text: `Q${questionId}` }),
            ` · ${QUESTIONS.get(questionId).title}`,
            h("span", { class: "option__stream", text: ` · ${QUESTIONS.get(questionId).stream}` }),
          ),
          note && h("q", { class: "option__group-note", text: note }),
        );
      }),
    ),
  );
}

function heatmap(highlighted, count) {
  const caption =
    count === 1
      ? "Each cell is the rank a group gave a question (– means unranked). Outlined cells are the recommended allocation."
      : `Each cell is the rank a group gave a question (– means unranked). Outlined cells are option ${state.selectedOption + 1}.`;

  return h(
    "div",
    { class: "heatmap-block" },
    h("h3", { class: "heatmap-block__title", text: "Preference heatmap" }),
    h(
      "div",
      { class: "heatmap-scroll", role: "region", "aria-label": "Preference heatmap", tabindex: "0" },
      h(
        "table",
        { class: "heatmap" },
        h("caption", { class: "heatmap__caption", text: caption }),
        h(
          "thead",
          {},
          h(
            "tr",
            {},
            h("th", { scope: "col", text: "Group" }),
            QUESTION_IDS.map((id) =>
              h("th", { scope: "col", title: questionLabel(id), text: `Q${id}` }),
            ),
          ),
        ),
        h(
          "tbody",
          {},
          state.board.slots.map((s) =>
            h(
              "tr",
              {},
              h("th", { scope: "row", text: s.group_name }),
              QUESTION_IDS.map((id) => {
                const rank = rankOf(s.rankings, id, SLOT_COUNT);
                const unranked = rank > SLOT_COUNT;
                const assigned = highlighted[s.slot] === id;
                return h(
                  "td",
                  { class: `heat heat--${rank}${assigned ? " is-assigned" : ""}` },
                  unranked ? h("span", { "aria-label": "unranked", text: "–" }) : String(rank),
                  assigned && h("span", { class: "visually-hidden", text: " (allocated)" }),
                );
              }),
            ),
          ),
        ),
      ),
    ),
    h(
      "div",
      { class: "heatmap-legend", "aria-hidden": "true" },
      h("span", { text: "1st choice" }),
      h(
        "span",
        { class: "heatmap-legend__scale" },
        [...QUESTION_IDS, SLOT_COUNT + 1].map((r) => h("span", { class: `heat heat--${r}` })),
      ),
      h("span", { text: "6th, then unranked" }),
    ),
  );
}

/** Re-renders can replace the focused button; put focus back on its replacement. */
function preserveFocus(render) {
  const key = document.activeElement?.dataset?.focusKey;
  render();
  if (key) document.querySelector(`[data-focus-key="${key}"]`)?.focus({ preventScroll: true });
}

// =============================================================================================
// Claim flow

const claimDialog = $("claim-dialog");
let claimingSlot = 0;
const claimChips = createChipInput($("claim-members"), {
  onError: (message) => showError(claimDialog, message),
});

function openClaim(slot) {
  claimingSlot = slot;
  $("claim-form").reset();
  claimChips.setValues([]);
  showError(claimDialog, "");
  $("claim-eyebrow").textContent = `Slot ${slot}`;
  $("claim-title").textContent = `Claim slot ${slot}`;
  claimDialog.showModal();
  $("claim-name").focus();
}

async function submitClaim(event) {
  event.preventDefault();
  const slot = claimingSlot;
  const details = readDetails(claimDialog, $("claim-name"), claimChips, $("claim-members-input"));
  if (!details) return;
  const pin = checkPin($("claim-pin").value);
  if ("error" in pin) return fieldError(claimDialog, pin.error, $("claim-pin"));
  if ($("claim-pin-confirm").value !== pin.value) {
    return fieldError(claimDialog, "The two PINs don't match.", $("claim-pin-confirm"));
  }

  await withBusy(event.submitter ?? claimDialog.querySelector("[type=submit]"), async () => {
    try {
      await api.claimSlot({ slot, groupName: details.groupName, members: details.members, pin: pin.value });
    } catch (err) {
      showError(claimDialog, messageFor(err));
      if (err.code === "NAME_TAKEN") $("claim-name").focus();
      if (err.code === "SLOT_TAKEN") refresh();
      return;
    }

    rememberPin(slot, pin.value);
    const card = document.querySelector(`[data-focus-key="claim-${slot}"]`);
    claimDialog.close();
    burstFrom(card);
    toast(`Slot ${slot} claimed. Next, use Manage to add your ranking.`, "success");
    await refresh();
    document.querySelector(`[data-focus-key="manage-${slot}"]`)?.focus();
  });
}

// =============================================================================================
// Manage flow: PIN → editor

const pinDialog = $("pin-dialog");
let pinSlot = 0;

async function manage(slot) {
  const remembered = recallPin(slot);
  if (remembered) {
    try {
      openEditor(await api.getMyGroup({ slot, pin: remembered }), remembered);
      return;
    } catch (err) {
      if (err.code !== "BAD_PIN") return handleGroupGone(err, slot);
      forgetPin(slot);
    }
  }

  pinSlot = slot;
  const group = state.board.slots[slot - 1];
  $("pin-form").reset();
  showError(pinDialog, "");
  $("pin-eyebrow").textContent = `Slot ${slot}`;
  $("pin-title").textContent = group.group_name ?? `Slot ${slot}`;
  pinDialog.showModal();
  $("pin-input").focus();
}

async function submitPin(event) {
  event.preventDefault();
  const slot = pinSlot;
  const pin = checkPin($("pin-input").value);
  // A PIN that can't be valid would still count as a failed attempt server-side.
  if ("error" in pin) return fieldError(pinDialog, "Incorrect PIN.", $("pin-input"));

  await withBusy(event.submitter ?? pinDialog.querySelector("[type=submit]"), async () => {
    let group;
    try {
      group = await api.getMyGroup({ slot, pin: pin.value });
    } catch (err) {
      if (err.code === "SLOT_EMPTY") {
        pinDialog.close();
        return handleGroupGone(err, slot);
      }
      fieldError(pinDialog, messageFor(err), $("pin-input"));
      $("pin-input").select();
      return;
    }
    rememberPin(slot, pin.value);
    pinDialog.close();
    openEditor(group, pin.value);
  });
}

/** Errors that mean the editor can no longer act on this slot. */
function handleGroupGone(err, slot) {
  if (err.code === "SLOT_EMPTY" || err.code === "BAD_PIN") forgetPin(slot);
  toast(messageFor(err), "error");
  if (err.code === "SLOT_EMPTY") refresh();
}

// =============================================================================================
// Editor

const editorDialog = $("editor-dialog");
const editor = { slot: 0, pin: "", frozen: false, submitted: false, opened: "", dirty: false };
const editorChips = createChipInput($("editor-members"), {
  onError: (message) => showError(editorDialog, message),
});
const rankList = createRankList($("rank-list"), {
  questions: QUESTIONS,
  announce,
  onChange: updateDirty,
});

function openEditor(group, pin) {
  // A double-click on Manage resolves two lookups; showModal() on an open dialog throws.
  if (editorDialog.open) return;
  // Unranked questions sit below the divider in id order. A new group starts with nothing ranked,
  // so an untouched default order can never be submitted by accident.
  const ranked = group.rankings ?? [];
  const order = [...ranked, ...QUESTION_IDS.filter((id) => !ranked.includes(id))];
  Object.assign(editor, {
    slot: group.slot,
    pin,
    frozen: state.board.revealed,
    dirty: false,
    submitted: group.rankings !== null,
  });

  $("editor-eyebrow").textContent = `Slot ${group.slot}`;
  $("editor-title").textContent = group.group_name;
  $("editor-name").value = group.group_name;
  editorChips.setValues(group.members);
  rankList.setOrder(order, group.notes ?? EMPTY_NOTES, ranked.length);
  editor.opened = rankingSnapshot();
  $("ranking-dirty").hidden = true;
  showError(editorDialog, "");
  applyFrozen();

  editorDialog.showModal();
  // Land on the group's name rather than the close button, so screen readers announce context.
  $("editor-title").focus();
  $("editor-body").scrollTop = 0;
}

function applyFrozen() {
  rankList.setLocked(editor.frozen);
  $("save-ranking").hidden = editor.frozen;
  $("release-slot").hidden = editor.frozen;
  $("ranking-help").hidden = editor.frozen;
  $("ranking-status").textContent = editor.frozen
    ? "All six groups have submitted — rankings are locked."
    : editor.submitted
      ? "Submitted. You can change your ranking and notes until all six groups have submitted."
      : "Not submitted yet. Add the questions you want to your ranking, most wanted first, then save.";
  $("release-hint").textContent = editor.frozen
    ? "Rankings are locked, so the slot can't be released. Ask the admin to reopen it."
    : "Frees this slot and deletes your group's details and ranking.";
}

const rankingSnapshot = () => JSON.stringify([rankList.getRanking(), rankList.getNotes()]);

function updateDirty() {
  editor.dirty = rankingSnapshot() !== editor.opened;
  $("ranking-dirty").hidden = !editor.dirty;
}

async function saveRanking(event) {
  const details = readDetails(editorDialog, $("editor-name"), editorChips, $("editor-members-input"));
  if (!details) return;
  const ranking = rankList.getRanking();
  if (ranking.length === 0) {
    showError(editorDialog, "Add at least one question to your ranking before saving.");
    return;
  }
  const notes = checkNotes(rankList.getNotes());
  if ("error" in notes) {
    showError(editorDialog, notes.error);
    rankList.focusNote(notes.questionId);
    return;
  }

  await withBusy(event.currentTarget, async () => {
    let revealed;
    try {
      ({ revealed } = await api.saveGroup({
        slot: editor.slot,
        pin: editor.pin,
        groupName: details.groupName,
        members: details.members,
        rankings: ranking,
        notes: notes.value,
      }));
    } catch (err) {
      return handleEditorError(err);
    }

    editorDialog.close();
    burstFrom(document.querySelector(`[data-focus-key="manage-${editor.slot}"]`));
    if (!revealed) toast("Ranking saved. It stays sealed until all six groups have submitted.", "success");
    await refresh();
  });
}

async function saveDetails(event) {
  event.preventDefault();
  const details = readDetails(editorDialog, $("editor-name"), editorChips, $("editor-members-input"));
  if (!details) return;

  await withBusy(event.submitter ?? $("details-form").querySelector("[type=submit]"), async () => {
    try {
      // null keeps the stored ranking, so fixing a typo never submits an unfinished ranking.
      await api.saveGroup({
        slot: editor.slot,
        pin: editor.pin,
        groupName: details.groupName,
        members: details.members,
        rankings: null,
        notes: null,
      });
    } catch (err) {
      return handleEditorError(err);
    }
    $("editor-title").textContent = details.groupName;
    showError(editorDialog, "");
    toast("Group details saved.", "success");
    refresh();
  });
}

async function releaseSlot() {
  const name = $("editor-title").textContent;
  const confirmed = await confirmAction({
    title: `Release slot ${editor.slot}?`,
    message: `This deletes ${name}'s registration and ranking. Anyone will be able to claim the slot.`,
    confirmLabel: "Release slot",
  });
  if (!confirmed) return;

  await withBusy($("release-slot"), async () => {
    try {
      await api.releaseSlot({ slot: editor.slot, pin: editor.pin });
    } catch (err) {
      return handleEditorError(err);
    }
    forgetPin(editor.slot);
    editorDialog.close();
    toast(`Slot ${editor.slot} released.`, "info");
    await refresh();
  });
}

function handleEditorError(err) {
  if (err.code === "BAD_PIN" || err.code === "SLOT_EMPTY") {
    editorDialog.close();
    return handleGroupGone(err, editor.slot);
  }
  if (err.code === "FROZEN") {
    editor.frozen = true;
    applyFrozen();
    refresh();
  }
  showError(editorDialog, messageFor(err));
  if (err.code === "NAME_TAKEN") $("editor-name").focus();
}

async function requestEditorClose() {
  if (editor.dirty) {
    const discard = await confirmAction({
      title: "Discard your changes?",
      message: "Your ranking or notes have changes that haven't been saved.",
      confirmLabel: "Discard",
    });
    if (!discard) return;
  }
  editorDialog.close();
}

// =============================================================================================
// Admin

const adminDialog = $("admin-dialog");

function openAdmin() {
  $("admin-form").reset();
  showError(adminDialog, "");
  $("admin-slot").replaceChildren(
    ...state.board.slots.map((s) =>
      h("option", { value: String(s.slot), text: `Slot ${s.slot} — ${s.group_name ?? "open"}` }),
    ),
  );
  adminDialog.showModal();
  $("admin-slot").focus();
}

async function submitAdmin(event) {
  event.preventDefault();
  const slot = Number($("admin-slot").value);
  const adminPin = $("admin-pin").value;
  // The contract doesn't fix a length for the admin PIN, so only reject the obviously empty.
  if (!adminPin) return fieldError(adminDialog, "Enter the admin PIN.", $("admin-pin"));

  const group = state.board.slots[slot - 1];
  const confirmed = await confirmAction({
    title: `Reset slot ${slot}?`,
    message: group.claimed
      ? `This deletes ${group.group_name}'s registration and ranking${state.board.revealed ? " and reopens rankings for everyone" : ""}.`
      : "This slot is already open; resetting it has no effect.",
    confirmLabel: "Reset slot",
  });
  if (!confirmed) return;

  await withBusy(event.submitter ?? adminDialog.querySelector("[type=submit]"), async () => {
    try {
      await api.adminResetSlot({ slot, adminPin });
    } catch (err) {
      return fieldError(adminDialog, messageFor(err), $("admin-pin"));
    }
    forgetPin(slot);
    adminDialog.close();
    toast(`Slot ${slot} has been reset.`, "info");
    await refresh();
  });
}

// =============================================================================================
// Shared UI helpers

/** Validates the group name + members pair used by both the claim form and the editor. */
function readDetails(dialog, nameInput, chips, membersInput) {
  if (!chips.commitPending()) return null;
  const name = checkGroupName(nameInput.value);
  if ("error" in name) return fieldError(dialog, name.error, nameInput);
  const members = checkMembers(chips.getValues());
  if ("error" in members) return fieldError(dialog, members.error, membersInput);
  showError(dialog, "");
  return { groupName: name.value, members: members.value };
}

function fieldError(dialog, message, field) {
  showError(dialog, message);
  field?.focus();
  return null;
}

function showError(dialog, message) {
  dialog.querySelector("[data-error]").textContent = message;
}

async function withBusy(button, task) {
  if (!button || button.disabled) return;
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  try {
    await task();
  } finally {
    button.disabled = false;
    button.removeAttribute("aria-busy");
  }
}

function confirmAction({ title, message, confirmLabel }) {
  const dialog = $("confirm-dialog");
  $("confirm-title").textContent = title;
  $("confirm-message").textContent = message;
  $("confirm-ok").textContent = confirmLabel;
  dialog.returnValue = "";
  dialog.showModal();
  // Every confirmation guards something destructive, so the safe choice gets default focus.
  dialog.querySelector("[data-close]").focus();
  return new Promise((resolve) => {
    dialog.addEventListener("close", () => resolve(dialog.returnValue === "confirm"), { once: true });
  });
}

function toast(message, kind = "info") {
  const el = h("div", { class: `toast toast--${kind}` }, h("span", { text: message }));
  $("toasts").append(el);
  setTimeout(() => {
    el.classList.add("is-leaving");
    el.addEventListener("animationend", () => el.remove(), { once: true });
    // Reduced motion disables the exit animation, so don't rely on animationend alone.
    setTimeout(() => el.remove(), 600);
  }, TOAST_MS);
}

function announce(message) {
  const region = $("announcer");
  region.textContent = "";
  // Clearing first lets screen readers repeat an identical message.
  requestAnimationFrame(() => {
    region.textContent = message;
  });
}

function burstFrom(element) {
  const box = element?.getBoundingClientRect();
  const x = box ? (box.left + box.width / 2) / window.innerWidth : 0.5;
  const y = box ? (box.top + box.height / 2) / window.innerHeight : 0.5;
  confetti({ x, y: Math.min(Math.max(y, 0.15), 0.9), spread: 90, count: 90 });
}

function messageFor(err) {
  if (err instanceof api.ApiError) return err.message;
  console.error(err);
  return api.ERROR_MESSAGES.UNEXPECTED;
}

// Storage can throw (private mode, blocked cookies), and every caller must work without it.
function rememberPin(slot, pin) {
  try {
    sessionStorage.setItem(pinKey(slot), pin);
  } catch {
    /* the rep will simply be asked for the PIN again */
  }
}
function recallPin(slot) {
  try {
    return sessionStorage.getItem(pinKey(slot));
  } catch {
    return null;
  }
}
function forgetPin(slot) {
  try {
    sessionStorage.removeItem(pinKey(slot));
  } catch {
    /* nothing stored, nothing to forget */
  }
}
function readLocal(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function writeLocal(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* celebration may repeat after a reload; harmless */
  }
}

// =============================================================================================
// Wiring

function wire() {
  for (const dialog of document.querySelectorAll("dialog")) {
    for (const button of dialog.querySelectorAll("[data-close]")) {
      button.addEventListener("click", () =>
        dialog === editorDialog ? requestEditorClose() : dialog.close(),
      );
    }
  }
  editorDialog.addEventListener("cancel", (event) => {
    if (!editor.dirty) return;
    event.preventDefault();
    requestEditorClose();
  });

  $("claim-form").addEventListener("submit", submitClaim);
  $("pin-form").addEventListener("submit", submitPin);
  $("details-form").addEventListener("submit", saveDetails);
  $("save-ranking").addEventListener("click", saveRanking);
  $("release-slot").addEventListener("click", releaseSlot);
  $("admin-link").addEventListener("click", openAdmin);
  $("admin-form").addEventListener("submit", submitAdmin);
  $("confirm-form").addEventListener("submit", (event) => {
    event.preventDefault();
    $("confirm-dialog").close("confirm");
  });

  window.addEventListener("focus", refresh);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") refresh();
  });
  setInterval(() => {
    if (document.visibilityState === "visible") refresh();
  }, REFRESH_MS);
}

function init() {
  hydrateIcons();
  renderTopics();
  wire();
  if (!api.isConfigured()) {
    $("setup-banner").hidden = false;
    state.loaded = true;
  }
  renderBoard();
  refresh();
}

init();
