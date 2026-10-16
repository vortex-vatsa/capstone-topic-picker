// Plain-text wording of an allocation result, shared by the page and the "Copy summary" button
// (decision 12). Pure: no DOM, so it can be tested under Node.

import { rankOf } from "./assign.js";
import { ordinal } from "./format.js";

const QUESTION_COUNT = 6;

/** "1st choice" … "6th choice", or "unranked" for rank 7 (decision 13). */
export function choiceLabel(rank, questionCount = QUESTION_COUNT) {
  return rank > questionCount ? "unranked" : `${ordinal(rank)} choice`;
}

/** @param {{ worstRank: number, totalRank: number, optima: object[] }} result */
export function headlineFor(result, questionCount = QUESTION_COUNT) {
  if (result.worstRank === 1) return "Every group gets its first choice.";
  if (result.worstRank > questionCount) {
    return "At least one group has to take a question it didn't rank.";
  }
  return `No group gets worse than its ${ordinal(result.worstRank)} choice.`;
}

export function averageRank(result, groupCount) {
  return (result.totalRank / groupCount).toFixed(1);
}

/**
 * @param {{
 *   slots: { slot: number, group_name: string, rankings: number[] }[],
 *   result: { worstRank: number, totalRank: number, optima: Record<number, number>[] },
 *   label: (questionId: number) => string,
 *   date?: string,
 *   maxOptions?: number,
 *   url?: string,
 * }} args  `date` is already formatted for the reader, e.g. "16 October 2026".
 */
export function buildSummary({ slots, result, label, date, maxOptions = 4, url }) {
  const count = result.optima.length;
  const lines = [
    date ? `Lindt Capstone · Topic allocation · ${date}` : "Lindt Capstone · Topic allocation",
    `${headlineFor(result)} Average choice ${averageRank(result, slots.length)}.`,
  ];

  result.optima.slice(0, maxOptions).forEach((option, index) => {
    lines.push(
      "",
      count === 1
        ? "Recommended allocation:"
        : `Option ${index + 1} of ${count} (equally fair — agree on one together):`,
    );
    for (const s of slots) {
      const questionId = option[s.slot];
      const rank = rankOf(s.rankings, questionId, slots.length);
      lines.push(`• ${s.group_name} → ${label(questionId)} (${choiceLabel(rank, slots.length)})`);
    }
  });

  if (count > maxOptions) {
    lines.push("", `+ ${count - maxOptions} more equally fair options on the page.`);
  }
  if (url) lines.push("", url);
  return lines.join("\n");
}
