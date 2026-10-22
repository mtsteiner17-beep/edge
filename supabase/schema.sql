-- EDGE crew leaderboard backend.
--
-- Paste this whole file into Supabase -> SQL Editor -> New query -> Run.
-- It is safe to run more than once.
--
-- How it's locked down:
--   * The table has Row Level Security ON and ZERO policies, so the public browser key
--     cannot read or write it directly.
--   * The only way in is through the four edge_* functions below (SECURITY DEFINER).
--   * Each player gets a random secret key on their own phone. Only its SHA-256 hash is
--     stored, and every write has to present the matching key.
--   * A crew is just a short code. Anyone with the code can join and see the board, so
--     treat the code like a group chat invite link.

create table if not exists public.edge_players (
  crew        text        not null,
  player      uuid        not null,
  key_hash    text        not null,
  name        text        not null,
  level       int         not null default 100,
  charging    boolean     not null default false,
  points      bigint      not null default 0,
  streak      int         not null default 0,
  record_dead int         not null default 0,   -- longest blackout, seconds
  total_dead  bigint      not null default 0,   -- seconds
  lowest      int         not null default 100,
  dead_since  timestamptz,                      -- set while a shutdown is armed
  joined_at   timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  primary key (crew, player)
);

create unique index if not exists edge_players_crew_name_uq
  on public.edge_players (crew, lower(name));

alter table public.edge_players enable row level security;
revoke all on public.edge_players from anon, authenticated;

-- ---------------------------------------------------------------------------
-- join / create a crew (also used to rename yourself)
-- ---------------------------------------------------------------------------
create or replace function public.edge_join(
  p_crew   text,
  p_player uuid,
  p_key    text,
  p_name   text,
  p_create boolean default false
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_crew  text := upper(trim(coalesce(p_crew, '')));
  v_name  text := left(trim(regexp_replace(coalesce(p_name, ''), '[[:cntrl:]]', '', 'g')), 16);
  v_hash  text := encode(sha256(convert_to(coalesce(p_key, ''), 'UTF8')), 'hex');
  v_count int;
  v_row   public.edge_players;
begin
  if v_crew !~ '^[A-Z0-9]{4,12}$' then raise exception 'BAD_CODE'; end if;
  if length(v_name) < 1            then raise exception 'BAD_NAME'; end if;
  if length(coalesce(p_key, '')) < 16 then raise exception 'BAD_KEY'; end if;
  if p_player is null              then raise exception 'BAD_KEY'; end if;

  -- serialise joins to the same crew so two people can't both "create" it
  perform pg_advisory_xact_lock(hashtext('edge:' || v_crew));

  select count(*) into v_count from public.edge_players where crew = v_crew;
  select * into v_row from public.edge_players where crew = v_crew and player = p_player;

  if found then
    -- already a member: must present the same key. Lets you rename yourself.
    if v_row.key_hash <> v_hash then raise exception 'BAD_KEY'; end if;
    if exists (select 1 from public.edge_players
                where crew = v_crew and lower(name) = lower(v_name) and player <> p_player) then
      raise exception 'NAME_TAKEN';
    end if;
    update public.edge_players set name = v_name, updated_at = now()
     where crew = v_crew and player = p_player;
    return jsonb_build_object('ok', true, 'crew', v_crew);
  end if;

  if p_create then
    if v_count > 0 then raise exception 'CODE_TAKEN'; end if;
  else
    if v_count = 0 then raise exception 'NO_SUCH_CREW'; end if;
  end if;

  if v_count >= 30 then raise exception 'CREW_FULL'; end if;

  if exists (select 1 from public.edge_players
              where crew = v_crew and lower(name) = lower(v_name)) then
    raise exception 'NAME_TAKEN';
  end if;

  insert into public.edge_players (crew, player, key_hash, name)
  values (v_crew, p_player, v_hash, v_name);

  return jsonb_build_object('ok', true, 'crew', v_crew);
end;
$$;

-- ---------------------------------------------------------------------------
-- report your numbers
-- ---------------------------------------------------------------------------
create or replace function public.edge_report(
  p_crew        text,
  p_player      uuid,
  p_key         text,
  p_level       int,
  p_charging    boolean,
  p_points      bigint,
  p_streak      int,
  p_record_dead int,
  p_total_dead  bigint,
  p_lowest      int,
  p_dead_since  timestamptz default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_crew text := upper(trim(coalesce(p_crew, '')));
  v_hash text := encode(sha256(convert_to(coalesce(p_key, ''), 'UTF8')), 'hex');
  v_dead timestamptz;
begin
  -- a shutdown timestamp can't be in the future or older than two weeks
  if p_dead_since is not null and p_dead_since > now() - interval '14 days' then
    v_dead := least(p_dead_since, now());
  end if;

  update public.edge_players set
    level       = least(greatest(coalesce(p_level, 100), 0), 100),
    charging    = coalesce(p_charging, false),
    points      = least(greatest(coalesce(p_points, 0), 0), 100000000),
    streak      = least(greatest(coalesce(p_streak, 0), 0), 100000),
    record_dead = least(greatest(coalesce(p_record_dead, 0), 0), 86400),
    total_dead  = least(greatest(coalesce(p_total_dead, 0), 0), 100000000),
    lowest      = least(greatest(coalesce(p_lowest, 100), 0), 100),
    dead_since  = v_dead,
    updated_at  = now()
  where crew = v_crew and player = p_player and key_hash = v_hash;

  if not found then raise exception 'NOT_IN_CREW'; end if;
  return jsonb_build_object('ok', true);
end;
$$;

-- ---------------------------------------------------------------------------
-- read the board (no key needed; the crew code is the secret)
-- ---------------------------------------------------------------------------
create or replace function public.edge_board(
  p_crew   text,
  p_player uuid default null
) returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'now', now(),
    'players', coalesce(jsonb_agg(
      jsonb_build_object(
        'name',        name,
        'level',       level,
        'charging',    charging,
        'points',      points,
        'streak',      streak,
        'record_dead', record_dead,
        'total_dead',  total_dead,
        'lowest',      lowest,
        'dead_since',  dead_since,
        'updated_at',  updated_at,
        'me',          coalesce(player = p_player, false)
      ) order by points desc, name
    ), '[]'::jsonb)
  )
  from public.edge_players
  where crew = upper(trim(coalesce(p_crew, '')));
$$;

-- ---------------------------------------------------------------------------
-- leave a crew
-- ---------------------------------------------------------------------------
create or replace function public.edge_leave(
  p_crew   text,
  p_player uuid,
  p_key    text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_crew text := upper(trim(coalesce(p_crew, '')));
  v_hash text := encode(sha256(convert_to(coalesce(p_key, ''), 'UTF8')), 'hex');
begin
  delete from public.edge_players
   where crew = v_crew and player = p_player and key_hash = v_hash;
  return jsonb_build_object('ok', true);
end;
$$;

-- ---------------------------------------------------------------------------
-- permissions: browser key may call the functions, nothing else
-- ---------------------------------------------------------------------------
revoke all on function public.edge_join(text, uuid, text, text, boolean) from public;
revoke all on function public.edge_report(text, uuid, text, int, boolean, bigint, int, int, bigint, int, timestamptz) from public;
revoke all on function public.edge_board(text, uuid) from public;
revoke all on function public.edge_leave(text, uuid, text) from public;

grant execute on function public.edge_join(text, uuid, text, text, boolean) to anon, authenticated;
grant execute on function public.edge_report(text, uuid, text, int, boolean, bigint, int, int, bigint, int, timestamptz) to anon, authenticated;
grant execute on function public.edge_board(text, uuid) to anon, authenticated;
grant execute on function public.edge_leave(text, uuid, text) to anon, authenticated;
