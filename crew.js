/*
 * Let It Die crew client.
 * Talks to the Postgres functions in supabase/schema.sql through Supabase's REST "rpc" endpoint.
 * No SDK, just fetch. If config.js has no SUPABASE_URL / SUPABASE_KEY, crew mode is off and this
 * file does nothing.
 */
(function (root) {
  'use strict';

  const CFG = root.EDGE_CONFIG || {};
  const STORE = 'edge_crew_v1';
  const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I

  const enabled = () => !!(CFG.SUPABASE_URL && CFG.SUPABASE_KEY);

  // ---- identity (lives only on this phone) --------------------------------
  function randomBytes(n) {
    const a = new Uint8Array(n);
    (root.crypto || root.msCrypto).getRandomValues(a);
    return a;
  }
  function uuid() {
    if (root.crypto && root.crypto.randomUUID) return root.crypto.randomUUID();
    const b = randomBytes(16);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
    return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
  }
  const randomKey = () => Array.from(randomBytes(16), (x) => x.toString(16).padStart(2, '0')).join('');
  const randomCode = () => Array.from(randomBytes(6), (x) => ALPHABET[x % ALPHABET.length]).join('');

  function me() {
    try {
      const m = JSON.parse(localStorage.getItem(STORE));
      return m && m.code && m.player && m.key ? m : null;
    } catch (e) { return null; }
  }
  function saveMe(m) { try { localStorage.setItem(STORE, JSON.stringify(m)); } catch (e) { /* private mode */ } }
  function clearMe() { try { localStorage.removeItem(STORE); } catch (e) { /* ignore */ } }

  // ---- transport ----------------------------------------------------------
  async function rpc(fn, body, opts) {
    const base = String(CFG.SUPABASE_URL).replace(/\/+$/, '');
    const headers = { 'Content-Type': 'application/json', apikey: CFG.SUPABASE_KEY };
    // Old-style anon keys are JWTs and go in both headers. New publishable keys are not JWTs: apikey only.
    if (/^eyJ/.test(CFG.SUPABASE_KEY)) headers.Authorization = 'Bearer ' + CFG.SUPABASE_KEY;
    const res = await fetch(base + '/rest/v1/rpc/' + fn, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      keepalive: !!(opts && opts.keepalive),
    });
    let data = null;
    try { data = await res.json(); } catch (e) { /* empty body */ }
    if (!res.ok) {
      const err = new Error((data && (data.message || data.error)) || 'HTTP ' + res.status);
      err.status = res.status;
      err.pg = data && data.code;
      throw err;
    }
    return data;
  }

  // Turn server/network errors into something you can read on a phone.
  function friendlyError(err) {
    const m = (err && err.message) || '';
    const map = {
      BAD_CODE: 'CREW CODE MUST BE 4-12 LETTERS OR NUMBERS',
      BAD_NAME: 'PICK A NAME (1-16 CHARACTERS)',
      BAD_KEY: 'THIS PHONE CAN\'T USE THAT NAME IN THAT CREW',
      NO_SUCH_CREW: 'NO CREW WITH THAT CODE. CHECK IT AND TRY AGAIN',
      NAME_TAKEN: 'SOMEONE IN THAT CREW ALREADY HAS THAT NAME',
      CREW_FULL: 'THAT CREW IS FULL (30 MAX)',
      CODE_TAKEN: 'THAT CODE IS TAKEN. TRY AGAIN',
      NOT_IN_CREW: 'YOU\'RE NOT IN THAT CREW ANYMORE',
      BAD_TOKEN: 'SETUP CODE NOT RECOGNIZED. MAKE A NEW ONE',
    };
    if (map[m]) return map[m];
    if (err && err.pg === 'PGRST202') return 'DATABASE NOT SET UP YET. RUN supabase/schema.sql';
    if (err && (err.status === 401 || err.status === 403)) return 'SERVER REJECTED THE KEY. CHECK config.js';
    if (err && err.name === 'TypeError') return 'CAN\'T REACH THE SERVER. OFFLINE?';
    return 'SERVER SAID: ' + (m || 'UNKNOWN ERROR').slice(0, 80);
  }

  // ---- actions ------------------------------------------------------------
  async function join(code, name) {
    const m = { code: String(code).trim().toUpperCase(), name: String(name).trim(), player: uuid(), key: randomKey() };
    const r = await rpc('edge_join', { p_crew: m.code, p_player: m.player, p_key: m.key, p_name: m.name, p_create: false });
    m.code = r.crew;
    saveMe(m);
    return m;
  }

  async function create(name) {
    const player = uuid();
    const key = randomKey();
    let lastErr;
    for (let i = 0; i < 5; i++) {
      const code = randomCode();
      try {
        const r = await rpc('edge_join', { p_crew: code, p_player: player, p_key: key, p_name: String(name).trim(), p_create: true });
        const m = { code: r.crew, name: String(name).trim(), player, key };
        saveMe(m);
        return m;
      } catch (e) {
        lastErr = e;
        if (e.message !== 'CODE_TAKEN') throw e; // only retry collisions
      }
    }
    throw lastErr;
  }

  // The phone's timezone decides when the crew's week ends (Monday midnight, in the oldest member's zone).
  function timezone() {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || null; } catch (e) { return null; }
  }

  // If the database hasn't been upgraded with the weekly race yet, the server doesn't know about p_tz.
  // Fall back to the old call so reporting keeps working, and remember it for this page load.
  let oldServer = false;

  async function report(snap, opts) {
    const m = me();
    if (!m) return null;
    const body = {
      p_crew: m.code, p_player: m.player, p_key: m.key,
      p_level: snap.level, p_charging: snap.charging, p_points: snap.points, p_streak: snap.streak,
      p_record_dead: snap.record_dead, p_total_dead: snap.total_dead, p_lowest: snap.lowest,
      p_dead_since: snap.dead_since,
    };
    const tz = timezone();
    if (tz && !oldServer) body.p_tz = tz;
    try {
      return await rpc('edge_report', body, opts);
    } catch (e) {
      if (body.p_tz && e && e.pg === 'PGRST202') {
        oldServer = true;
        delete body.p_tz;
        return rpc('edge_report', body, opts);
      }
      throw e;
    }
  }

  function board() {
    const m = me();
    if (!m) return Promise.resolve(null);
    return rpc('edge_board', { p_crew: m.code, p_player: m.player });
  }

  // ---- iPhone auto check-in (readings posted by a Shortcut while the app was closed) ----
  // The "cursor" is the timestamp of the newest reading we've already scored. It lives in the same
  // saved identity, so leaving a crew clears it.
  function setCursor(v) {
    const m = me();
    if (m) { m.since = v; saveMe(m); }
  }

  async function makeToken() {
    const m = me();
    if (!m) throw new Error('NOT_IN_CREW');
    const r = await rpc('edge_make_token', { p_crew: m.code, p_player: m.player, p_key: m.key });
    return r && r.token;
  }

  async function pingsSince() {
    const m = me();
    if (!m) return { pings: [] };
    const body = { p_crew: m.code, p_player: m.player, p_key: m.key };
    if (m.since) body.p_since = m.since;
    return rpc('edge_pings_since', body);
  }

  async function leave() {
    const m = me();
    if (!m) return;
    try { await rpc('edge_leave', { p_crew: m.code, p_player: m.player, p_key: m.key }); } catch (e) { /* leave locally anyway */ }
    clearMe();
  }

  root.EdgeCrew = { enabled, me, join, create, report, board, leave, makeToken, pingsSince, setCursor, friendlyError, randomCode };
})(typeof self !== 'undefined' ? self : this);
