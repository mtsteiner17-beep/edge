/*
 * EDGE game engine.
 * Pure logic, no DOM, no network. Runs in the browser (window.EdgeEngine) and in Node (tests/).
 *
 * The idea: a web app can't run while the phone is locked or dead, so we never try to "watch" the
 * battery in the background. Instead every time the app sees the battery (on open, on a level
 * change, on a 15s tick while it's on screen) it compares against the PREVIOUS sighting. If both
 * sightings were low, nothing was charging, and the level only went down, we credit the whole gap.
 * That means you earn points while your phone sits locked in your pocket, which is the entire point.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.EdgeEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---- Tunable rules -------------------------------------------------------
  const RULES = {
    LOW_MAX: 15,               // time only counts at or below this battery %
    STREAK_MAX: 10,            // a streak day needs a sighting at or below this %
    BASE_POINTS_PER_MIN: 1,    // multiplied by the tier below
    DEAD_POINTS_PER_MIN: 15,   // blackout minutes are worth the most
    DEAD_BONUS_LOW: 200,       // flat bonus if you went dark at 5% or less
    DEAD_BONUS_HIGH: 50,       // flat bonus otherwise
    MAX_GAP_CREDIT_S: 6 * 3600,// one gap between sightings earns at most this much
    MAX_DEAD_S: 24 * 3600,     // one blackout counts for at most this much
    MIN_DEAD_S: 5 * 60,        // shorter than this isn't a blackout
    MARK_MAX_LEVEL: 10,        // you can only arm a shutdown at or below this %
    TIERS: [
      { max: 1, mult: 10, label: 'MAX EDGE' },
      { max: 5, mult: 5, label: 'CRITICAL EDGE' },
      { max: 15, mult: 2, label: 'ON THE EDGE' },
    ],
  };

  const BADGE_NAMES = ['1% SURVIVOR', 'FLATLINER', 'BLACKOUT KING', 'VOLTAGE GAMBLER', 'ZERO HERO'];

  // ---- Small helpers -------------------------------------------------------
  const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
  const num = (v, d) => (typeof v === 'number' && isFinite(v) ? v : d);

  function tier(level, charging) {
    if (charging) return { mult: 0, label: 'DISQUALIFIED' };
    for (const t of RULES.TIERS) if (level <= t.max) return t;
    return { mult: 0, label: 'DRAIN LOWER' };
  }
  const multiplier = (level, charging) => tier(level, charging).mult;

  function dayKey(ms) {
    const d = new Date(ms);
    const p = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }
  function dayDiff(a, b) {
    const parse = (k) => { const [y, m, d] = k.split('-').map(Number); return Date.UTC(y, m - 1, d); };
    return Math.round((parse(b) - parse(a)) / 86400000);
  }

  function fmtDur(sec) {
    sec = Math.max(0, Math.floor(sec));
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    if (h > 0) return h + 'H ' + String(m).padStart(2, '0') + 'M';
    if (m > 0) return m + 'M';
    return sec + 'S';
  }

  // ---- State ---------------------------------------------------------------
  function newState() {
    return {
      v: 2,
      level: 100,
      charging: false,
      last: null,            // previous sighting: { t, level, charging }
      pointsExact: 0,
      edgeSeconds: 0,        // total credited time at <= LOW_MAX
      stretch5: 0,           // continuous credited seconds at <= 5%
      streak: 0,
      streakDay: '',
      lowest: 100,
      recordDead: 0,         // longest single blackout, seconds
      totalDead: 0,
      blackouts: 0,
      lastBlackout: null,    // { t, dead }
      badges: [false, false, false, false, false],
      shutdown: null,        // armed shutdown: { t, level, boot }
    };
  }

  // Rebuild a state object from whatever was in localStorage, ignoring junk.
  function hydrate(raw) {
    const s = newState();
    if (!raw || typeof raw !== 'object') return s;
    s.level = clamp(Math.round(num(raw.level, 100)), 0, 100);
    s.charging = !!raw.charging;
    if (raw.last && typeof raw.last === 'object' && isFinite(raw.last.t)) {
      s.last = { t: raw.last.t, level: clamp(Math.round(num(raw.last.level, 100)), 0, 100), charging: !!raw.last.charging };
    }
    s.pointsExact = Math.max(0, num(raw.pointsExact, 0));
    s.edgeSeconds = Math.max(0, num(raw.edgeSeconds, 0));
    s.stretch5 = Math.max(0, num(raw.stretch5, 0));
    s.streak = Math.max(0, Math.floor(num(raw.streak, 0)));
    s.streakDay = typeof raw.streakDay === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.streakDay) ? raw.streakDay : '';
    s.lowest = clamp(Math.round(num(raw.lowest, 100)), 0, 100);
    s.recordDead = Math.max(0, num(raw.recordDead, 0));
    s.totalDead = Math.max(0, num(raw.totalDead, 0));
    s.blackouts = Math.max(0, Math.floor(num(raw.blackouts, 0)));
    if (raw.lastBlackout && isFinite(raw.lastBlackout.t)) {
      s.lastBlackout = { t: raw.lastBlackout.t, dead: Math.max(0, num(raw.lastBlackout.dead, 0)) };
    }
    if (Array.isArray(raw.badges)) s.badges = s.badges.map((_, i) => !!raw.badges[i]);
    if (raw.shutdown && isFinite(raw.shutdown.t)) {
      s.shutdown = {
        t: raw.shutdown.t,
        level: clamp(Math.round(num(raw.shutdown.level, 100)), 0, 100),
        boot: String(raw.shutdown.boot || ''),
      };
    }
    return s;
  }

  function unlock(s, i, events) {
    if (!s.badges[i]) { s.badges[i] = true; events.push({ type: 'badge', index: i, name: BADGE_NAMES[i] }); }
  }

  function bumpStreak(s, now, events) {
    const today = dayKey(now);
    if (s.streakDay === today) return;
    const diff = s.streakDay ? dayDiff(s.streakDay, today) : Infinity;
    s.streak = diff === 1 ? s.streak + 1 : 1;
    s.streakDay = today;
    events.push({ type: 'streak', days: s.streak });
  }

  // ---- The core: every sighting of the battery goes through here -----------
  function observe(s, level, charging, now) {
    const events = [];
    level = clamp(Math.round(num(level, 100)), 0, 100);
    charging = !!charging;

    const prev = s.last;
    s.level = level;
    s.charging = charging;
    if (level < s.lowest) s.lowest = level;

    // An armed shutdown owns the clock: blackout time pays better, so don't double count.
    if (prev && now > prev.t && !s.shutdown) {
      const dt = (now - prev.t) / 1000;
      const lowBoth = prev.level <= RULES.LOW_MAX && level <= RULES.LOW_MAX;
      const qualifies = lowBoth && !prev.charging && !charging && level <= prev.level + 1;
      if (qualifies) {
        const credit = Math.min(dt, RULES.MAX_GAP_CREDIT_S);
        // be conservative: price the gap at the HIGHER of the two levels
        const mult = multiplier(Math.max(level, prev.level), false);
        const pts = (credit / 60) * RULES.BASE_POINTS_PER_MIN * mult;
        s.pointsExact += pts;
        s.edgeSeconds += credit;
        if (level <= 5 && prev.level <= 5) s.stretch5 += credit; else s.stretch5 = 0;
        if (pts > 0) events.push({ type: 'points', amount: pts, seconds: credit });
      } else {
        s.stretch5 = 0;
      }
    } else if (!prev) {
      s.stretch5 = 0;
    }

    if (!charging && level <= RULES.STREAK_MAX) bumpStreak(s, now, events);

    if (level <= 1 && !charging) unlock(s, 0, events);
    if (s.stretch5 >= 3600) unlock(s, 3, events);

    s.last = { t: now, level, charging };
    return events;
  }

  // ---- Blackouts -----------------------------------------------------------
  // Arm a shutdown: "I'm about to go dark." Only allowed when the battery is actually low.
  function markShutdown(s, now, boot) {
    if (s.shutdown) return { ok: false, reason: 'ALREADY_ARMED' };
    if (s.charging) return { ok: false, reason: 'CHARGING' };
    if (s.level > RULES.MARK_MAX_LEVEL) return { ok: false, reason: 'TOO_HIGH', max: RULES.MARK_MAX_LEVEL };
    s.shutdown = { t: now, level: s.level, boot: String(boot) };
    return { ok: true };
  }

  // What should the app do about the armed shutdown right now?
  //   ARMED        same page session, not long enough yet: keep waiting
  //   SAME_SESSION same page session AND time passed: the phone never died, so the page is still alive
  //   TOO_SHORT    fresh page session but under the minimum: doesn't count
  //   READY        fresh page session after a real gap: ask the player to confirm
  function checkShutdown(s, now, boot) {
    if (!s.shutdown) return { status: 'NONE' };
    const age = Math.max(0, (now - s.shutdown.t) / 1000);
    const sameBoot = s.shutdown.boot === String(boot);
    if (sameBoot) return { status: age >= RULES.MIN_DEAD_S ? 'SAME_SESSION' : 'ARMED', age };
    if (age < RULES.MIN_DEAD_S) return { status: 'TOO_SHORT', age };
    return { status: 'READY', age };
  }

  // What a blackout would be worth, without changing anything. poweredOnAgoS = how long ago
  // the player turned the phone back on (so time since then isn't counted as dead).
  function previewShutdown(s, now, poweredOnAgoS) {
    if (!s.shutdown) return { dead: 0, points: 0, counts: false };
    const age = Math.max(0, (now - s.shutdown.t) / 1000);
    const dead = Math.min(Math.max(0, age - Math.max(0, num(poweredOnAgoS, 0))), RULES.MAX_DEAD_S);
    const counts = dead >= RULES.MIN_DEAD_S;
    const bonus = s.shutdown.level <= 5 ? RULES.DEAD_BONUS_LOW : RULES.DEAD_BONUS_HIGH;
    const points = counts ? Math.floor((dead / 60) * RULES.DEAD_POINTS_PER_MIN) + bonus : 0;
    return { dead, points, counts, age };
  }

  // The player confirmed.
  function confirmShutdown(s, now, poweredOnAgoS) {
    if (!s.shutdown) return { ok: false, reason: 'NOTHING_ARMED' };
    const pv = previewShutdown(s, now, poweredOnAgoS);
    const dead = pv.dead;
    const events = [];
    if (!pv.counts) {
      s.shutdown = null;
      return { ok: false, reason: 'TOO_SHORT', dead, events };
    }
    const pts = pv.points;
    s.pointsExact += pts;
    s.totalDead += dead;
    s.blackouts += 1;
    if (dead > s.recordDead) s.recordDead = dead;
    s.lastBlackout = { t: s.shutdown.t, dead };
    unlock(s, 4, events);
    if (dead >= 2 * 3600) unlock(s, 1, events);
    if (dead >= 8 * 3600) unlock(s, 2, events);
    s.shutdown = null;
    s.last = null; // the gap was a blackout, not low-battery time
    s.stretch5 = 0;
    events.push({ type: 'blackout', dead, points: pts });
    return { ok: true, dead, points: pts, events };
  }

  function cancelShutdown(s) { s.shutdown = null; }

  // ---- Derived numbers -----------------------------------------------------
  function streakNow(s, now) {
    if (!s.streakDay) return 0;
    const diff = dayDiff(s.streakDay, dayKey(now));
    return diff >= 0 && diff <= 1 ? s.streak : 0;
  }
  const pointsNow = (s) => Math.floor(s.pointsExact);

  // What we tell the crew server.
  function snapshot(s, now) {
    return {
      level: s.level,
      charging: s.charging,
      points: pointsNow(s),
      streak: streakNow(s, now),
      record_dead: Math.round(s.recordDead),
      total_dead: Math.round(s.totalDead),
      lowest: s.lowest,
      dead_since: s.shutdown ? new Date(s.shutdown.t).toISOString() : null,
    };
  }

  return {
    RULES, BADGE_NAMES,
    tier, multiplier, dayKey, dayDiff, fmtDur,
    newState, hydrate,
    observe, markShutdown, checkShutdown, previewShutdown, confirmShutdown, cancelShutdown,
    streakNow, pointsNow, snapshot,
  };
});
