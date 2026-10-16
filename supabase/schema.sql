-- Capstone Topic Picker: database schema and RPC API.
--
-- Paste into the Supabase SQL Editor and run. Safe to run again, including over a database built
-- by an earlier version: tables and indexes are created only if missing, functions are replaced
-- in place, grants are re-applied. Existing tables are not rebuilt; the only schema upgrade is
-- the `notes` column and its CHECK, added explicitly below. Rule changes inside a validation
-- helper reach the existing CHECK constraints through `create or replace`, but existing rows are
-- not re-checked, so a helper may only ever be loosened (see normalize_rankings).
--
-- The contract this implements is docs/DESIGN.md.
--
-- Security model: the browser holds the publishable (anon) key, which is public by design, so
-- anyone can call the API with it. The tables therefore grant nothing to anon/authenticated and
-- have RLS on with no policies. The only way in is six SECURITY DEFINER functions that run as
-- the table owner and enforce every rule themselves. Their helpers live in the `private` schema,
-- which the Data API does not expose and anon cannot use.

create extension if not exists pgcrypto with schema extensions;

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;


-- ---------------------------------------------------------------------------------------------
-- Validation helpers
--
-- Each returns the normalized value, or null when the input is invalid. The table CHECK
-- constraints and the RPC functions both call them, so the API and the table can never disagree
-- about what is valid.
-- ---------------------------------------------------------------------------------------------

-- One definition of "whitespace" for every user-typed field.
create or replace function private.trim_whitespace(p_text text)
returns text
language sql
immutable
set search_path = ''
as $$
  select btrim(p_text, E' \t\r\n')
$$;

create or replace function private.normalize_name(p_name text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when char_length(private.trim_whitespace(p_name)) between 1 and 60
    then private.trim_whitespace(p_name)
  end
$$;

create or replace function private.normalize_members(p_members text[])
returns text[]
language sql
immutable
set search_path = ''
as $$
  select case
    when array_ndims(p_members) is distinct from 1
      or cardinality(p_members) not between 1 and 8
      or exists (
        select 1
        from unnest(p_members) as m(member_name)
        where private.normalize_name(m.member_name) is null
      )
    then null
    else array(
      select private.normalize_name(m.member_name)
      from unnest(p_members) with ordinality as m(member_name, ord)
      order by m.ord
    )
  end
$$;

-- A group ranks as many questions as it likes, best first; unlisted questions are unranked.
--
-- This rule was loosened from "a full permutation of 1..6". groups_rankings_valid calls this
-- helper, so replacing it changes the constraint for every future write, while rows already stored
-- are never re-checked. That is safe only because every old value (a permutation) is still valid.
-- If this rule is ever tightened instead, existing rows must be migrated and the constraint
-- re-validated by hand.
create or replace function private.normalize_rankings(p_rankings int[])
returns smallint[]
language sql
immutable
set search_path = ''
as $$
  select case
    when array_ndims(p_rankings) = 1
      and cardinality(p_rankings) between 1 and 6
      and not exists (
        select 1
        from unnest(p_rankings) as r(question_id)
        where r.question_id is null or r.question_id not between 1 and 6
      )
      and (select count(distinct r.question_id) from unnest(p_rankings) as r(question_id))
          = cardinality(p_rankings)
    then array(
      select r.question_id::smallint
      from unnest(p_rankings) with ordinality as r(question_id, ord)
      order by r.ord
    )
  end
$$;

-- Notes are positional, not a list: notes[q] belongs to question q, so there are always exactly
-- six, and "no note" is an empty string rather than a missing element.
create or replace function private.normalize_notes(p_notes text[])
returns text[]
language sql
immutable
set search_path = ''
as $$
  select case
    when array_ndims(p_notes) is distinct from 1
      or cardinality(p_notes) <> 6
      or exists (
        select 1
        from unnest(p_notes) as n(note)
        where n.note is null or char_length(private.trim_whitespace(n.note)) > 140
      )
    then null
    else array(
      select private.trim_whitespace(n.note)
      from unnest(p_notes) with ordinality as n(note, ord)
      order by n.ord
    )
  end
$$;


-- ---------------------------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------------------------

create table if not exists public.groups (
  slot            smallint    primary key check (slot between 1 and 6),
  group_name      text        not null,
  members         text[]      not null,
  -- A bcrypt prefix check means a plaintext PIN can never be stored by mistake.
  pin_hash        text        not null check (pin_hash like '$2_$%'),
  rankings        smallint[],
  notes           text[]      not null default array_fill(''::text, array[6]),
  failed_attempts smallint    not null default 0 check (failed_attempts >= 0),
  locked_until    timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  -- Stored values must already be in normalized form. This is the backstop if a future function
  -- forgets to validate; "is not distinct from" makes an invalid (null-normalizing) value fail
  -- instead of slipping through as a null CHECK result.
  constraint groups_group_name_valid
    check (private.normalize_name(group_name) is not distinct from group_name),
  constraint groups_members_valid
    check (private.normalize_members(members) is not distinct from members),
  constraint groups_rankings_valid
    check (private.normalize_rankings(rankings::int[]) is not distinct from rankings)
);

-- notes arrived after the first version of this script. "create table if not exists" leaves an
-- existing table alone, so add the column and its constraint here, where re-running the script
-- also upgrades a database built by the older version.
alter table public.groups
  add column if not exists notes text[] not null default array_fill(''::text, array[6]);
alter table public.groups drop constraint if exists groups_notes_valid;
alter table public.groups add constraint groups_notes_valid
  check (private.normalize_notes(notes) is not distinct from notes);

-- Uniqueness lives in an index, not in a lookup before insert, so two groups picking the same
-- name at the same moment cannot both succeed.
create unique index if not exists groups_group_name_ci_key
  on public.groups (lower(group_name));

-- Exactly one row: the boolean primary key can only ever be true.
-- No row exists until the owner sets an admin PIN (see the end of this file).
create table if not exists public.app_settings (
  id                    boolean  primary key default true check (id),
  admin_pin_hash        text     not null check (admin_pin_hash like '$2_$%'),
  admin_failed_attempts smallint not null default 0 check (admin_failed_attempts >= 0),
  admin_locked_until    timestamptz
);

-- RLS with no policies denies every role except the table owner. It is a second lock behind the
-- revoked grants: if a grant ever slips back in, the rows still stay invisible.
alter table public.groups enable row level security;
alter table public.app_settings enable row level security;

-- Supabase's default privileges grant anon/authenticated full access to new tables in public;
-- take all of it back. (service_role keeps access, which is what the dashboard uses.)
revoke all on table public.groups, public.app_settings from public, anon, authenticated;


-- ---------------------------------------------------------------------------------------------
-- State and PIN helpers
-- ---------------------------------------------------------------------------------------------

-- "Revealed" and "frozen" are the same state: all six slots claimed and submitted. The slot is a
-- primary key limited to 1..6, so six submitted rows means every slot.
create or replace function private.is_revealed()
returns boolean
language sql
stable
set search_path = ''
as $$
  select count(*) = 6 from public.groups where rankings is not null
$$;

create or replace function private.fail(p_code text)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_build_object('ok', false, 'error', p_code)
$$;

-- The lockout policy, in one place for both group and admin PINs: the 5th wrong PIN in a row
-- locks for 10 minutes. Once a lock has expired, the failures that caused it no longer count.
create or replace function private.next_failure_state(
  p_failed_attempts smallint,
  p_locked_until    timestamptz,
  out failed_attempts smallint,
  out locked_until    timestamptz
)
language sql
stable
set search_path = ''
as $$
  select s.attempts,
         case when s.attempts >= 5 then now() + interval '10 minutes' end
  from (
    select (case when p_locked_until is null then p_failed_attempts else 0 end + 1)::smallint
      as attempts
  ) as s
$$;

-- Returns null when the PIN is right, otherwise the error code for the caller to hand back.
-- Callers must RETURN that code, never raise it: raising rolls back the transaction, and with it
-- the failed-attempt counter written here, which would make the lockout useless.
create or replace function private.check_group_pin(p_slot int, p_pin text)
returns text
language plpgsql
set search_path = ''
as $$
declare
  v_group record;
  v_next  record;
begin
  -- FOR UPDATE serializes concurrent guesses against one slot, so parallel requests cannot each
  -- read "4 failures" and all slip past the limit. It also holds the row until the caller's
  -- transaction ends, so nobody can release the slot halfway through a save.
  select g.pin_hash, g.failed_attempts, g.locked_until
    into v_group
    from public.groups as g
   where g.slot = p_slot
     for update;

  if not found then
    return 'SLOT_EMPTY';
  end if;

  if v_group.locked_until > now() then
    return 'LOCKED';
  end if;

  -- Only a 6-64 character PIN can ever have been set, so skip bcrypt for anything else.
  if char_length(p_pin) between 6 and 64
     and extensions.crypt(p_pin, v_group.pin_hash) = v_group.pin_hash then
    update public.groups
       set failed_attempts = 0, locked_until = null
     where slot = p_slot
       and (failed_attempts <> 0 or locked_until is not null);
    return null;
  end if;

  select * into v_next
    from private.next_failure_state(v_group.failed_attempts, v_group.locked_until);

  update public.groups
     set failed_attempts = v_next.failed_attempts, locked_until = v_next.locked_until
   where slot = p_slot;

  return 'BAD_PIN';
end
$$;

-- Same contract as check_group_pin, against the single app_settings row.
create or replace function private.check_admin_pin(p_pin text)
returns text
language plpgsql
set search_path = ''
as $$
declare
  v_settings record;
  v_next     record;
begin
  select s.admin_pin_hash, s.admin_failed_attempts, s.admin_locked_until
    into v_settings
    from public.app_settings as s
   where s.id = true
     for update;

  -- No admin PIN has been set yet: fail closed.
  if not found then
    return 'NOT_ADMIN';
  end if;

  if v_settings.admin_locked_until > now() then
    return 'LOCKED';
  end if;

  if extensions.crypt(p_pin, v_settings.admin_pin_hash) = v_settings.admin_pin_hash then
    update public.app_settings
       set admin_failed_attempts = 0, admin_locked_until = null
     where id = true
       and (admin_failed_attempts <> 0 or admin_locked_until is not null);
    return null;
  end if;

  select * into v_next
    from private.next_failure_state(v_settings.admin_failed_attempts, v_settings.admin_locked_until);

  update public.app_settings
     set admin_failed_attempts = v_next.failed_attempts, admin_locked_until = v_next.locked_until
   where id = true;

  return 'NOT_ADMIN';
end
$$;


-- ---------------------------------------------------------------------------------------------
-- Public API (the only functions anon can execute)
--
-- PIN-protected functions check in the order DESIGN.md fixes: slot → exists → locked → PIN →
-- body → business rules. Checking the PIN before the body means a wrong PIN never learns whether
-- its payload would have been valid.
-- ---------------------------------------------------------------------------------------------

-- Stable, so every statement inside sees one snapshot: "revealed" and the rows it describes can
-- never disagree mid-call. It also lets PostgREST serve it over GET.
create or replace function public.get_board()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
declare
  v_revealed boolean := private.is_revealed();
begin
  return jsonb_build_object(
    'ok', true,
    'revealed', v_revealed,
    'slots', (
      select jsonb_agg(
               jsonb_build_object(
                 'slot', s.slot,
                 'claimed', g.slot is not null,
                 'group_name', g.group_name,
                 'members', coalesce(to_jsonb(g.members), '[]'::jsonb),
                 'submitted', g.rankings is not null,
                 'updated_at', g.updated_at,
                 -- Sealed until everyone has submitted, so no group can rank tactically.
                 -- Notes would leak the same preferences, so they share the seal.
                 'rankings', case when v_revealed then to_jsonb(g.rankings) end,
                 'notes', case when v_revealed then to_jsonb(g.notes) end
               )
               order by s.slot
             )
      from generate_series(1, 6) as s(slot)
      left join public.groups as g on g.slot = s.slot
    )
  );
end
$$;

create or replace function public.claim_slot(
  p_slot       int,
  p_group_name text,
  p_members    text[],
  p_pin        text
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_name    text   := private.normalize_name(p_group_name);
  v_members text[] := private.normalize_members(p_members);
begin
  if p_slot is null or p_slot not between 1 and 6
     or v_name is null
     or v_members is null
     or p_pin is null or char_length(p_pin) not between 6 and 64 then
    return private.fail('INVALID_INPUT');
  end if;

  -- Insert and see what happened, rather than check-then-insert: two reps racing for one slot
  -- would both pass an "is it free?" check, but only one insert can win the primary key.
  begin
    insert into public.groups (slot, group_name, members, pin_hash)
    values (p_slot, v_name, v_members, extensions.crypt(p_pin, extensions.gen_salt('bf')))
    on conflict (slot) do nothing;

    if not found then
      return private.fail('SLOT_TAKEN');
    end if;
  exception
    -- The slot conflict is absorbed above, so the only unique index left to trip is the
    -- case-insensitive name index.
    when unique_violation then
      return private.fail('NAME_TAKEN');
  end;

  return jsonb_build_object('ok', true);
end
$$;

-- Volatile (the default) on purpose even though it only reads the group: it writes the
-- failed-attempt counter, and PostgREST runs stable functions in a read-only transaction.
create or replace function public.get_my_group(p_slot int, p_pin text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_error text;
  v_group public.groups;
begin
  if p_slot is null or p_slot not between 1 and 6 then
    return private.fail('INVALID_INPUT');
  end if;

  v_error := private.check_group_pin(p_slot, p_pin);
  if v_error is not null then
    return private.fail(v_error);
  end if;

  select * into v_group from public.groups where slot = p_slot;

  return jsonb_build_object(
    'ok', true,
    'group', jsonb_build_object(
      'slot', v_group.slot,
      'group_name', v_group.group_name,
      'members', to_jsonb(v_group.members),
      'rankings', to_jsonb(v_group.rankings),
      'notes', to_jsonb(v_group.notes)
    )
  );
end
$$;

-- The signature gained p_notes. CREATE OR REPLACE would add a second overload beside the old
-- five-argument version, and PostgREST cannot pick between overloads, so drop the old one.
drop function if exists public.save_group(int, text, text, text[], int[]);

create or replace function public.save_group(
  p_slot       int,
  p_pin        text,
  p_group_name text,
  p_members    text[],
  p_rankings   int[],
  p_notes      text[]
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_error    text;
  v_name     text;
  v_members  text[];
  v_rankings smallint[];
  v_notes    text[];
  v_current  public.groups;
begin
  if p_slot is null or p_slot not between 1 and 6 then
    return private.fail('INVALID_INPUT');
  end if;

  v_error := private.check_group_pin(p_slot, p_pin);
  if v_error is not null then
    return private.fail(v_error);
  end if;

  v_name     := private.normalize_name(p_group_name);
  v_members  := private.normalize_members(p_members);
  v_rankings := private.normalize_rankings(p_rankings);
  v_notes    := private.normalize_notes(p_notes);

  if v_name is null
     or v_members is null
     or (p_rankings is not null and v_rankings is null)
     or (p_notes is not null and v_notes is null) then
    return private.fail('INVALID_INPUT');
  end if;

  select * into v_current from public.groups where slot = p_slot;

  -- Only a real change is refused: resending the stored rankings and notes is allowed, so a
  -- client that always sends everything can still fix a member's name after the reveal.
  if private.is_revealed()
     and (   (p_rankings is not null and v_rankings is distinct from v_current.rankings)
          or (p_notes is not null and v_notes is distinct from v_current.notes)) then
    return private.fail('FROZEN');
  end if;

  -- Only this block is rolled back on a name clash; the PIN counter reset above is kept.
  begin
    update public.groups
       set group_name = v_name,
           members    = v_members,
           rankings   = coalesce(v_rankings, rankings),
           notes      = coalesce(v_notes, notes),
           updated_at = now()
     where slot = p_slot;
  exception
    when unique_violation then
      return private.fail('NAME_TAKEN');
  end;

  return jsonb_build_object('ok', true, 'revealed', private.is_revealed());
end
$$;

create or replace function public.release_slot(p_slot int, p_pin text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_error text;
begin
  if p_slot is null or p_slot not between 1 and 6 then
    return private.fail('INVALID_INPUT');
  end if;

  v_error := private.check_group_pin(p_slot, p_pin);
  if v_error is not null then
    return private.fail(v_error);
  end if;

  -- Leaving after the reveal would reopen the board and let everyone re-rank.
  if private.is_revealed() then
    return private.fail('FROZEN');
  end if;

  delete from public.groups where slot = p_slot;

  return jsonb_build_object('ok', true);
end
$$;

-- The admin's escape hatch, and the only way to unfreeze: removing any one group means not all
-- six have submitted any more. Resetting an already-empty slot succeeds, so a double click or a
-- retry after a timeout is harmless.
create or replace function public.admin_reset_slot(p_slot int, p_admin_pin text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_error text;
begin
  if p_slot is null or p_slot not between 1 and 6 then
    return private.fail('INVALID_INPUT');
  end if;

  v_error := private.check_admin_pin(p_admin_pin);
  if v_error is not null then
    return private.fail(v_error);
  end if;

  delete from public.groups where slot = p_slot;

  return jsonb_build_object('ok', true);
end
$$;


-- ---------------------------------------------------------------------------------------------
-- Execute grants
--
-- New functions are executable by PUBLIC by default, and Supabase also grants anon/authenticated
-- directly in the public schema, so revoke from all three before granting the six back.
-- ---------------------------------------------------------------------------------------------

revoke all on all functions in schema private from public, anon, authenticated;

revoke execute on function
  public.get_board(),
  public.claim_slot(int, text, text[], text),
  public.get_my_group(int, text),
  public.save_group(int, text, text, text[], int[], text[]),
  public.release_slot(int, text),
  public.admin_reset_slot(int, text)
from public, anon, authenticated;

grant execute on function
  public.get_board(),
  public.claim_slot(int, text, text[], text),
  public.get_my_group(int, text),
  public.save_group(int, text, text, text[], int[], text[]),
  public.release_slot(int, text),
  public.admin_reset_slot(int, text)
to anon, authenticated;


-- ---------------------------------------------------------------------------------------------
-- Admin PIN: set it yourself, once, in the SQL Editor. Never commit the real value.
-- Running it again changes the PIN and clears any admin lockout.
--
-- insert into public.app_settings (admin_pin_hash)
-- values (extensions.crypt('CHOOSE-A-PIN', extensions.gen_salt('bf')))
-- on conflict (id) do update
--   set admin_pin_hash = excluded.admin_pin_hash,
--       admin_failed_attempts = 0,
--       admin_locked_until = null;
-- ---------------------------------------------------------------------------------------------
