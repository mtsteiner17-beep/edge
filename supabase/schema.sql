-- Let It Die crew leaderboard backend.
--
-- Paste this whole file into Supabase -> SQL Editor -> New query -> Run.
-- It is safe to run more than once.
--
-- How it's locked down:
--   * The table has Row Level Security ON and ZERO policies, so the public browser key
--     cannot read or write it directly.
--   * The only way in is through the edge_* functions below (SECURITY DEFINER).
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
-- weekly race
--
-- Every crew has a weekly leaderboard that resets on Monday at midnight. "Midnight" is in the
-- timezone of the crew's oldest member (each phone reports its timezone with its numbers), so a
-- crew of friends in the same city gets a week that ends when they expect it to.
-- A player's week score is: lifetime points now minus lifetime points when the week started.
-- ---------------------------------------------------------------------------
alter table public.edge_players add column if not exists tz               text;
alter table public.edge_players add column if not exists week_key         date;            -- Monday this row's week_base belongs to
alter table public.edge_players add column if not exists week_base        bigint not null default 0;
alter table public.edge_players add column if not exists prev_week_points bigint not null default 0;

-- a timezone name we can trust, or null
create or replace function public.edge_clean_tz(p_tz text) returns text
language plpgsql
stable
as $$
begin
  if p_tz is null or length(p_tz) > 64 then return null; end if;
  perform timezone(p_tz, now());
  return p_tz;
exception when others then
  return null;
end;
$$;

-- the timezone a crew's weeks are measured in (its oldest member who has reported one)
create or replace function public.edge_crew_tz(p_crew text) returns text
language sql
stable
as $$
  select coalesce(
    (select tz from public.edge_players
      where crew = p_crew and tz is not null
      order by joined_at, player limit 1),
    'UTC');
$$;

-- the Monday (local date) of the week containing p_at
create or replace function public.edge_week_start(p_tz text, p_at timestamptz default now()) returns date
language sql
stable
as $$
  select date_trunc('week', timezone(coalesce(public.edge_clean_tz(p_tz), 'UTC'), p_at))::date;
$$;

-- the instant the next week begins
create or replace function public.edge_week_end(p_tz text, p_at timestamptz default now()) returns timestamptz
language sql
stable
as $$
  select ((public.edge_week_start(p_tz, p_at) + 7)::timestamp)
         at time zone coalesce(public.edge_clean_tz(p_tz), 'UTC');
$$;

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
-- (older copies of this file had no p_tz argument; drop that version so the two can't clash)
drop function if exists public.edge_report(text, uuid, text, int, boolean, bigint, int, int, bigint, int, timestamptz);

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
  p_dead_since  timestamptz default null,
  p_tz          text default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_crew   text := upper(trim(coalesce(p_crew, '')));
  v_hash   text := encode(sha256(convert_to(coalesce(p_key, ''), 'UTF8')), 'hex');
  v_dead   timestamptz;
  v_points bigint := least(greatest(coalesce(p_points, 0), 0), 100000000);
  v_row    public.edge_players;
  v_ws     date;
  v_base   bigint;
  v_prev   bigint;
begin
  -- a shutdown timestamp can't be in the future or older than two weeks
  if p_dead_since is not null and p_dead_since > now() - interval '14 days' then
    v_dead := least(p_dead_since, now());
  end if;

  -- check the key and remember this phone's timezone (this also locks the row)
  update public.edge_players
     set tz = coalesce(public.edge_clean_tz(p_tz), tz)
   where crew = v_crew and player = p_player and key_hash = v_hash
  returning * into v_row;
  if not found then raise exception 'NOT_IN_CREW'; end if;

  -- which week are we in, and where did this player's week start?
  v_ws := public.edge_week_start(public.edge_crew_tz(v_crew));
  if v_row.week_key is null then
    -- first report (new member, or a row from before weekly scoring): the week starts now
    v_base := v_points;
    v_prev := 0;
  elsif v_row.week_key <> v_ws then
    -- a new week began since the last report: bank last week, start fresh
    v_base := v_row.points;
    v_prev := case when v_row.week_key = v_ws - 7 then greatest(v_row.points - v_row.week_base, 0) else 0 end;
  else
    v_base := v_row.week_base;
    v_prev := v_row.prev_week_points;
  end if;
  v_base := least(v_base, v_points);   -- points were reset on the phone: restart the week from there

  update public.edge_players set
    level            = least(greatest(coalesce(p_level, 100), 0), 100),
    charging         = coalesce(p_charging, false),
    points           = v_points,
    streak           = least(greatest(coalesce(p_streak, 0), 0), 100000),
    record_dead      = least(greatest(coalesce(p_record_dead, 0), 0), 86400),
    total_dead       = least(greatest(coalesce(p_total_dead, 0), 0), 100000000),
    lowest           = least(greatest(coalesce(p_lowest, 100), 0), 100),
    dead_since       = v_dead,
    week_key         = v_ws,
    week_base        = v_base,
    prev_week_points = v_prev,
    updated_at       = now()
  where crew = v_crew and player = p_player;

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
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_crew text := upper(trim(coalesce(p_crew, '')));
  v_tz   text := public.edge_crew_tz(v_crew);
  v_ws   date := public.edge_week_start(public.edge_crew_tz(v_crew));
begin
  return jsonb_build_object(
    'now',       now(),
    'week_ends', public.edge_week_end(v_tz),
    'players', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'name',             x.name,
          'level',            x.level,
          'charging',         x.charging,
          'points',           x.points,
          'week_points',      x.wk,
          'prev_week_points', x.prev,
          'streak',           x.streak,
          'record_dead',      x.record_dead,
          'total_dead',       x.total_dead,
          'lowest',           x.lowest,
          'dead_since',       x.dead_since,
          'updated_at',       x.updated_at,
          'me',               coalesce(x.player = p_player, false)
        ) order by x.wk desc, x.points desc, x.name)
      from (
        select p.*,
               -- this week's score; someone who hasn't reported since the week began is on 0
               case when p.week_key = v_ws then greatest(p.points - p.week_base, 0) else 0 end as wk,
               -- last week's score, whether or not they've reported yet this week
               case when p.week_key = v_ws       then p.prev_week_points
                    when p.week_key = v_ws - 7   then greatest(p.points - p.week_base, 0)
                    else 0 end as prev
          from public.edge_players p
         where p.crew = v_crew
      ) x
    ), '[]'::jsonb)
  );
end;
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
  with gone as (
    delete from public.edge_players
     where crew = v_crew and player = p_player and key_hash = v_hash
    returning 1
  )
  delete from public.edge_pings
   where crew = v_crew and player = p_player and exists (select 1 from gone);
  return jsonb_build_object('ok', true);
end;
$$;

-- ---------------------------------------------------------------------------
-- iPhone auto check-in
--
-- iPhones don't let websites read the battery, but the Shortcuts app can. A Shortcut posts the
-- battery level here with a per-player "setup code" (a token). Only the token's SHA-256 hash is
-- stored, and the token can do exactly one thing: add a battery reading for its owner.
-- When the player opens EDGE, the app downloads the readings it missed and scores them.
-- ---------------------------------------------------------------------------
alter table public.edge_players add column if not exists ping_hash text;
create unique index if not exists edge_players_ping_hash_uq
  on public.edge_players (ping_hash) where ping_hash is not null;

create table if not exists public.edge_pings (
  id     bigint generated always as identity primary key,
  crew   text        not null,
  player uuid        not null,
  level  int         not null,
  at     timestamptz not null default now()
);
create index if not exists edge_pings_player_at on public.edge_pings (crew, player, at);
alter table public.edge_pings enable row level security;
revoke all on public.edge_pings from anon, authenticated;

-- make (or replace) your setup code. Asking again invalidates the old one.
create or replace function public.edge_make_token(
  p_crew   text,
  p_player uuid,
  p_key    text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_crew  text := upper(trim(coalesce(p_crew, '')));
  v_hash  text := encode(sha256(convert_to(coalesce(p_key, ''), 'UTF8')), 'hex');
  v_token text := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 20));
begin
  update public.edge_players
     set ping_hash = encode(sha256(convert_to(v_token, 'UTF8')), 'hex')
   where crew = v_crew and player = p_player and key_hash = v_hash;
  if not found then raise exception 'NOT_IN_CREW'; end if;
  return jsonb_build_object('token', v_token);
end;
$$;

-- the Shortcut calls this: "my battery is at X"
create or replace function public.edge_ping(
  p_token text,
  p_level numeric
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tok   text := upper(trim(coalesce(p_token, '')));
  v_hash  text := encode(sha256(convert_to(v_tok, 'UTF8')), 'hex');
  v_level int  := least(greatest(round(coalesce(p_level, 100))::int, 0), 100);
  v_row   public.edge_players;
begin
  if length(v_tok) < 16 then raise exception 'BAD_TOKEN'; end if;
  select * into v_row from public.edge_players where ping_hash = v_hash;
  if not found then raise exception 'BAD_TOKEN'; end if;

  -- automations sometimes fire twice: ignore a reading identical to the previous one if it came
  -- in the last 20 seconds
  if not exists (select 1 from (select level, at from public.edge_pings
                                 where crew = v_row.crew and player = v_row.player
                                 order by at desc limit 1) last
                  where last.level = v_level and last.at > now() - interval '20 seconds') then
    insert into public.edge_pings (crew, player, level, at)
    values (v_row.crew, v_row.player, v_level, clock_timestamp());
  end if;

  -- keep it small: 3 days, newest 200
  delete from public.edge_pings
   where crew = v_row.crew and player = v_row.player
     and (at < now() - interval '3 days'
          or id not in (select id from public.edge_pings
                         where crew = v_row.crew and player = v_row.player
                         order by at desc limit 200));

  -- friends see your level right away, even with the app closed
  update public.edge_players
     set level = v_level, charging = false, lowest = least(lowest, v_level), updated_at = now()
   where crew = v_row.crew and player = v_row.player;

  return jsonb_build_object('ok', true);
end;
$$;

-- the app calls this when it opens: "what did the Shortcut report since <cursor>?"
create or replace function public.edge_pings_since(
  p_crew   text,
  p_player uuid,
  p_key    text,
  p_since  timestamptz default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_crew text := upper(trim(coalesce(p_crew, '')));
  v_hash text := encode(sha256(convert_to(coalesce(p_key, ''), 'UTF8')), 'hex');
begin
  if not exists (select 1 from public.edge_players
                  where crew = v_crew and player = p_player and key_hash = v_hash) then
    raise exception 'NOT_IN_CREW';
  end if;
  return jsonb_build_object(
    'now', now(),
    'pings', coalesce((
      select jsonb_agg(jsonb_build_object('t', x.at, 'level', x.level) order by x.at)
        from (select at, level from public.edge_pings
               where crew = v_crew and player = p_player and (p_since is null or at > p_since)
               order by at limit 200) x
    ), '[]'::jsonb)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- permissions: browser key may call the functions, nothing else
-- ---------------------------------------------------------------------------
revoke all on function public.edge_join(text, uuid, text, text, boolean) from public;
revoke all on function public.edge_report(text, uuid, text, int, boolean, bigint, int, int, bigint, int, timestamptz, text) from public;
revoke all on function public.edge_board(text, uuid) from public;
revoke all on function public.edge_leave(text, uuid, text) from public;

grant execute on function public.edge_join(text, uuid, text, text, boolean) to anon, authenticated;
grant execute on function public.edge_report(text, uuid, text, int, boolean, bigint, int, int, bigint, int, timestamptz, text) to anon, authenticated;
grant execute on function public.edge_board(text, uuid) to anon, authenticated;
grant execute on function public.edge_leave(text, uuid, text) to anon, authenticated;

revoke all on function public.edge_make_token(text, uuid, text) from public;
revoke all on function public.edge_ping(text, numeric) from public;
revoke all on function public.edge_pings_since(text, uuid, text, timestamptz) from public;

grant execute on function public.edge_make_token(text, uuid, text) to anon, authenticated;
grant execute on function public.edge_ping(text, numeric) to anon, authenticated;
grant execute on function public.edge_pings_since(text, uuid, text, timestamptz) to anon, authenticated;

-- the weekly-race helpers are internal: the browser key can't call them
revoke all on function public.edge_clean_tz(text) from public, anon, authenticated;
revoke all on function public.edge_crew_tz(text) from public, anon, authenticated;
revoke all on function public.edge_week_start(text, timestamptz) from public, anon, authenticated;
revoke all on function public.edge_week_end(text, timestamptz) from public, anon, authenticated;
