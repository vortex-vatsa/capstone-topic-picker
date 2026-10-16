// The only module that talks to the network. Every call is a Supabase RPC (docs/DESIGN.md,
// "API contract"); responses are validated here so the rest of the app can trust their shape.

import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from "./config.js";
import { SLOT_COUNT, isNotesArray, isValidRanking } from "./validate.js";

const TIMEOUT_MS = 10_000;
const PLACEHOLDER = "REPLACE_ME";

export const ERROR_MESSAGES = Object.freeze({
  INVALID_INPUT: "Please check the form — something is missing or too long.",
  SLOT_TAKEN: "Another group just claimed this slot.",
  NAME_TAKEN: "That group name is already taken.",
  SLOT_EMPTY: "This slot is no longer registered.",
  BAD_PIN: "Incorrect PIN.",
  LOCKED: "Too many attempts. Try again in 10 minutes.",
  FROZEN: "All groups have submitted — rankings are locked. Ask the admin to reopen.",
  NOT_ADMIN: "Incorrect admin PIN.",
  // Client-side codes, never sent by the server.
  NOT_CONFIGURED: "This page isn't connected to its database yet.",
  NETWORK: "Couldn't reach the server. Check your connection and try again.",
  UNEXPECTED: "Something went wrong. Please try again in a moment.",
});

export class ApiError extends Error {
  /** @param {string} code  one of the keys of ERROR_MESSAGES */
  constructor(code) {
    const known = Object.hasOwn(ERROR_MESSAGES, code) ? code : "UNEXPECTED";
    super(ERROR_MESSAGES[known]);
    this.name = "ApiError";
    this.code = known;
  }
}

export function isConfigured() {
  if (SUPABASE_PUBLISHABLE_KEY === PLACEHOLDER || !SUPABASE_PUBLISHABLE_KEY) return false;
  try {
    return ["https:", "http:"].includes(new URL(SUPABASE_URL).protocol);
  } catch {
    return false;
  }
}

async function rpc(functionName, params = {}) {
  if (!isConfigured()) throw new ApiError("NOT_CONFIGURED");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const url = `${SUPABASE_URL.replace(/\/+$/, "")}/rest/v1/rpc/${functionName}`;

  let body;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        apikey: SUPABASE_PUBLISHABLE_KEY,
        Authorization: `Bearer ${SUPABASE_PUBLISHABLE_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(params),
      signal: controller.signal,
      cache: "no-store",
      credentials: "omit",
    });
    if (!response.ok) {
      // Status only: the body could echo request details we don't want in the console.
      console.error(`[api] ${functionName} returned HTTP ${response.status}`);
      throw new ApiError("UNEXPECTED");
    }
    body = await response.json();
  } catch (err) {
    if (err instanceof ApiError) throw err;
    const reason = err?.name === "AbortError" ? "timed out" : "failed";
    console.error(`[api] ${functionName} ${reason}`, err?.name);
    throw new ApiError(err instanceof SyntaxError ? "UNEXPECTED" : "NETWORK");
  } finally {
    clearTimeout(timer);
  }

  if (body?.ok === true) return body;
  if (body?.ok === false && typeof body.error === "string") throw new ApiError(body.error);
  console.error(`[api] ${functionName} returned an unrecognised body`);
  throw new ApiError("UNEXPECTED");
}

// ---------------------------------------------------------------------------------------------
// Public functions: one per RPC.

/**
 * @typedef {{ slot: number, claimed: boolean, group_name: string | null, members: string[],
 *             submitted: boolean, updated_at: string | null, rankings: number[] | null,
 *             notes: string[] | null }} Slot
 *   `notes[q - 1]` is the group's note for question q; null until the reveal, like rankings.
 * @typedef {{ revealed: boolean, slots: Slot[] }} Board
 * @returns {Promise<Board>}
 */
export async function getBoard() {
  return parseBoard(await rpc("get_board"));
}

export async function claimSlot({ slot, groupName, members, pin }) {
  await rpc("claim_slot", {
    p_slot: slot,
    p_group_name: groupName,
    p_members: members,
    p_pin: pin,
  });
}

/**
 * @returns {Promise<{ slot: number, group_name: string, members: string[],
 *                     rankings: number[] | null, notes: string[] }>}
 */
export async function getMyGroup({ slot, pin }) {
  const { group } = await rpc("get_my_group", { p_slot: slot, p_pin: pin });
  expect(isObject(group) && group.slot === slot, "get_my_group: slot");
  expect(typeof group.group_name === "string", "get_my_group: group_name");
  expect(isStringArray(group.members), "get_my_group: members");
  expect(group.rankings === null || isValidRanking(group.rankings), "get_my_group: rankings");
  expect(isNotesArray(group.notes), "get_my_group: notes");
  return {
    slot: group.slot,
    group_name: group.group_name,
    members: [...group.members],
    rankings: group.rankings && [...group.rankings],
    notes: [...group.notes],
  };
}

/**
 * @param {{ rankings: number[] | null, notes: string[] | null }} args
 *   null keeps the stored value unchanged. Both keys are always sent: the RPC has no defaults.
 * @returns {Promise<{ revealed: boolean }>}
 */
export async function saveGroup({ slot, pin, groupName, members, rankings, notes }) {
  const body = await rpc("save_group", {
    p_slot: slot,
    p_pin: pin,
    p_group_name: groupName,
    p_members: members,
    p_rankings: rankings,
    p_notes: notes,
  });
  expect(typeof body.revealed === "boolean", "save_group: revealed");
  return { revealed: body.revealed };
}

export async function releaseSlot({ slot, pin }) {
  await rpc("release_slot", { p_slot: slot, p_pin: pin });
}

export async function adminResetSlot({ slot, adminPin }) {
  await rpc("admin_reset_slot", { p_slot: slot, p_admin_pin: adminPin });
}

// ---------------------------------------------------------------------------------------------
// Response validation.

function parseBoard(body) {
  const { revealed, slots } = body;
  expect(typeof revealed === "boolean", "get_board: revealed");
  expect(Array.isArray(slots) && slots.length === SLOT_COUNT, "get_board: slots");

  const parsed = slots.map((s, i) => parseSlot(s, i + 1, revealed));
  if (revealed) {
    expect(
      parsed.every((s) => s.claimed && s.submitted && s.rankings && s.notes),
      "get_board: revealed board must be complete",
    );
  }
  return { revealed, slots: parsed };
}

function parseSlot(s, expectedSlot, revealed) {
  expect(isObject(s) && s.slot === expectedSlot, "get_board: slot order");
  expect(typeof s.claimed === "boolean" && typeof s.submitted === "boolean", "get_board: flags");

  if (!s.claimed) {
    return {
      slot: expectedSlot,
      claimed: false,
      group_name: null,
      members: [],
      submitted: false,
      updated_at: null,
      rankings: null,
      notes: null,
    };
  }

  expect(typeof s.group_name === "string", "get_board: group_name");
  expect(isStringArray(s.members), "get_board: members");
  expect(s.updated_at === null || typeof s.updated_at === "string", "get_board: updated_at");
  expect(s.rankings === null || isValidRanking(s.rankings), "get_board: rankings");
  expect(s.notes == null || isNotesArray(s.notes), "get_board: notes");

  return {
    slot: expectedSlot,
    claimed: true,
    group_name: s.group_name,
    members: [...s.members],
    submitted: s.submitted,
    updated_at: s.updated_at,
    // Sealed until reveal; drop anything that arrives early rather than show it.
    rankings: revealed && s.rankings ? [...s.rankings] : null,
    notes: revealed && s.notes ? [...s.notes] : null,
  };
}

function expect(condition, what) {
  if (!condition) {
    console.error(`[api] malformed response (${what})`);
    throw new ApiError("UNEXPECTED");
  }
}

const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const isStringArray = (v) => Array.isArray(v) && v.every((x) => typeof x === "string");
