// Client-side mirror of the limits in docs/DESIGN.md. The database enforces them again; these
// exist so people get a helpful message before a round trip, not as a security boundary.

export const SLOT_COUNT = 6;

export const LIMITS = Object.freeze({
  nameMax: 60,
  membersMin: 1,
  membersMax: 8,
  pinMin: 6,
  pinMax: 64,
  noteMax: 140,
});

// Postgres char_length counts code points; String#length counts UTF-16 units, which would
// disagree for emoji and some names.
export const charLength = (s) => [...s].length;

/** @returns {{ value: string } | { error: string }} */
export function checkGroupName(raw) {
  const value = String(raw ?? "").trim();
  if (!value) return { error: "Give your group a name." };
  if (charLength(value) > LIMITS.nameMax) {
    return { error: `Group name must be at most ${LIMITS.nameMax} characters.` };
  }
  return { value };
}

/** @returns {{ value: string } | { error: string }} */
export function checkMemberName(raw) {
  const value = String(raw ?? "").trim();
  if (!value) return { error: "Member name can't be empty." };
  if (charLength(value) > LIMITS.nameMax) {
    return { error: `Each name must be at most ${LIMITS.nameMax} characters.` };
  }
  return { value };
}

/** @returns {{ value: string[] } | { error: string }} */
export function checkMembers(list) {
  if (list.length < LIMITS.membersMin) return { error: "Add at least one member." };
  if (list.length > LIMITS.membersMax) {
    return { error: `A group can list at most ${LIMITS.membersMax} members.` };
  }
  const value = [];
  for (const raw of list) {
    const checked = checkMemberName(raw);
    if ("error" in checked) return checked;
    value.push(checked.value);
  }
  return { value };
}

// PINs are not trimmed: the server hashes exactly what it receives, and silently altering a
// secret would make it impossible to type the same one again later.
/** @returns {{ value: string } | { error: string }} */
export function checkPin(raw) {
  const value = String(raw ?? "");
  const length = charLength(value);
  if (length < LIMITS.pinMin) return { error: `PIN must be at least ${LIMITS.pinMin} characters.` };
  if (length > LIMITS.pinMax) return { error: `PIN must be at most ${LIMITS.pinMax} characters.` };
  return { value };
}

/**
 * @param {string[]} raw  one note per question, index 0 = question 1
 * @returns {{ value: string[] } | { error: string, questionId: number }}
 */
export function checkNotes(raw) {
  const value = raw.map((note) => String(note ?? "").trim());
  const tooLong = value.findIndex((note) => charLength(note) > LIMITS.noteMax);
  if (tooLong !== -1) {
    return {
      error: `Notes must be at most ${LIMITS.noteMax} characters (Q${tooLong + 1}).`,
      questionId: tooLong + 1,
    };
  }
  return { value };
}

export function isNotesArray(values) {
  return (
    Array.isArray(values) &&
    values.length === SLOT_COUNT &&
    values.every((v) => typeof v === "string")
  );
}

/** Decision 13: a ranking lists 1–6 distinct question ids; anything left out is unranked. */
export function isValidRanking(values) {
  if (!Array.isArray(values) || values.length < 1 || values.length > SLOT_COUNT) return false;
  return (
    new Set(values).size === values.length &&
    values.every((v) => Number.isInteger(v) && v >= 1 && v <= SLOT_COUNT)
  );
}
