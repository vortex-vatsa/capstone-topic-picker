// Exhaustive fair assignment of questions to groups.
//
// With six groups and six questions there are only 6! = 720 ways to hand out the questions, so we
// score every one of them instead of using a clever algorithm. That keeps the result exact and
// lets us return every tied optimum, so the humans make the final call rather than a tie-breaker
// hidden in code.
//
// Objective, compared lexicographically:
//   1. minimise the worst rank any group receives (nobody gets stuck with their last choice if
//      it can be avoided), then
//   2. minimise the sum of ranks (overall happiness).
//
// Groups may rank only some questions (decision 13). Every question a group left out counts as
// rank n + 1 (7 with six questions): all equally unwanted, and worse than any ranked question.

/**
 * @typedef {{ slot: number, group_name: string, rankings: number[] }} RankedGroup
 *   `rankings` lists 1..n distinct question ids, index 0 being the group's first choice.
 * @typedef {Record<number, number>} Assignment  slot → question id
 */

/**
 * The rank a group gave a question: its 1-based position, or `questionCount + 1` if unranked.
 * @param {number[]} rankings
 * @param {number} questionId
 * @param {number} questionCount
 */
export function rankOf(rankings, questionId, questionCount) {
  const index = rankings.indexOf(questionId);
  return index === -1 ? questionCount + 1 : index + 1;
}

/**
 * @param {RankedGroup[]} groups
 * @returns {{ worstRank: number, totalRank: number, optima: Assignment[] }}
 *   `optima` holds every assignment achieving the best score, ordered by slot-wise question ids
 *   (lexicographic), so the same input always produces the same list in the same order.
 */
export function assignQuestions(groups) {
  const ordered = validateGroups(groups);
  const n = ordered.length;
  const questionIds = Array.from({ length: n }, (_, i) => i + 1);
  // ranks[g][q] is the rank group g gave question q, precomputed once for the 720 × 6 lookups.
  const ranks = ordered.map((g) => [0, ...questionIds.map((q) => rankOf(g.rankings, q, n))]);

  let best = { worstRank: Infinity, totalRank: Infinity };
  let optima = [];

  for (const perm of permutations(questionIds)) {
    let worst = 0;
    let total = 0;
    for (let g = 0; g < perm.length; g++) {
      const rank = ranks[g][perm[g]];
      if (rank > worst) worst = rank;
      total += rank;
    }

    const better =
      worst < best.worstRank || (worst === best.worstRank && total < best.totalRank);
    const tied = worst === best.worstRank && total === best.totalRank;

    if (better) {
      best = { worstRank: worst, totalRank: total };
      optima = [perm];
    } else if (tied) {
      optima.push(perm);
    }
  }

  return {
    worstRank: best.worstRank,
    totalRank: best.totalRank,
    optima: optima.map((perm) => Object.fromEntries(perm.map((q, g) => [ordered[g].slot, q]))),
  };
}

/**
 * Score one assignment with the same objective `assignQuestions` optimises.
 * @param {RankedGroup[]} groups
 * @param {Assignment} assignment
 */
export function scoreAssignment(groups, assignment) {
  const ordered = validateGroups(groups);
  const n = ordered.length;
  const ranks = ordered.map((g) => {
    const questionId = assignment[g.slot];
    if (!Number.isInteger(questionId) || questionId < 1 || questionId > n) {
      throw new RangeError(`slot ${g.slot} has no valid question in the assignment`);
    }
    return rankOf(g.rankings, questionId, n);
  });
  return { worstRank: Math.max(...ranks), totalRank: ranks.reduce((a, b) => a + b, 0) };
}

/** Yields every permutation of `items` in lexicographic order of positions. */
function* permutations(items) {
  const used = new Array(items.length).fill(false);
  const current = [];

  function* extend() {
    if (current.length === items.length) {
      yield [...current];
      return;
    }
    for (let i = 0; i < items.length; i++) {
      if (used[i]) continue;
      used[i] = true;
      current.push(items[i]);
      yield* extend();
      current.pop();
      used[i] = false;
    }
  }

  yield* extend();
}

// The board comes from the network, so a malformed ranking must fail loudly here rather than
// silently produce a wrong allocation.
function validateGroups(groups) {
  if (!Array.isArray(groups) || groups.length === 0) {
    throw new TypeError("groups must be a non-empty array");
  }
  const n = groups.length;
  const slots = new Set();
  for (const g of groups) {
    if (!Number.isInteger(g?.slot) || slots.has(g.slot)) {
      throw new TypeError("every group needs a unique integer slot");
    }
    slots.add(g.slot);
    if (!isPartialRanking(g.rankings, n)) {
      throw new TypeError(`slot ${g.slot}: rankings must be 1–${n} distinct question ids in 1..${n}`);
    }
  }
  return [...groups].sort((a, b) => a.slot - b.slot);
}

function isPartialRanking(values, n) {
  if (!Array.isArray(values) || values.length < 1 || values.length > n) return false;
  return (
    new Set(values).size === values.length &&
    values.every((v) => Number.isInteger(v) && v >= 1 && v <= n)
  );
}
