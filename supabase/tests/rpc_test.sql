-- RPC tests for supabase/schema.sql. Plain SQL, no pgTAP.
--
-- Run after schema.sql, either in the Supabase SQL Editor or with:
--   psql -v ON_ERROR_STOP=1 -f supabase/tests/rpc_test.sql
--
-- Everything runs inside one transaction that is rolled back at the end. The suite empties both
-- tables first so it starts from a known board; the rollback puts the real rows back. While it
-- runs (well under a second) it holds row locks, so run it when nobody is using the page.
--
-- Any wrong result raises an exception that names the failed check. A clean run ends by
-- returning a single row: 'ALL TESTS PASSED'.
--
-- On a plain local Postgres instead of Supabase, first create what Supabase provides:
--   create schema extensions;
--   create role anon nologin;
--   create role authenticated nologin;

begin;

create function pg_temp.expect(p_label text, p_actual jsonb, p_expected jsonb)
returns void
language plpgsql
as $$
begin
  if p_actual is distinct from p_expected then
    raise exception 'FAIL [%]: expected %, got %', p_label, p_expected, p_actual;
  end if;
  raise notice 'ok   %', p_label;
end
$$;

create function pg_temp.expect_error(p_label text, p_actual jsonb, p_code text)
returns void
language plpgsql
as $$
begin
  perform pg_temp.expect(p_label, p_actual, jsonb_build_object('ok', false, 'error', p_code));
end
$$;

delete from public.groups;
delete from public.app_settings;
insert into public.app_settings (admin_pin_hash)
values (extensions.crypt('admin-test-pin', extensions.gen_salt('bf')));


-- Empty board ---------------------------------------------------------------------------------
do $$
declare
  v_board jsonb := public.get_board();
begin
  perform pg_temp.expect('empty board: ok and not revealed',
    v_board - 'slots', '{"ok": true, "revealed": false}');
  perform pg_temp.expect('empty board: always six slots in order',
    jsonb_path_query_array(v_board, '$.slots[*].slot'), '[1, 2, 3, 4, 5, 6]');
  perform pg_temp.expect('empty board: unclaimed slot shape',
    v_board -> 'slots' -> 1,
    '{"slot": 2, "claimed": false, "group_name": null, "members": [],
      "submitted": false, "updated_at": null, "rankings": null, "notes": null}');
end
$$;


-- Claiming ------------------------------------------------------------------------------------
do $$
begin
  perform pg_temp.expect('claim slot 1',
    public.claim_slot(1, '  Ganache ', array[' Ana ', 'Ben'], 'pin-one-111'), '{"ok": true}');

  perform pg_temp.expect('name and members are stored trimmed',
    (select jsonb_build_object('name', group_name, 'members', members)
       from public.groups where slot = 1),
    '{"name": "Ganache", "members": ["Ana", "Ben"]}');

  perform pg_temp.expect('PIN is stored as a bcrypt hash, not plaintext',
    (select to_jsonb(pin_hash like '$2a$%' and pin_hash <> 'pin-one-111')
       from public.groups where slot = 1),
    'true');

  perform pg_temp.expect_error('claim an already-claimed slot',
    public.claim_slot(1, 'Praline', array['Cy'], 'pin-two-222'), 'SLOT_TAKEN');

  perform pg_temp.expect_error('claim with a taken name in another case, untrimmed',
    public.claim_slot(2, ' GANACHE ', array['Cy'], 'pin-two-222'), 'NAME_TAKEN');

  perform pg_temp.expect('rejected claims left no row behind',
    (select to_jsonb(count(*)) from public.groups), '1');

  -- Upper boundaries are accepted: 60-char name, 8 members of 60 chars, 6-char PIN.
  perform pg_temp.expect('claim at every upper/lower length boundary',
    public.claim_slot(2, repeat('n', 60), array_fill(repeat('m', 60), array[8]), '123456'),
    '{"ok": true}');
end
$$;

do $$
begin
  perform pg_temp.expect_error('claim: slot 0',
    public.claim_slot(0, 'X', array['A'], 'pin-xx-000'), 'INVALID_INPUT');
  perform pg_temp.expect_error('claim: slot 7',
    public.claim_slot(7, 'X', array['A'], 'pin-xx-000'), 'INVALID_INPUT');
  perform pg_temp.expect_error('claim: null slot',
    public.claim_slot(null, 'X', array['A'], 'pin-xx-000'), 'INVALID_INPUT');
  perform pg_temp.expect_error('claim: null name',
    public.claim_slot(3, null, array['A'], 'pin-xx-000'), 'INVALID_INPUT');
  perform pg_temp.expect_error('claim: whitespace-only name',
    public.claim_slot(3, E' \t ', array['A'], 'pin-xx-000'), 'INVALID_INPUT');
  perform pg_temp.expect_error('claim: 61-char name',
    public.claim_slot(3, repeat('n', 61), array['A'], 'pin-xx-000'), 'INVALID_INPUT');
  perform pg_temp.expect_error('claim: null members',
    public.claim_slot(3, 'X', null, 'pin-xx-000'), 'INVALID_INPUT');
  perform pg_temp.expect_error('claim: empty members',
    public.claim_slot(3, 'X', '{}'::text[], 'pin-xx-000'), 'INVALID_INPUT');
  perform pg_temp.expect_error('claim: 9 members',
    public.claim_slot(3, 'X', array_fill('m'::text, array[9]), 'pin-xx-000'), 'INVALID_INPUT');
  perform pg_temp.expect_error('claim: blank member',
    public.claim_slot(3, 'X', array['A', '   '], 'pin-xx-000'), 'INVALID_INPUT');
  perform pg_temp.expect_error('claim: null member',
    public.claim_slot(3, 'X', array['A', null], 'pin-xx-000'), 'INVALID_INPUT');
  perform pg_temp.expect_error('claim: 61-char member',
    public.claim_slot(3, 'X', array[repeat('m', 61)], 'pin-xx-000'), 'INVALID_INPUT');
  perform pg_temp.expect_error('claim: 2-D members array',
    public.claim_slot(3, 'X', array[['A'], ['B']], 'pin-xx-000'), 'INVALID_INPUT');
  perform pg_temp.expect_error('claim: null PIN',
    public.claim_slot(3, 'X', array['A'], null), 'INVALID_INPUT');
  perform pg_temp.expect_error('claim: 5-char PIN',
    public.claim_slot(3, 'X', array['A'], '12345'), 'INVALID_INPUT');
  perform pg_temp.expect_error('claim: 65-char PIN',
    public.claim_slot(3, 'X', array['A'], repeat('p', 65)), 'INVALID_INPUT');
  perform pg_temp.expect('invalid claims left no row behind',
    (select to_jsonb(count(*)) from public.groups where slot = 3), '0');
end
$$;


-- Table constraints are a backstop even for code that bypasses the functions ----------------
do $$
begin
  begin
    insert into public.groups (slot, group_name, members, pin_hash)
    values (3, 'Plain', array['A'], 'not-a-hash');
    raise exception 'FAIL [constraint: plaintext pin_hash]: insert succeeded';
  exception when check_violation then
    raise notice 'ok   constraint: plaintext pin_hash rejected';
  end;

  begin
    insert into public.groups (slot, group_name, members, pin_hash, rankings)
    values (3, 'Plain', array['A'], extensions.crypt('x', extensions.gen_salt('bf')),
            array[1, 1, 2, 3, 4, 5]::smallint[]);
    raise exception 'FAIL [constraint: duplicate ranking ids]: insert succeeded';
  exception when check_violation then
    raise notice 'ok   constraint: duplicate ranking ids rejected';
  end;

  begin
    insert into public.groups (slot, group_name, members, pin_hash)
    values (3, ' Untrimmed', array['A'], extensions.crypt('x', extensions.gen_salt('bf')));
    raise exception 'FAIL [constraint: untrimmed name]: insert succeeded';
  exception when check_violation then
    raise notice 'ok   constraint: untrimmed name rejected';
  end;

  begin
    insert into public.groups (slot, group_name, members, pin_hash, notes)
    values (3, 'Plain', array['A'], extensions.crypt('x', extensions.gen_salt('bf')),
            array_fill(''::text, array[5]));
    raise exception 'FAIL [constraint: five notes]: insert succeeded';
  exception when check_violation then
    raise notice 'ok   constraint: notes must have exactly six entries';
  end;
end
$$;


-- Reading your own group ----------------------------------------------------------------------
do $$
begin
  perform pg_temp.expect('get_my_group with the right PIN',
    public.get_my_group(1, 'pin-one-111'),
    '{"ok": true, "group": {"slot": 1, "group_name": "Ganache",
      "members": ["Ana", "Ben"], "rankings": null, "notes": ["", "", "", "", "", ""]}}');
  perform pg_temp.expect_error('get_my_group on an empty slot',
    public.get_my_group(3, 'pin-one-111'), 'SLOT_EMPTY');
  perform pg_temp.expect_error('get_my_group on slot 9',
    public.get_my_group(9, 'pin-one-111'), 'INVALID_INPUT');
  perform pg_temp.expect_error('get_my_group with a null PIN',
    public.get_my_group(1, null), 'BAD_PIN');
  perform pg_temp.expect('a wrong PIN is counted',
    (select to_jsonb(failed_attempts) from public.groups where slot = 1), '1');
  -- Read the counter in a separate statement: a subquery in the same statement as the call
  -- would read from that statement's snapshot and miss the function's own update.
  perform pg_temp.expect('get_my_group after a failure',
    public.get_my_group(1, 'pin-one-111') -> 'ok', 'true');
  perform pg_temp.expect('a correct PIN resets the counter',
    (select to_jsonb(failed_attempts) from public.groups where slot = 1), '0');
end
$$;


-- Group lockout -------------------------------------------------------------------------------
do $$
declare
  i int;
begin
  for i in 1..5 loop
    perform pg_temp.expect_error(format('bad PIN #%s returns BAD_PIN', i),
      public.get_my_group(2, 'wrong-pin'), 'BAD_PIN');
  end loop;

  perform pg_temp.expect('5th failure sets a 10-minute lock',
    (select to_jsonb(locked_until = now() + interval '10 minutes')
       from public.groups where slot = 2),
    'true');
  perform pg_temp.expect_error('correct PIN while locked is still LOCKED',
    public.get_my_group(2, '123456'), 'LOCKED');
  perform pg_temp.expect_error('wrong PIN while locked is LOCKED',
    public.get_my_group(2, 'wrong-pin'), 'LOCKED');
  perform pg_temp.expect('guesses during a lock are not counted',
    (select to_jsonb(failed_attempts) from public.groups where slot = 2), '5');
  perform pg_temp.expect_error('save_group respects the lock',
    public.save_group(2, '123456', repeat('n', 60), array['A'], null, null), 'LOCKED');
  perform pg_temp.expect_error('release_slot respects the lock',
    public.release_slot(2, '123456'), 'LOCKED');
  perform pg_temp.expect('other slots are not affected by slot 2''s lock',
    public.get_my_group(1, 'pin-one-111') -> 'ok', 'true');

  -- now() is fixed for the whole transaction, so expire the lock by moving it into the past.
  update public.groups set locked_until = now() - interval '1 second' where slot = 2;

  perform pg_temp.expect_error('first bad PIN after expiry',
    public.get_my_group(2, 'wrong-pin'), 'BAD_PIN');
  perform pg_temp.expect('expiry restarts the count instead of re-locking',
    (select jsonb_build_array(failed_attempts, locked_until) from public.groups where slot = 2),
    '[1, null]');
  perform pg_temp.expect('correct PIN after expiry',
    public.get_my_group(2, '123456') -> 'ok', 'true');
  perform pg_temp.expect('success resets the counter',
    (select to_jsonb(failed_attempts) from public.groups where slot = 2), '0');
end
$$;


-- save_group: check order and validation ------------------------------------------------------
do $$
begin
  perform pg_temp.expect_error('wrong PIN is reported before an invalid body',
    public.save_group(1, 'wrong-pin', '', '{}'::text[], array[1], null), 'BAD_PIN');
  perform pg_temp.expect_error('right PIN, invalid body',
    public.save_group(1, 'pin-one-111', '', array['Ana'], null, null), 'INVALID_INPUT');
  perform pg_temp.expect('a valid PIN resets the counter even when the body is invalid',
    (select to_jsonb(failed_attempts) from public.groups where slot = 1), '0');
  perform pg_temp.expect_error('save_group on an empty slot',
    public.save_group(4, 'pin-one-111', 'X', array['A'], null, null), 'SLOT_EMPTY');
  perform pg_temp.expect_error('save_group on slot 0',
    public.save_group(0, 'pin-one-111', 'X', array['A'], null, null), 'INVALID_INPUT');
  perform pg_temp.expect_error('save_group: 9 members',
    public.save_group(1, 'pin-one-111', 'Ganache', array_fill('m'::text, array[9]), null, null),
    'INVALID_INPUT');

  perform pg_temp.expect_error('rankings: 7 entries',
    public.save_group(1, 'pin-one-111', 'Ganache', array['Ana'], array[1, 2, 3, 4, 5, 6, 1], null),
    'INVALID_INPUT');
  perform pg_temp.expect_error('rankings: duplicate id',
    public.save_group(1, 'pin-one-111', 'Ganache', array['Ana'], array[1, 1], null),
    'INVALID_INPUT');
  perform pg_temp.expect_error('rankings: id 0',
    public.save_group(1, 'pin-one-111', 'Ganache', array['Ana'], array[0], null),
    'INVALID_INPUT');
  perform pg_temp.expect_error('rankings: id 7',
    public.save_group(1, 'pin-one-111', 'Ganache', array['Ana'], array[7], null),
    'INVALID_INPUT');
  perform pg_temp.expect_error('rankings: null entry',
    public.save_group(1, 'pin-one-111', 'Ganache', array['Ana'], array[1, null], null),
    'INVALID_INPUT');
  perform pg_temp.expect_error('rankings: 2-D array',
    public.save_group(1, 'pin-one-111', 'Ganache', array['Ana'], array[[1, 2, 3], [4, 5, 6]], null),
    'INVALID_INPUT');
  perform pg_temp.expect_error('rankings: empty array',
    public.save_group(1, 'pin-one-111', 'Ganache', array['Ana'], '{}'::int[], null),
    'INVALID_INPUT');
  perform pg_temp.expect('rejected saves changed nothing',
    (select jsonb_build_array(members, rankings) from public.groups where slot = 1),
    '[["Ana", "Ben"], null]');

  -- Partial rankings: a group may rank just its favourites; unlisted questions are unranked.
  perform pg_temp.expect('rankings: a single choice is accepted',
    public.save_group(1, 'pin-one-111', 'Ganache', array['Ana', 'Ben'], array[3], null),
    '{"ok": true, "revealed": false}');
  perform pg_temp.expect('rankings: a single choice is stored',
    (select to_jsonb(rankings) from public.groups where slot = 1), '[3]');
  perform pg_temp.expect('rankings: two choices are accepted',
    public.save_group(1, 'pin-one-111', 'Ganache', array['Ana', 'Ben'], array[2, 5], null),
    '{"ok": true, "revealed": false}');
  perform pg_temp.expect('rankings: two choices are stored in preference order',
    (select to_jsonb(rankings) from public.groups where slot = 1), '[2, 5]');

  perform pg_temp.expect('a group may re-save its own name in a different case',
    public.save_group(1, 'pin-one-111', 'GANACHE', array['Ana', 'Ben'], null, null),
    '{"ok": true, "revealed": false}');
  perform pg_temp.expect('valid rankings are saved',
    public.save_group(1, 'pin-one-111', 'Ganache', array['Ana', 'Ben'],
                      array[3, 1, 2, 6, 5, 4], null),
    '{"ok": true, "revealed": false}');
  perform pg_temp.expect('a names-only save (null rankings)',
    public.save_group(1, 'pin-one-111', 'Ganache', array['Ana', 'Ben', 'Cy'], null, null),
    '{"ok": true, "revealed": false}');
  perform pg_temp.expect('null rankings kept the saved ones',
    (select jsonb_build_array(members, rankings) from public.groups where slot = 1),
    '[["Ana", "Ben", "Cy"], [3, 1, 2, 6, 5, 4]]');
end
$$;


-- save_group: notes ---------------------------------------------------------------------------
do $$
begin
  perform pg_temp.expect_error('notes: 5 entries',
    public.save_group(1, 'pin-one-111', 'Ganache', array['Ana'], null,
                      array_fill(''::text, array[5])),
    'INVALID_INPUT');
  perform pg_temp.expect_error('notes: 7 entries',
    public.save_group(1, 'pin-one-111', 'Ganache', array['Ana'], null,
                      array_fill(''::text, array[7])),
    'INVALID_INPUT');
  perform pg_temp.expect_error('notes: empty array',
    public.save_group(1, 'pin-one-111', 'Ganache', array['Ana'], null, '{}'::text[]),
    'INVALID_INPUT');
  perform pg_temp.expect_error('notes: 141-char note',
    public.save_group(1, 'pin-one-111', 'Ganache', array['Ana'], null,
                      array[repeat('x', 141), '', '', '', '', '']),
    'INVALID_INPUT');
  perform pg_temp.expect_error('notes: null entry',
    public.save_group(1, 'pin-one-111', 'Ganache', array['Ana'], null,
                      array['', '', null, '', '', '']),
    'INVALID_INPUT');
  perform pg_temp.expect_error('notes: 2-D array',
    public.save_group(1, 'pin-one-111', 'Ganache', array['Ana'], null,
                      array[['', '', ''], ['', '', '']]),
    'INVALID_INPUT');
  perform pg_temp.expect('rejected notes changed nothing',
    (select jsonb_build_array(members, notes) from public.groups where slot = 1),
    '[["Ana", "Ben", "Cy"], ["", "", "", "", "", ""]]');

  -- Whitespace around a 140-char note is trimmed before the length check, not counted.
  perform pg_temp.expect('notes: 140 chars plus padding, blanks allowed',
    public.save_group(1, 'pin-one-111', 'Ganache', array['Ana', 'Ben', 'Cy'], null,
                      array['  ' || repeat('x', 140) || ' ', '', '', '', '', E' Fits us\t']),
    '{"ok": true, "revealed": false}');
  perform pg_temp.expect('notes are stored trimmed, by question id, rankings untouched',
    (select jsonb_build_array(notes, rankings) from public.groups where slot = 1),
    jsonb_build_array(array[repeat('x', 140), '', '', '', '', 'Fits us'],
                      array[3, 1, 2, 6, 5, 4]));
  perform pg_temp.expect('null notes keeps the saved ones',
    public.save_group(1, 'pin-one-111', 'Ganache', array['Ana', 'Ben', 'Cy'],
                      array[3, 1, 2, 6, 5, 4], null),
    '{"ok": true, "revealed": false}');
  perform pg_temp.expect('null notes kept the saved ones',
    (select to_jsonb(notes[6]) from public.groups where slot = 1), '"Fits us"');
end
$$;


-- Sealed rankings and the reveal --------------------------------------------------------------
do $$
declare
  v_board jsonb;
begin
  perform pg_temp.expect('claim slot 3',
    public.claim_slot(3, 'Praline', array['Dee'], 'pin-three-3'), '{"ok": true}');
  perform pg_temp.expect('claim slot 4',
    public.claim_slot(4, 'Truffle', array['Eve'], 'pin-four-44'), '{"ok": true}');
  perform pg_temp.expect('claim slot 5',
    public.claim_slot(5, 'Gianduja', array['Fay'], 'pin-five-55'), '{"ok": true}');
  perform pg_temp.expect('claim slot 6',
    public.claim_slot(6, 'Nougat', array['Gus'], 'pin-six-666'), '{"ok": true}');

  perform pg_temp.expect_error('save_group: rename to another group''s name',
    public.save_group(3, 'pin-three-3', ' ganache ', array['Dee'], null, null), 'NAME_TAKEN');

  perform pg_temp.expect('slot 2 submits',
    public.save_group(2, '123456', repeat('n', 60), array['Hal'], array[1, 2, 3, 4, 5, 6], null),
    '{"ok": true, "revealed": false}');
  perform pg_temp.expect('slot 3 submits',
    public.save_group(3, 'pin-three-3', 'Praline', array['Dee'], array[2], null),
    '{"ok": true, "revealed": false}');
  perform pg_temp.expect('slot 4 submits',
    public.save_group(4, 'pin-four-44', 'Truffle', array['Eve'], array[4, 3, 2, 1, 6, 5], null),
    '{"ok": true, "revealed": false}');
  perform pg_temp.expect('slot 5 submits',
    public.save_group(5, 'pin-five-55', 'Gianduja', array['Fay'], array[5, 6], null),
    '{"ok": true, "revealed": false}');

  -- Six claimed, five submitted: still sealed.
  v_board := public.get_board();
  perform pg_temp.expect('6 claimed, 5 submitted: not revealed',
    v_board -> 'revealed', 'false');
  perform pg_temp.expect('6 claimed, 5 submitted: submitted flags',
    jsonb_path_query_array(v_board, '$.slots[*].submitted'),
    '[true, true, true, true, true, false]');
  perform pg_temp.expect('6 claimed, 5 submitted: every ranking hidden',
    jsonb_path_query_array(v_board, '$.slots[*].rankings'),
    '[null, null, null, null, null, null]');
  perform pg_temp.expect('6 claimed, 5 submitted: every note hidden',
    jsonb_path_query_array(v_board, '$.slots[*].notes'),
    '[null, null, null, null, null, null]');
  perform pg_temp.expect('a group still sees its own rankings before the reveal',
    public.get_my_group(1, 'pin-one-111') -> 'group' -> 'rankings', '[3, 1, 2, 6, 5, 4]');
  perform pg_temp.expect('a group still sees its own notes before the reveal',
    public.get_my_group(1, 'pin-one-111') -> 'group' -> 'notes' -> 5, '"Fits us"');

  -- Partial rankings count as submitted: the reveal needs one ranked question per group, not six.
  perform pg_temp.expect('the sixth submission reports the reveal',
    public.save_group(6, 'pin-six-666', 'Nougat', array['Gus'], array[6], null),
    '{"ok": true, "revealed": true}');

  v_board := public.get_board();
  perform pg_temp.expect('all six submitted: revealed',
    v_board -> 'revealed', 'true');
  perform pg_temp.expect('all six submitted: every ranking visible, in slot order',
    jsonb_path_query_array(v_board, '$.slots[*].rankings'),
    '[[3, 1, 2, 6, 5, 4], [1, 2, 3, 4, 5, 6], [2], [4, 3, 2, 1, 6, 5], [5, 6], [6]]');
  perform pg_temp.expect('all six submitted: notes visible, indexed by question id',
    jsonb_build_array(v_board -> 'slots' -> 0 -> 'notes' -> 5,
                      v_board -> 'slots' -> 1 -> 'notes'),
    '["Fits us", ["", "", "", "", "", ""]]');
end
$$;


-- Frozen after the reveal ---------------------------------------------------------------------
do $$
begin
  perform pg_temp.expect_error('frozen: changing rankings is refused',
    public.save_group(1, 'pin-one-111', 'Ganache', array['Ana'], array[1, 2, 3, 4, 5, 6], null),
    'FROZEN');
  perform pg_temp.expect_error('frozen: FROZEN is reported before NAME_TAKEN',
    public.save_group(1, 'pin-one-111', 'Praline', array['Ana'], array[1, 2, 3, 4, 5, 6], null),
    'FROZEN');
  perform pg_temp.expect('frozen: refused change left the rankings alone',
    (select to_jsonb(rankings) from public.groups where slot = 1), '[3, 1, 2, 6, 5, 4]');
  perform pg_temp.expect_error('frozen: changing notes is refused',
    public.save_group(2, '123456', repeat('n', 60), array['Hal'], null,
                      array['', 'Changed our mind', '', '', '', '']),
    'FROZEN');
  perform pg_temp.expect_error('frozen: changing notes alongside identical rankings is refused',
    public.save_group(2, '123456', repeat('n', 60), array['Hal'], array[1, 2, 3, 4, 5, 6],
                      array['', 'Changed our mind', '', '', '', '']),
    'FROZEN');
  perform pg_temp.expect('frozen: resending identical rankings and notes is allowed',
    public.save_group(2, '123456', repeat('n', 60), array['Hal'], array[1, 2, 3, 4, 5, 6],
                      array_fill(''::text, array[6])),
    '{"ok": true, "revealed": true}');
  perform pg_temp.expect('frozen: refused note change left the notes alone',
    (select to_jsonb(notes) from public.groups where slot = 2), '["", "", "", "", "", ""]');
  perform pg_temp.expect('frozen: resending the same rankings is allowed',
    public.save_group(1, 'pin-one-111', 'Ganache', array['Ana', 'Ben', 'Cy'],
                      array[3, 1, 2, 6, 5, 4], null),
    '{"ok": true, "revealed": true}');
  perform pg_temp.expect('frozen: a names-only save is allowed',
    public.save_group(1, 'pin-one-111', 'Ganache Gang', array['Ana', 'Ben', 'Cy', 'Dot'],
                      null, null),
    '{"ok": true, "revealed": true}');
  perform pg_temp.expect('frozen: names changed, rankings did not',
    (select jsonb_build_array(group_name, rankings) from public.groups where slot = 1),
    '["Ganache Gang", [3, 1, 2, 6, 5, 4]]');
  perform pg_temp.expect_error('frozen: NAME_TAKEN still applies to a names-only save',
    public.save_group(3, 'pin-three-3', 'GANACHE GANG', array['Dee'], null, null), 'NAME_TAKEN');
  perform pg_temp.expect_error('frozen: wrong PIN is reported before FROZEN',
    public.release_slot(1, 'wrong-pin'), 'BAD_PIN');
  perform pg_temp.expect_error('frozen: release is refused',
    public.release_slot(1, 'pin-one-111'), 'FROZEN');
  perform pg_temp.expect('frozen: refused release kept the row',
    (select to_jsonb(count(*)) from public.groups), '6');
end
$$;


-- Admin ---------------------------------------------------------------------------------------
do $$
declare
  i int;
begin
  perform pg_temp.expect_error('admin: invalid slot',
    public.admin_reset_slot(0, 'admin-test-pin'), 'INVALID_INPUT');
  perform pg_temp.expect_error('admin: null PIN',
    public.admin_reset_slot(1, null), 'NOT_ADMIN');

  for i in 2..5 loop
    perform pg_temp.expect_error(format('admin: bad PIN #%s', i),
      public.admin_reset_slot(1, 'wrong-admin'), 'NOT_ADMIN');
  end loop;

  perform pg_temp.expect('admin: 5th failure sets a 10-minute lock',
    (select to_jsonb(admin_locked_until = now() + interval '10 minutes') from public.app_settings),
    'true');
  perform pg_temp.expect_error('admin: correct PIN while locked is still LOCKED',
    public.admin_reset_slot(1, 'admin-test-pin'), 'LOCKED');
  perform pg_temp.expect('admin: nothing was deleted while locked',
    (select to_jsonb(count(*)) from public.groups), '6');

  update public.app_settings set admin_locked_until = now() - interval '1 second';

  perform pg_temp.expect('admin: reset after the lock expires',
    public.admin_reset_slot(1, 'admin-test-pin'), '{"ok": true}');
  perform pg_temp.expect('admin: success resets the admin counter',
    (select jsonb_build_array(admin_failed_attempts, admin_locked_until) from public.app_settings),
    '[0, null]');
  perform pg_temp.expect('admin: the slot is gone and the board is unfrozen',
    jsonb_build_array((select count(*) from public.groups where slot = 1),
                      public.get_board() -> 'revealed'),
    '[0, false]');
  perform pg_temp.expect('admin: resetting an empty slot is a harmless no-op',
    public.admin_reset_slot(1, 'admin-test-pin'), '{"ok": true}');

  perform pg_temp.expect('unfrozen: rankings can change again',
    public.save_group(3, 'pin-three-3', 'Praline', array['Dee'], array[6, 5, 4, 3, 2, 1], null),
    '{"ok": true, "revealed": false}');
  perform pg_temp.expect('unfrozen: release works',
    public.release_slot(3, 'pin-three-3'), '{"ok": true}');
  perform pg_temp.expect_error('released slot is empty',
    public.get_my_group(3, 'pin-three-3'), 'SLOT_EMPTY');
  perform pg_temp.expect('released slot and name can be claimed again',
    public.claim_slot(3, 'Praline', array['Ivy'], 'pin-new-333'), '{"ok": true}');

  delete from public.app_settings;
  perform pg_temp.expect_error('admin: with no admin PIN configured, everyone is NOT_ADMIN',
    public.admin_reset_slot(2, 'admin-test-pin'), 'NOT_ADMIN');
  perform pg_temp.expect('admin: nothing was deleted without an admin PIN',
    (select to_jsonb(count(*)) from public.groups where slot = 2), '1');
end
$$;


-- Privileges ----------------------------------------------------------------------------------
do $$
declare
  v_role text;
  v_fn   text;
begin
  foreach v_role in array array['anon', 'authenticated'] loop
    perform pg_temp.expect(format('%s has no privilege on public.groups', v_role),
      to_jsonb(has_table_privilege(v_role, 'public.groups',
        'select, insert, update, delete, truncate, references, trigger')),
      'false');
    perform pg_temp.expect(format('%s has no privilege on public.app_settings', v_role),
      to_jsonb(has_table_privilege(v_role, 'public.app_settings',
        'select, insert, update, delete, truncate, references, trigger')),
      'false');
    perform pg_temp.expect(format('%s cannot use the private schema', v_role),
      to_jsonb(has_schema_privilege(v_role, 'private', 'usage')), 'false');
    perform pg_temp.expect(format('%s cannot execute any private function', v_role),
      (select to_jsonb(count(*))
         from pg_proc as p
         join pg_namespace as n on n.oid = p.pronamespace
        where n.nspname = 'private'
          and has_function_privilege(v_role, p.oid, 'execute')),
      '0');

    foreach v_fn in array array[
      'public.get_board()',
      'public.claim_slot(int, text, text[], text)',
      'public.get_my_group(int, text)',
      'public.save_group(int, text, text, text[], int[], text[])',
      'public.release_slot(int, text)',
      'public.admin_reset_slot(int, text)'
    ] loop
      perform pg_temp.expect(format('%s can execute %s', v_role, v_fn),
        to_jsonb(has_function_privilege(v_role, v_fn, 'execute')), 'true');
    end loop;
  end loop;

  perform pg_temp.expect('all six API functions are security definer with a pinned search_path',
    (select to_jsonb(count(*))
       from pg_proc as p
       join pg_namespace as n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and p.proname in ('get_board', 'claim_slot', 'get_my_group',
                          'save_group', 'release_slot', 'admin_reset_slot')
        and p.prosecdef
        and 'search_path=public, extensions' = any (p.proconfig)),
    '6');
  perform pg_temp.expect('exactly one save_group overload, so PostgREST can resolve the call',
    (select to_jsonb(count(*))
       from pg_proc as p
       join pg_namespace as n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'save_group'),
    '1');
  perform pg_temp.expect('RLS is on for both tables',
    (select to_jsonb(bool_and(relrowsecurity)) from pg_class
      where oid in ('public.groups'::regclass, 'public.app_settings'::regclass)),
    'true');
end
$$;

-- Then actually act as anon, the role every browser request runs as. No pg_temp helpers here:
-- they live in this session's temp schema, which is not something anon should rely on.
set local role anon;

do $$
begin
  begin
    perform 1 from public.groups;
    raise exception 'FAIL [anon selects public.groups]: query succeeded';
  exception when insufficient_privilege then
    raise notice 'ok   anon cannot select from public.groups';
  end;

  begin
    perform 1 from public.app_settings;
    raise exception 'FAIL [anon selects public.app_settings]: query succeeded';
  exception when insufficient_privilege then
    raise notice 'ok   anon cannot select from public.app_settings';
  end;

  begin
    perform private.is_revealed();
    raise exception 'FAIL [anon calls a private helper]: call succeeded';
  exception when insufficient_privilege then
    raise notice 'ok   anon cannot call private helpers';
  end;

  if (public.get_board() ->> 'ok') is distinct from 'true' then
    raise exception 'FAIL [anon calls get_board]: did not return ok';
  end if;
  raise notice 'ok   anon can call get_board';

  if public.get_my_group(2, 'wrong-pin') ->> 'error' is distinct from 'BAD_PIN' then
    raise exception 'FAIL [anon calls get_my_group]: expected BAD_PIN';
  end if;
  raise notice 'ok   anon can call get_my_group, and the definer writes the counter for it';
end
$$;

reset role;

select 'ALL TESTS PASSED' as result;

rollback;
