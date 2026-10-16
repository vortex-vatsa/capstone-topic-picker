import { test } from "node:test";
import assert from "node:assert/strict";
import { assignQuestions, scoreAssignment } from "../js/assign.js";

const groups = (...rankingLists) =>
  rankingLists.map((rankings, i) => ({ slot: i + 1, group_name: `Group ${i + 1}`, rankings }));

test("everyone gets their first choice when first choices differ", () => {
  const input = groups(
    [3, 1, 2, 4, 5, 6],
    [1, 2, 3, 4, 5, 6],
    [6, 5, 4, 3, 2, 1],
    [2, 1, 3, 4, 5, 6],
    [5, 1, 2, 3, 4, 6],
    [4, 1, 2, 3, 5, 6],
  );

  const result = assignQuestions(input);

  assert.equal(result.worstRank, 1);
  assert.equal(result.totalRank, 6);
  assert.deepEqual(result.optima, [{ 1: 3, 2: 1, 3: 6, 4: 2, 5: 5, 6: 4 }]);
});

test("unanimous first choice: the conflict is settled by second choices", () => {
  // Everybody wants Q1. Second choices are all different except slots 1 and 6, who both want Q2,
  // so one of those two must take Q1 and everyone else takes their second choice.
  const input = groups(
    [1, 2, 3, 4, 5, 6],
    [1, 3, 2, 4, 5, 6],
    [1, 4, 2, 3, 5, 6],
    [1, 5, 2, 3, 4, 6],
    [1, 6, 2, 3, 4, 5],
    [1, 2, 3, 4, 5, 6],
  );

  const result = assignQuestions(input);

  assert.equal(result.worstRank, 2);
  assert.equal(result.totalRank, 1 + 2 * 5);
  assert.deepEqual(result.optima, [
    { 1: 1, 2: 3, 3: 4, 4: 5, 5: 6, 6: 2 },
    { 1: 2, 2: 3, 3: 4, 4: 5, 5: 6, 6: 1 },
  ]);
});

test("identical rankings: every one of the 720 assignments is equally fair", () => {
  const same = [1, 2, 3, 4, 5, 6];
  const result = assignQuestions(groups(same, same, same, same, same, same));

  assert.equal(result.worstRank, 6);
  assert.equal(result.totalRank, 21);
  assert.equal(result.optima.length, 720);
  assert.equal(new Set(result.optima.map((o) => JSON.stringify(o))).size, 720);
});

test("minimax beats pure sum: nobody is left with their last choice when avoidable", () => {
  // Nobody wants Q6: slots 2–6 rank it last and slot 1 ranks it fifth. Slots 5 and 6 both want Q5.
  // Minimising the total alone would give one of slots 5/6 their last choice (total 11).
  // Minimax instead sends Q6 to slot 1 (its 5th choice) and pays for it with a higher total.
  const input = groups(
    [1, 2, 3, 4, 6, 5],
    [2, 1, 3, 4, 5, 6],
    [3, 1, 2, 4, 5, 6],
    [4, 1, 2, 3, 5, 6],
    [5, 2, 3, 4, 1, 6],
    [5, 2, 3, 4, 1, 6],
  );

  const sumOnlyWinner = { 1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6 };
  assert.deepEqual(scoreAssignment(input, sumOnlyWinner), { worstRank: 6, totalRank: 11 });

  const result = assignQuestions(input);

  assert.equal(result.worstRank, 5);
  assert.equal(result.totalRank, 12);
  assert.ok(result.totalRank > scoreAssignment(input, sumOnlyWinner).totalRank);
  for (const option of result.optima) {
    assert.equal(option[1], 6, "slot 1 is the only group that doesn't rank Q6 last");
  }
});

test("ties are all returned, in a stable order", () => {
  // Slots 5 and 6 are interchangeable in the previous scenario, so there are exactly two optima.
  const input = groups(
    [1, 2, 3, 4, 6, 5],
    [2, 1, 3, 4, 5, 6],
    [3, 1, 2, 4, 5, 6],
    [4, 1, 2, 3, 5, 6],
    [5, 2, 3, 4, 1, 6],
    [5, 2, 3, 4, 1, 6],
  );

  const { optima } = assignQuestions(input);

  assert.deepEqual(optima, [
    { 1: 6, 2: 1, 3: 3, 4: 4, 5: 2, 6: 5 },
    { 1: 6, 2: 1, 3: 3, 4: 4, 5: 5, 6: 2 },
  ]);
});

test("deterministic regardless of input order", () => {
  const input = groups(
    [2, 1, 3, 4, 5, 6],
    [2, 1, 4, 3, 5, 6],
    [1, 2, 3, 4, 5, 6],
    [3, 4, 1, 2, 6, 5],
    [6, 5, 4, 3, 2, 1],
    [6, 5, 4, 3, 1, 2],
  );

  const first = assignQuestions(input);
  const shuffled = assignQuestions([input[4], input[1], input[5], input[0], input[3], input[2]]);
  const again = assignQuestions(input);

  assert.deepEqual(shuffled, first);
  assert.deepEqual(again, first);
});

test("partial rankings: a group gets the one question it ranked when nobody else wants it", () => {
  const result = assignQuestions(groups([3], [1, 2], [2, 1], [4], [5, 6], [6, 5]));

  assert.equal(result.worstRank, 1);
  assert.deepEqual(result.optima, [{ 1: 3, 2: 1, 3: 2, 4: 4, 5: 5, 6: 6 }]);
});

test("an unranked question counts as rank 7, worse than anyone's last ranked choice", () => {
  // Slots 1–5 each rank only their own question; slot 6 ranks everything, Q6 last. Someone must
  // take Q6: slot 6 at rank 6 beats any other slot at rank 7 (unranked).
  const input = groups([1], [2], [3], [4], [5], [1, 2, 3, 4, 5, 6]);

  const result = assignQuestions(input);

  assert.equal(result.worstRank, 6);
  assert.equal(result.totalRank, 5 + 6);
  assert.deepEqual(result.optima, [{ 1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6 }]);
  assert.deepEqual(scoreAssignment(input, { 1: 6, 2: 2, 3: 3, 4: 4, 5: 5, 6: 1 }), {
    worstRank: 7,
    totalRank: 7 + 4 + 1,
  });
});

test("unranked questions are interchangeable, so they tie", () => {
  // Every group ranks only Q1: whoever gets it, everyone else is unranked. All 720 tie.
  const result = assignQuestions(groups([1], [1], [1], [1], [1], [1]));

  assert.equal(result.worstRank, 7);
  assert.equal(result.totalRank, 1 + 7 * 5);
  assert.equal(result.optima.length, 720);
});

test("rejects malformed rankings", () => {
  const valid = [1, 2, 3, 4, 5, 6];
  const withLast = (last) => groups(valid, valid, valid, valid, valid, last);
  assert.throws(() => assignQuestions(withLast([1, 1, 2])), TypeError, "duplicates");
  assert.throws(() => assignQuestions(withLast([])), TypeError, "empty");
  assert.throws(() => assignQuestions(withLast([0, 7])), TypeError, "out of range");
  assert.throws(() => assignQuestions(withLast([1, 2, 3, 4, 5, 6, 1])), TypeError, "too long");
  assert.throws(() => assignQuestions([]), TypeError);
});
