import { test } from "node:test";
import assert from "node:assert/strict";
import { assignQuestions } from "../js/assign.js";
import { buildSummary, headlineFor } from "../js/summary.js";

const label = (id) => `Q${id} · Title ${id}`;
const slots = [
  [1, 2, 3, 4, 6, 5],
  [2, 1, 3, 4, 5, 6],
  [3, 1, 2, 4, 5, 6],
  [4, 1, 2, 3, 5, 6],
  [5, 2, 3, 4, 1, 6],
  [5, 2, 3, 4, 1, 6],
].map((rankings, i) => ({ slot: i + 1, group_name: `Group ${i + 1}`, rankings }));

test("headline names the worst rank, or celebrates when everyone gets a first choice", () => {
  assert.equal(headlineFor({ worstRank: 1 }), "Every group gets its first choice.");
  assert.equal(headlineFor({ worstRank: 3 }), "No group gets worse than its 3rd choice.");
  assert.equal(
    headlineFor({ worstRank: 7 }),
    "At least one group has to take a question it didn't rank.",
  );
});

test("summary says 'unranked' instead of a 7th choice", () => {
  const partial = slots.map((s) => ({ ...s, rankings: [1] }));
  const text = buildSummary({ slots: partial, result: assignQuestions(partial), label, maxOptions: 1 });

  assert.match(text, /\(1st choice\)/);
  assert.equal(text.match(/\(unranked\)/g).length, 5);
  assert.doesNotMatch(text, /7th/);
});

test("summary lists every group once per option and labels ties as equally fair", () => {
  const result = assignQuestions(slots);
  const text = buildSummary({ slots, result, label, date: "16 October 2026", url: "https://example.test/" });

  assert.match(text, /^Lindt Capstone · Topic allocation · 16 October 2026\nNo group gets worse than its 5th choice\. Average choice 2\.0\./);
  assert.match(text, /Option 1 of 2 \(equally fair — agree on one together\):/);
  assert.match(text, /Option 2 of 2/);
  assert.equal(text.match(/^• Group 1 → Q6 · Title 6 \(5th choice\)$/gm).length, 2);
  assert.ok(text.endsWith("\nhttps://example.test/"));
});

test("summary caps the number of options and says how many were left out", () => {
  const same = [1, 2, 3, 4, 5, 6];
  const identical = slots.map((s) => ({ ...s, rankings: same }));
  const text = buildSummary({ slots: identical, result: assignQuestions(identical), label, maxOptions: 2 });

  assert.equal(text.match(/^Option \d+ of 720/gm).length, 2);
  assert.match(text, /\+ 718 more equally fair options on the page\.$/);
});
