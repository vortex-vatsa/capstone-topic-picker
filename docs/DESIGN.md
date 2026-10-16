# Design: Capstone Topic Picker

A single static page (GitHub Pages) where six MBA capstone groups each claim one slot, rank six
capstone questions, and get a deterministic, conflict-free assignment once everyone has submitted.

This file is the contract between the frontend and the backend. Both halves build against it.

## Decisions

| # | Decision | Why | Rejected alternative |
|---|----------|-----|----------------------|
| 1 | Static site on GitHub Pages + Supabase (free tier) as the database | GitHub Pages cannot store data; Supabase gives Postgres with an HTTP API and no server to run | Google Form + Sheet (no per-group edit control); claude.ai artifact (viewers may need Claude accounts) |
| 2 | Browser talks **only** to Postgres functions (RPC). The table has RLS on and zero grants to `anon` | The publishable key is public by design, so the database must enforce every rule itself | Direct table access with RLS policies (can't express "knows this group's PIN" cleanly) |
| 3 | Each group's rep sets a PIN at claim time; only a bcrypt hash is stored | No accounts or emails for 24 students; the PIN is the edit right | Supabase Auth magic links (setup friction, collects emails = PII) |
| 4 | 5 wrong PINs lock a slot for 10 minutes | A 6-char PIN is brute-forceable over HTTP without a limit | No limit |
| 5 | Auth failures **return** `{ok:false}` instead of raising | `raise exception` rolls back the transaction, which would also roll back the failed-attempt counter | Raising errors for everything |
| 6 | Rankings are sealed until all six groups submit, then frozen | Visible rankings invite tactical ranking; freezing stops last-minute gaming after the reveal | Live rankings |
| 7 | Assignment = brute force over all 720 permutations; minimise the worst rank any group gets, then the total rank; show **every** tied optimum | 6! is tiny, so exhaustive search is exact and explainable line by line. Showing ties hands the final call to humans | Hungarian algorithm (same answer for sum-only, harder to explain, hides ties) |
| 8 | No npm, no framework, no Supabase JS client: vanilla ES modules + `fetch` | Zero supply-chain surface, no build step, deploys by pushing files | supabase-js + React |
| 9 | All user text rendered with `textContent`, never `innerHTML` | Group names and member names are untrusted input (XSS) | — |
| 10 | Optional one-line note per question ("why we want this"), sealed and frozen together with rankings | When the allocation ties, groups can see each other's reasoning instead of arguing from scratch. Revealing notes early would leak preferences | No notes; free-text essay per group |
| 11 | Submission deadline is shown on the page from `config.js`, not enforced by the database | It's a social nudge; the admin can extend it by editing one line and pushing, without a migration | Server-enforced cutoff (needs an admin override path) |
| 12 | "Copy summary" button builds a plain-text result and copies it to the clipboard (Web Share sheet on phones) | Results get discussed in WhatsApp; no connector or API needed, nothing is sent automatically | WhatsApp API integration (needs a business account, sends on the user's behalf) |
| 13 | Groups rank as many questions as they like (1 to 6). Unranked questions all count as rank 7, i.e. "equally least wanted" | Owner wants flexibility; a group that only cares about its top two shouldn't have to invent an order for the rest. Rank 7 keeps the minimax objective meaningful: getting an unranked question is worse than getting any ranked one | Forcing a full order of all six |
| 14 | Visual direction: cherry burgundy tones, caramel for actions, one chocolate "flavour" colour per Lindt challenge (caramel, raspberry, pistachio), Marcellus + Hanken Grotesk self-hosted from Google Fonts | Chosen by the owner after reviewing chocolatier sites and references. Self-hosting keeps visitors' IP addresses away from Google (a German GDPR issue) and lets the CSP stay `'self'` | Black and gold; light cream; loading fonts from fonts.googleapis.com |

## Data model (owned by backend)

`public.groups`: one row per claimed slot.

| column | type | notes |
|---|---|---|
| `slot` | `smallint` PK | 1–6 |
| `group_name` | `text` not null | trimmed, 1–60 chars, unique case-insensitive |
| `members` | `text[]` not null | 1–8 entries, each trimmed 1–60 chars |
| `pin_hash` | `text` not null | `crypt(pin, gen_salt('bf'))` |
| `rankings` | `smallint[]` null | null = not submitted. Otherwise 1–6 distinct question ids in preference order: index 0 is the first choice. Questions not listed are unranked (decision 13) |
| `notes` | `text[]` not null default 6 empty strings | exactly 6 entries; `notes[q]` (1-based, = question id) is the optional note for question `q`; each trimmed, 0–140 chars |
| `failed_attempts` | `smallint` not null default 0 | |
| `locked_until` | `timestamptz` null | |
| `created_at`, `updated_at` | `timestamptz` | |

`public.app_settings`: single row holding `admin_pin_hash`, `admin_failed_attempts`, `admin_locked_until`.
The admin PIN is set by the project owner in the Supabase SQL editor, never in code.

Derived states:
- **submitted** = `rankings is not null`
- **revealed** = all six slots claimed **and** submitted
- **frozen** = revealed. While frozen, `save_group` cannot change rankings and `release_slot` is refused. Only `admin_reset_slot` reopens.

## API contract

Every call is:

```
POST {SUPABASE_URL}/rest/v1/rpc/{function_name}
apikey: {SUPABASE_PUBLISHABLE_KEY}
Authorization: Bearer {SUPABASE_PUBLISHABLE_KEY}
Content-Type: application/json

{ ...named parameters exactly as below... }
```

Every function returns HTTP 200 with a JSON object: `{ "ok": true, ... }` or `{ "ok": false, "error": "<CODE>" }`.
Any non-200 response is an unexpected server error; the UI shows a generic message.

### Error codes

| code | meaning | friendly message (frontend) |
|---|---|---|
| `INVALID_INPUT` | failed validation | "Please check the form — something is missing or too long." |
| `SLOT_TAKEN` | slot already claimed | "Another group just claimed this slot." |
| `NAME_TAKEN` | group name already used | "That group name is already taken." |
| `SLOT_EMPTY` | slot not claimed | "This slot is no longer registered." |
| `BAD_PIN` | wrong PIN (counts toward lockout) | "Incorrect PIN." |
| `LOCKED` | too many wrong PINs | "Too many attempts. Try again in 10 minutes." |
| `FROZEN` | all six submitted; rankings locked | "All groups have submitted — rankings are locked. Ask the admin to reopen." |
| `NOT_ADMIN` | wrong admin PIN (counts toward admin lockout) | "Incorrect admin PIN." |

### Functions

**`get_board()`** — public, no params.
```json
{ "ok": true,
  "revealed": false,
  "slots": [
    { "slot": 1, "claimed": true, "group_name": "Ganache", "members": ["A", "B"],
      "submitted": true, "updated_at": "2026-10-16T10:00:00Z", "rankings": null, "notes": null },
    { "slot": 2, "claimed": false, "group_name": null, "members": [],
      "submitted": false, "updated_at": null, "rankings": null, "notes": null }
  ] }
```
Always exactly 6 entries ordered by slot. `rankings` and `notes` are non-null only when `revealed` is true.
`notes` is a 6-element array indexed by question id (element 0 = question 1).

**`claim_slot(p_slot int, p_group_name text, p_members text[], p_pin text)`**
→ `{ok:true}` | `INVALID_INPUT` | `SLOT_TAKEN` | `NAME_TAKEN`.
PIN: 6–64 characters.

**`get_my_group(p_slot int, p_pin text)`**
→ `{ok:true, group:{slot, group_name, members, rankings, notes}}` (own rankings and notes always visible) | `SLOT_EMPTY` | `BAD_PIN` | `LOCKED`.

**`save_group(p_slot int, p_pin text, p_group_name text, p_members text[], p_rankings int[], p_notes text[])`**
`p_rankings` may be `null` (keep existing rankings) or 1–6 distinct question ids, each 1..6, in preference order.
`p_notes` may be `null` (keep existing notes) or exactly 6 strings, indexed by question id, each trimmed 0–140 chars.
→ `{ok:true, revealed:bool}` | `INVALID_INPUT` | `NAME_TAKEN` | `SLOT_EMPTY` | `BAD_PIN` | `LOCKED` | `FROZEN` (when trying to change rankings or notes while frozen; a name/members-only save is allowed).

**`release_slot(p_slot int, p_pin text)`** — deletes the group's row.
→ `{ok:true}` | `SLOT_EMPTY` | `BAD_PIN` | `LOCKED` | `FROZEN`.

**`admin_reset_slot(p_slot int, p_admin_pin text)`** — deletes that slot's row (also unfreezes).
→ `{ok:true}` | `INVALID_INPUT` | `NOT_ADMIN` | `LOCKED`.

Order of checks in PIN-protected functions: validate slot → slot exists (`SLOT_EMPTY`) → locked (`LOCKED`) →
PIN matches (else increment counter, lock at 5, `BAD_PIN`) → reset counter → validate body (`INVALID_INPUT`) →
business rules (`FROZEN`, `NAME_TAKEN`).

## Questions config (owned by frontend)

Question text lives in `js/config.js`, not the database. The database only knows question ids 1–6.

Each Lindt challenge is split into an analytical stream and an operational enabler. Question ids are the
professor's numbering, so they are not sequential within a topic.

```js
export const TOPICS = [
  { id: "A", title: "TCO and market analysis for e-trucks in logistics", questions: [
    { id: 1, stream: "Analytical stream",   title: "E-truck TCO & market" },
    { id: 6, stream: "Operational enabler", title: "Circular packaging & reverse logistics" } ] },
  { id: "B", title: "Using data and figures to optimise intercompany product portfolio management and internal product flows", questions: [
    { id: 2, stream: "Analytical stream",   title: "Portfolio & flow dashboard" },
    { id: 4, stream: "Operational enabler", title: "Cold chain quality & energy" } ] },
  { id: "C", title: "Optimising internal planning of product availability across locations and batch sizing using data and AI", questions: [
    { id: 3, stream: "Analytical stream",   title: "AI-enabled availability & batch sizing" },
    { id: 5, stream: "Operational enabler", title: "Digital twin of intralogistics" } ] },
];

// Display only (decision 11). ISO 8601 with offset; Aachen is UTC+1 from 25 Oct 2026.
export const SUBMISSION_DEADLINE = "REPLACE_ME";
```

Anywhere the UI lists questions in isolation (ranking list, heatmap, allocation), show them as
"Q1 · E-truck TCO & market" with the stream as a secondary label, ordered by question id.

## File ownership

| Path | Owner |
|---|---|
| `supabase/schema.sql`, `supabase/tests/` | backend |
| `index.html`, `css/`, `js/`, `tests/` | frontend |
| `docs/`, `README.md` | integrator |
