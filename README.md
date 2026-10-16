# Capstone Topic Picker

Six MBA capstone groups, six Lindt capstone questions, one question per group. This page lets each
group's representative claim a slot, rank the questions they want, and, once all six groups have
submitted, see a conflict-free allocation that everyone can check.

It exists so that 24 people don't settle this in a WhatsApp thread. Rankings stay sealed until
everyone has submitted, so no group can rank tactically, and the allocation is computed the same
way for everyone, so nobody has to trust whoever ran the spreadsheet.

## How it works

- **Claim.** One rep per group claims one of six slots, adds the member names and sets a PIN.
  Only that PIN can edit, rank for or release the slot.
- **Rank.** Drag questions into order, or use the arrow and add/remove buttons. A group ranks 1 to
  6 questions; anything unranked counts as "equally least wanted". An optional one-line note per
  question explains why the group wants it.
- **Reveal.** When all six groups have submitted, the rankings unlock and freeze. The page
  checks all 720 possible allocations and picks the ones where **the worst-off group is as happy
  as possible**, then the best total. If several allocations tie, it shows all of them and leaves
  the choice to the groups.

The interesting decision is the allocation rule: exhaustive search over 6! permutations,
minimising the worst rank before the total. See [`js/assign.js`](js/assign.js) and
decision 7 in [`docs/DESIGN.md`](docs/DESIGN.md).

## Architecture

```
GitHub Pages (static HTML/CSS/JS, no build)  ──fetch──▶  Supabase Postgres
                                                          └─ 6 SECURITY DEFINER RPC functions
                                                             (the table itself is locked)
```

- **No server, no framework, no npm.** Vanilla ES modules in `js/`, one stylesheet, self-hosted
  fonts in `fonts/`.
- **The browser only calls Postgres functions.** The publishable key in `js/config.js` is public
  by design; the tables have RLS on and no grants, so every rule (PIN checks, lockout, sealing,
  freezing, validation) is enforced in [`supabase/schema.sql`](supabase/schema.sql).
- **PINs are bcrypt-hashed.** Five wrong PINs lock a slot for 10 minutes. An admin PIN, set in the
  Supabase SQL editor and never stored in code, can reset any slot.
- **Untrusted text is never parsed as HTML.** Group and member names go through `textContent`
  only (`js/dom.js`), and a strict Content-Security-Policy allows scripts, styles and fonts only
  from this origin.

Every decision, with the alternative that was rejected, is in [`docs/DESIGN.md`](docs/DESIGN.md).

## Run it locally

ES modules need a web server (opening `index.html` as a file won't work):

```bash
python3 -m http.server 8765
```

Then open <http://localhost:8765>. It talks to the Supabase project configured in `js/config.js`.

## Test it

```bash
node --test tests/
```

This covers the allocation algorithm (conflicts, minimax beating min-sum, partial rankings,
ties, determinism) and the plain-text summary.

The database tests run in the Supabase SQL editor: paste [`supabase/tests/rpc_test.sql`](supabase/tests/rpc_test.sql)
and run it. Everything happens inside a transaction that is rolled back, and a clean run returns
`ALL TESTS PASSED`.

## Set it up from scratch

1. Create a free Supabase project. In **SQL Editor**, run `supabase/schema.sql`, then the tests.
2. Set an admin PIN with the statement at the end of `schema.sql` (type your own PIN; don't commit it).
3. Put the project URL and **publishable** key in `js/config.js`, never the secret or service-role key.
   Edit `TOPICS` and `SUBMISSION_DEADLINE` there too.
4. Push the folder to a GitHub repository and enable **Settings → Pages → Deploy from a branch**
   (`main`, root).

## Known limits

- The deadline is shown, not enforced; late submissions are accepted until all six are in.
- Anyone with the link can claim an empty slot. The admin reset is the remedy, which is fine for
  a known group of 24 and not for a public tool.
- Supabase's free tier pauses a project after about a week without traffic; it wakes from the
  dashboard.
