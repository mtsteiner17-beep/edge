/*
 * EDGE UI.
 * Wires the page to the engine (engine.js) and the crew server (crew.js).
 * All the scoring rules live in engine.js; this file is just screens and plumbing.
 */
(function () {
  'use strict';

  const E = window.EdgeEngine;
  const Crew = window.EdgeCrew;
  const CFG = window.EDGE_CONFIG || {};
  const DEBUG = new URLSearchParams(location.search).has('debug');

  const STORE_KEY = 'edge_v2';
  const NAME_KEY = 'edge_name';
  const BOOT = Math.random().toString(36).slice(2) + Date.now().toString(36); // new every page load
  const TICK_MS = 15 * 1000;       // sighting cadence while the app is on screen
  const REPORT_MS = 30 * 1000;     // at most one crew report per this
  const POLL_MS = 20 * 1000;       // leaderboard refresh while the crew tab is open
  const STALE_S = 6 * 3600;        // a crew report older than this is "last seen", not live

  const $ = (id) => document.getElementById(id);
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private mode: play without saving */ } },
    remove(k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } },
  };
  const clock = (t) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).toUpperCase();

  // ---- state ----------------------------------------------------------------
  let state;
  try { state = E.hydrate(JSON.parse(store.get(STORE_KEY))); } catch (e) { state = E.newState(); }
  let mode = 'pending';            // 'api' (browser reads the battery) | 'manual' (honor system)
  let battery = null;
  let override = null;             // debug only: { level, charging }
  let activeSticker = 'SURVIVED 1%';
  let currentTab = 'sensor';
  let sortBy = 'low';
  let lastBoard = null;
  let lastReportAt = 0;
  let crewRank = null;             // { rank, total } by "lowest now"
  let fontsReady = false;

  const save = () => store.set(STORE_KEY, JSON.stringify(state));

  // Does this phone have real Comic Sans? (Macs, iPhones and Windows do; most Androids don't and get the
  // Comic Neue lookalike, which we thicken a little so the logo keeps its weight.)
  const REAL_COMIC = (() => {
    try {
      const c = document.createElement('canvas').getContext('2d');
      c.font = '700 40px monospace';
      const plain = c.measureText('EDGE.').width;
      c.font = '700 40px "Comic Sans MS", monospace';
      return c.measureText('EDGE.').width !== plain;
    } catch (e) { return true; }
  })();
  document.documentElement.classList.toggle('no-comic-sans', !REAL_COMIC);

  // ---- toasts (textContent only, so a crewmate's name can never inject HTML) ----
  function toast(msg) {
    const box = $('toast-container');
    const el = document.createElement('div');
    el.className = 'bg-black text-white border-sharp p-3 font-mono text-xs shadow-brutal flex justify-between items-center pointer-events-auto';
    const span = document.createElement('span');
    span.textContent = msg;
    const x = document.createElement('button');
    x.className = 'ml-2 font-bold text-[#FF007A]';
    x.textContent = '×';
    x.setAttribute('aria-label', 'Dismiss');
    x.addEventListener('click', () => el.remove());
    el.append(span, x);
    box.appendChild(el);
    while (box.children.length > 3) box.firstChild.remove();
    setTimeout(() => el.remove(), 4000);
  }

  const show = (id, on) => $(id).classList.toggle('hidden', !on);

  // ---- rendering the main screens -----------------------------------------
  function render() {
    const now = Date.now();
    const sighted = !!state.last;
    const lvl = state.level;

    $('battery-level-text').textContent = sighted ? lvl + '%' : '--%';
    $('battery-fill-bar').style.height = (sighted ? lvl : 0) + '%';
    $('battery-fill-bar').style.backgroundColor = state.charging ? '#FF007A' : lvl <= 5 ? '#21FF00' : '#00F0FF';

    const t = E.tier(lvl, state.charging);
    $('multiplier-text').textContent = state.charging ? '🔌 CHARGING: 0X' : '⚡ MULTIPLIER ' + t.mult + 'X';
    show('manual-override-card', mode === 'manual');

    // armed shutdown
    const armed = !!state.shutdown;
    show('shutdown-idle', !armed);
    show('shutdown-armed', armed);
    if (armed) $('armed-time').textContent = clock(state.shutdown.t);

    // stats
    const pts = E.pointsNow(state).toLocaleString() + ' PTS';
    $('stat-edge-points-mini').textContent = pts;
    $('stat-dead-hours-mini').textContent = E.fmtDur(state.recordDead);
    const streak = E.streakNow(state, now);
    $('stat-streak-full').textContent = streak + (streak === 1 ? ' DAY' : ' DAYS');
    $('stat-lowest-full').textContent = state.lowest + '%';

    // sticker that reflects your real last blackout
    const died = $('sticker-died');
    const label = state.lastBlackout ? 'DIED AT ' + clock(state.lastBlackout.t) : 'BATTERY DIED';
    if (activeSticker === died.dataset.sticker) activeSticker = label;
    died.dataset.sticker = label;
    died.textContent = '💀 ' + label;
    highlightSticker();

    updateBadgesUI();
  }

  function updateBadgesUI() {
    for (let i = 0; i < 5; i++) {
      $('badge-card-' + (i + 1)).classList.toggle('badge-locked', !state.badges[i]);
    }
  }

  function handleEvents(events) {
    for (const ev of events) {
      if (ev.type === 'badge') toast('🏆 ' + ev.name);
    }
  }

  // ---- battery --------------------------------------------------------------
  function sight(level, charging) {
    const events = E.observe(state, level, charging, Date.now());
    save();
    handleEvents(events);
    render();
    scheduleReport(false);
  }

  function sightApi() {
    if (override) return sight(override.level, override.charging);
    if (battery) sight(Math.round(battery.level * 100), battery.charging);
  }

  async function initBattery() {
    if (navigator.getBattery) {
      try {
        battery = await navigator.getBattery();
        mode = 'api';
        battery.addEventListener('levelchange', sightApi);
        battery.addEventListener('chargingchange', sightApi);
        sightApi();
        return;
      } catch (e) { /* fall through to manual */ }
    }
    mode = 'manual';
    const slider = $('manual-battery-slider');
    slider.value = Math.max(1, state.level);
    updateCheckinLabel();
    render();
  }

  function updateCheckinLabel() {
    $('btn-checkin').textContent = 'CHECK IN AT ' + $('manual-battery-slider').value + '% ⚡';
  }

  // ---- shutdown / blackout flow --------------------------------------------
  function handleShutdownState() {
    const r = E.checkShutdown(state, Date.now(), BOOT);
    if (r.status === 'SAME_SESSION') {
      E.cancelShutdown(state);
      save();
      toast('PHONE NEVER DIED. SHUTDOWN CANCELLED.');
      scheduleReport(true);
    } else if (r.status === 'TOO_SHORT') {
      E.cancelShutdown(state);
      save();
      toast('UNDER 5 MIN. NOT A BLACKOUT.');
      scheduleReport(true);
    } else if (r.status === 'READY' && $('welcome-modal').classList.contains('hidden')) {
      openWelcome();
    }
    render();
  }

  const POWER_ON_OPTIONS = [
    [0, 'JUST NOW'], [600, '10 MIN AGO'], [1800, '30 MIN AGO'], [3600, '1 HOUR AGO'],
    [7200, '2 HOURS AGO'], [14400, '4 HOURS AGO'], [28800, '8 HOURS AGO'], [43200, '12 HOURS AGO'],
  ];

  function openWelcome() {
    const age = (Date.now() - state.shutdown.t) / 1000;
    $('welcome-text').textContent = 'WENT DARK AT ' + clock(state.shutdown.t) + ' · ' + E.fmtDur(age) + ' AGO';
    const sel = $('welcome-poweron');
    sel.replaceChildren();
    POWER_ON_OPTIONS.forEach(([secs, label]) => {
      if (secs === 0 || age - secs >= E.RULES.MIN_DEAD_S) {
        const o = document.createElement('option');
        o.value = String(secs);
        o.textContent = label;
        sel.appendChild(o);
      }
    });
    updateWelcomePreview();
    show('welcome-modal', true);
  }

  function updateWelcomePreview() {
    if (!state.shutdown) return;
    const pv = E.previewShutdown(state, Date.now(), Number($('welcome-poweron').value));
    $('welcome-dead').textContent = pv.counts ? E.fmtDur(pv.dead) : '0M';
    $('welcome-pts').textContent = '+' + pv.points.toLocaleString() + ' PTS';
    $('btn-welcome-log').disabled = !pv.counts;
  }

  // ---- crew -------------------------------------------------------------------
  function snapshotNow() { return E.snapshot(state, Date.now()); }

  function scheduleReport(force, keepalive) {
    if (!Crew.enabled() || !Crew.me() || !state.last) return;
    const now = Date.now();
    if (!force && now - lastReportAt < REPORT_MS) return;
    lastReportAt = now;
    Crew.report(snapshotNow(), { keepalive: !!keepalive }).catch((e) => {
      if (currentTab === 'crew') setCrewStatus(Crew.friendlyError(e));
    });
  }

  function setCrewStatus(msg) { $('crew-status').textContent = msg; }
  function crewError(msg) {
    const el = $('crew-error');
    el.textContent = msg || '';
    el.classList.toggle('hidden', !msg);
  }

  function renderCrewPanels() {
    const enabled = Crew.enabled();
    const me = enabled ? Crew.me() : null;
    show('crew-join', enabled && !me);
    show('crew-board', enabled && !!me);
    if (me) $('crew-code-text').textContent = me.code;
    const invite = $('btn-crew-invite');
    invite.textContent = navigator.share ? 'SHARE INVITE' : 'COPY INVITE';
  }

  function decorate(p, nowSrv) {
    const ageS = Math.max(0, (nowSrv - Date.parse(p.updated_at)) / 1000);
    const deadSince = p.dead_since ? Date.parse(p.dead_since) : null;
    const deadNowS = deadSince ? Math.max(0, (nowSrv - deadSince) / 1000) : 0;
    const stale = ageS > STALE_S;
    return Object.assign({}, p, {
      ageS, deadSince, deadNowS, stale,
      group: deadSince ? 0 : stale ? 3 : p.charging ? 2 : 1,
      bestDead: Math.max(p.record_dead, deadNowS),
    });
  }

  const SORTERS = {
    low: (a, b) => a.group - b.group
      || (a.group === 0 ? b.deadNowS - a.deadNowS : a.level - b.level)
      || b.points - a.points,
    dead: (a, b) => b.bestDead - a.bestDead || b.total_dead - a.total_dead,
    points: (a, b) => b.points - a.points || a.name.localeCompare(b.name),
  };
  const RANK_BG = ['bg-[#21FF00]', 'bg-[#00F0FF]', 'bg-[#FFE600]'];

  function rowEl(p, rank) {
    const li = document.createElement('li');
    li.className = 'border-sharp p-2 shadow-brutal-sm flex items-center gap-3 ' + (p.me ? 'bg-[#FFE6F2]' : 'bg-white');

    const rankBox = document.createElement('div');
    rankBox.className = 'w-9 h-9 border-sharp flex items-center justify-center font-black text-sm shrink-0 ' + (RANK_BG[rank - 1] || 'bg-white');
    rankBox.textContent = '#' + rank;

    const mid = document.createElement('div');
    mid.className = 'flex-1 min-w-0';
    const name = document.createElement('div');
    name.className = 'font-black text-sm truncate';
    name.textContent = p.name.toUpperCase() + (p.me ? ' (YOU)' : '');
    const sub = document.createElement('div');
    sub.className = 'text-[10px] text-gray-700 font-bold uppercase leading-tight';
    let subText;
    if (p.deadSince) subText = '💀 SINCE ' + clock(p.deadSince);
    else if (p.charging) subText = '🔌 CHARGING';
    else if (p.stale) subText = '😴 ' + E.fmtDur(p.ageS) + ' AGO';
    else subText = p.ageS < 90 ? '● LIVE' : E.fmtDur(p.ageS) + ' AGO';
    sub.textContent = subText;
    mid.append(name, sub);

    const right = document.createElement('div');
    right.className = 'text-right shrink-0';
    const big = document.createElement('div');
    big.className = 'text-xl font-black';
    if (sortBy === 'low') big.textContent = p.deadSince ? 'DEAD' : p.level + '%';
    else if (sortBy === 'dead') big.textContent = E.fmtDur(p.bestDead);
    else big.textContent = p.points.toLocaleString();
    right.append(big);

    li.append(rankBox, mid, right);
    return li;
  }

  function renderBoard() {
    const list = $('crew-list');
    list.replaceChildren();
    if (!lastBoard) return;
    const nowSrv = Date.parse(lastBoard.now) || Date.now();
    const rows = lastBoard.players.map((p) => decorate(p, nowSrv));

    // rank for the story card is always by "lowest now"
    const byLow = rows.slice().sort(SORTERS.low);
    const myIdx = byLow.findIndex((p) => p.me);
    crewRank = myIdx >= 0 ? { rank: myIdx + 1, total: byLow.length } : null;

    rows.sort(SORTERS[sortBy]);
    rows.forEach((p, i) => list.appendChild(rowEl(p, i + 1)));
  }

  async function refreshBoard() {
    if (!Crew.enabled() || !Crew.me()) return;
    try {
      if (state.last) { await Crew.report(snapshotNow()); lastReportAt = Date.now(); }
      lastBoard = await Crew.board();
      renderBoard();
      setCrewStatus('');
    } catch (e) {
      setCrewStatus(Crew.friendlyError(e));
      if (lastBoard) renderBoard();
    }
  }

  function setSort(key) {
    sortBy = key;
    document.querySelectorAll('.sort-btn').forEach((b) => {
      const on = b.dataset.sort === key;
      b.classList.toggle('bg-[#21FF00]', on);
      b.classList.toggle('bg-white', !on);
    });
    renderBoard();
  }

  function inviteUrl(code) {
    return location.origin + location.pathname + '#crew=' + encodeURIComponent(code);
  }

  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch (e) { /* fall back */ }
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch (e) { return false; }
  }

  function afterJoin() {
    renderCrewPanels();
    crewError('');
    history.replaceState(null, '', location.pathname + location.search);
    lastBoard = null;
    scheduleReport(true);
    refreshBoard();
  }

  async function withBusy(ids, fn) {
    ids.forEach((id) => { $(id).disabled = true; });
    try { await fn(); } finally { ids.forEach((id) => { $(id).disabled = false; }); }
  }

  // ---- tabs ----------------------------------------------------------------
  function setTab(tab) {
    currentTab = tab;
    ['sensor', 'crew', 'badges', 'share'].forEach((k) => {
      const on = k === tab;
      const btn = $('tab-' + k);
      btn.classList.toggle('bg-[#FFE600]', on);
      btn.classList.toggle('bg-[#F5F5F0]', !on);
      btn.setAttribute('aria-selected', String(on));
      show('view-' + k, on);
    });
    if (tab === 'badges') updateBadgesUI();
    if (tab === 'crew') { renderCrewPanels(); refreshBoard(); }
    if (tab === 'share') renderStoryCanvas();
  }

  // ---- story card (1080x1920) ----------------------------------------------
  const canvas = $('story-canvas');
  const ctx = canvas.getContext('2d');
  const SANS = 'Inter, "Helvetica Neue", Arial, sans-serif';
  const MONO = '"Space Mono", "Courier New", monospace';
  const LOGO = '"Comic Sans MS", "Comic Sans", "Comic Neue", cursive';

  async function ensureFonts() {
    if (fontsReady || !document.fonts || !document.fonts.load) return;
    try {
      await Promise.all([
        document.fonts.load('900 110px Inter'),
        document.fonts.load('700 36px "Space Mono"'),
        document.fonts.load('700 120px "Comic Neue"'),
      ]);
      fontsReady = true;
    } catch (e) { /* draw with fallbacks */ }
  }

  // shrink the font until the text fits maxW
  function fit(text, maxW, weight, family, startPx, minPx) {
    let px = startPx;
    ctx.font = weight + ' ' + px + 'px ' + family;
    while (px > (minPx || 20) && ctx.measureText(text).width > maxW) {
      px -= 2;
      ctx.font = weight + ' ' + px + 'px ' + family;
    }
    return px;
  }

  function logoText(text, x, y, color) {
    ctx.save();
    ctx.font = '700 130px ' + LOGO;
    ctx.fillStyle = color;
    ctx.fillText(text, x, y);
    if (!REAL_COMIC) {
      ctx.strokeStyle = color;
      ctx.lineWidth = 5;
      ctx.lineJoin = 'round';
      ctx.strokeText(text, x, y);
    }
    ctx.restore();
  }

  async function renderStoryCanvas() {
    await ensureFonts();
    const w = canvas.width;
    const h = canvas.height;
    const now = Date.now();

    ctx.textAlign = 'left';
    ctx.fillStyle = '#F5F5F0';
    ctx.fillRect(0, 0, w, h);

    ctx.strokeStyle = '#000000';
    ctx.lineWidth = 14;
    ctx.strokeRect(40, 40, w - 80, h - 80);

    // header
    ctx.fillStyle = '#0055FF';
    ctx.fillRect(40, 40, w - 80, 220);
    ctx.strokeRect(40, 40, w - 80, 220);
    ctx.font = '700 130px ' + LOGO;
    const edgeW = ctx.measureText('EDGE').width;
    logoText('EDGE', 80, 195, '#FFFFFF');
    logoText('.', 80 + edgeW, 195, '#FF007A');

    // current voltage
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(80, 310, w - 160, 480);
    ctx.strokeRect(80, 310, w - 160, 480);
    ctx.fillStyle = '#000000';
    ctx.font = '700 40px ' + MONO;
    ctx.fillText('CURRENT VOLTAGE:', 120, 380);
    ctx.fillStyle = state.level <= 5 && !state.charging ? '#FF007A' : '#000000';
    ctx.font = '900 220px ' + SANS;
    ctx.fillText((state.last ? state.level : '--') + '%', 120, 640);

    // record dead (left)
    ctx.fillStyle = '#00F0FF';
    ctx.fillRect(80, 820, 440, 320);
    ctx.strokeRect(80, 820, 440, 320);
    ctx.fillStyle = '#000000';
    ctx.font = '700 32px ' + MONO;
    ctx.fillText('RECORD DEAD:', 110, 880);
    fit(E.fmtDur(state.recordDead), 380, 900, SANS, 100, 40);
    ctx.fillText(E.fmtDur(state.recordDead), 110, 1040);

    // points (right)
    ctx.fillStyle = '#7000FF';
    ctx.fillRect(560, 820, 440, 320);
    ctx.strokeRect(560, 820, 440, 320);
    ctx.fillStyle = '#FFFFFF';
    ctx.font = '700 32px ' + MONO;
    ctx.fillText('EDGE POINTS:', 590, 880);
    const ptsText = E.pointsNow(state).toLocaleString();
    fit(ptsText, 380, 900, SANS, 85, 36);
    ctx.fillText(ptsText, 590, 1030);

    // flex sticker
    ctx.fillStyle = '#21FF00';
    ctx.fillRect(80, 1180, w - 160, 220);
    ctx.strokeRect(80, 1180, w - 160, 220);
    ctx.fillStyle = '#000000';
    const stickerText = '[ ' + activeSticker + ' ]';
    fit(stickerText, w - 160 - 60, 900, SANS, 62, 28);
    ctx.textAlign = 'center';
    ctx.fillText(stickerText, w / 2, 1310);
    ctx.textAlign = 'left';

    // streak + crew rank (or lowest ever)
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(80, 1440, 440, 200);
    ctx.strokeRect(80, 1440, 440, 200);
    ctx.fillStyle = '#000000';
    ctx.font = '700 30px ' + MONO;
    ctx.fillText('STREAK:', 110, 1495);
    const streak = E.streakNow(state, now);
    ctx.fillStyle = '#FF007A';
    ctx.font = '900 110px ' + SANS;
    const streakNum = String(streak);
    ctx.fillText(streakNum, 110, 1600);
    const numW = ctx.measureText(streakNum).width;
    ctx.font = '900 44px ' + SANS;
    ctx.fillText(streak === 1 ? 'DAY' : 'DAYS', 110 + numW + 18, 1600);

    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(560, 1440, 440, 200);
    ctx.strokeRect(560, 1440, 440, 200);
    ctx.fillStyle = '#000000';
    ctx.font = '700 30px ' + MONO;
    let boxLabel, boxValue;
    if (Crew.enabled() && Crew.me() && crewRank) {
      boxLabel = 'CREW RANK:';
      boxValue = '#' + crewRank.rank + ' OF ' + crewRank.total;
    } else {
      boxLabel = 'LOWEST EVER:';
      boxValue = state.lowest + '%';
    }
    ctx.fillText(boxLabel, 590, 1495);
    fit(boxValue, 380, 900, SANS, 80, 36);
    ctx.fillStyle = '#7000FF';
    ctx.fillText(boxValue, 590, 1595);

    // footer
    ctx.fillStyle = '#FFE600';
    ctx.fillRect(40, h - 220, w - 80, 180);
    ctx.strokeRect(40, h - 220, w - 80, 180);
    ctx.fillStyle = '#000000';
    const mark = CFG.WATERMARK || location.host || 'EDGE';
    fit(mark, w - 160, 700, MONO, 42, 20);
    ctx.fillText(mark, 80, h - 110);
  }

  function highlightSticker() {
    document.querySelectorAll('.sticker-btn').forEach((b) => {
      const on = b.dataset.sticker === activeSticker;
      b.classList.toggle('bg-[#21FF00]', on);
      b.classList.toggle('bg-white', !on);
    });
  }

  function canvasBlob() {
    return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  }

  function downloadBlob(blob) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'EDGE-Story-' + Date.now() + '.png';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    toast('SAVED');
  }

  // ---- wire up the buttons ---------------------------------------------------
  function wire() {
    // tabs
    ['sensor', 'crew', 'badges', 'share'].forEach((k) => $('tab-' + k).addEventListener('click', () => setTab(k)));

    // manual check-in
    $('manual-battery-slider').addEventListener('input', updateCheckinLabel);
    $('btn-checkin').addEventListener('click', () => {
      const lvl = Number($('manual-battery-slider').value);
      sight(lvl, false);
    });

    // shutdown logger
    $('btn-mark-shutdown').addEventListener('click', () => {
      const r = E.markShutdown(state, Date.now(), BOOT);
      if (!r.ok) {
        if (r.reason === 'TOO_HIGH') toast('MUST BE ' + r.max + '% OR LESS.');
        else if (r.reason === 'CHARGING') toast('UNPLUG FIRST.');
        return;
      }
      save();
      render();
      scheduleReport(true);
      show('shutdown-modal', true);
    });
    $('btn-close-shutdown-modal').addEventListener('click', () => show('shutdown-modal', false));
    $('btn-cancel-shutdown').addEventListener('click', () => {
      E.cancelShutdown(state);
      save();
      render();
      scheduleReport(true);
    });

    // welcome back
    $('welcome-poweron').addEventListener('change', updateWelcomePreview);
    $('btn-welcome-log').addEventListener('click', () => {
      const r = E.confirmShutdown(state, Date.now(), Number($('welcome-poweron').value));
      save();
      show('welcome-modal', false);
      if (r.ok) {
        toast('💀 +' + r.points.toLocaleString() + ' PTS');
        handleEvents(r.events);
      } else {
        toast('TOO SHORT TO COUNT.');
      }
      render();
      scheduleReport(true);
    });
    $('btn-welcome-no').addEventListener('click', () => {
      E.cancelShutdown(state);
      save();
      show('welcome-modal', false);
      render();
      scheduleReport(true);
    });

    // crew
    $('crew-code').addEventListener('input', (e) => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); });
    $('btn-crew-join').addEventListener('click', () => {
      const name = $('crew-name').value.trim();
      const code = $('crew-code').value.trim();
      if (!name) return crewError('PICK A NAME FIRST');
      if (!code) return crewError('ENTER A CREW CODE, OR TAP NEW CREW');
      crewError('');
      withBusy(['btn-crew-join', 'btn-crew-create'], async () => {
        try { await Crew.join(code, name); store.set(NAME_KEY, name); afterJoin(); } catch (e) { crewError(Crew.friendlyError(e)); }
      });
    });
    $('btn-crew-create').addEventListener('click', () => {
      const name = $('crew-name').value.trim();
      if (!name) return crewError('PICK A NAME FIRST');
      crewError('');
      withBusy(['btn-crew-join', 'btn-crew-create'], async () => {
        try { await Crew.create(name); store.set(NAME_KEY, name); afterJoin(); } catch (e) { crewError(Crew.friendlyError(e)); }
      });
    });
    $('btn-crew-refresh').addEventListener('click', () => { refreshBoard(); });
    $('btn-crew-invite').addEventListener('click', async () => {
      const me = Crew.me();
      if (!me) return;
      const url = inviteUrl(me.code);
      if (navigator.share) {
        try { await navigator.share({ title: 'Join my EDGE crew', text: 'Race me to 1%. Crew code ' + me.code, url }); return; } catch (e) { if (e && e.name === 'AbortError') return; }
      }
      toast((await copyText(url)) ? 'COPIED' : url);
    });
    $('btn-crew-leave').addEventListener('click', async () => {
      const me = Crew.me();
      if (!me || !window.confirm('Leave crew ' + me.code + '? Your row is removed for everyone.')) return;
      await Crew.leave();
      lastBoard = null;
      crewRank = null;
      $('crew-list').replaceChildren();
      renderCrewPanels();
    });
    document.querySelectorAll('.sort-btn').forEach((b) => b.addEventListener('click', () => { setSort(b.dataset.sort); }));

    // story card
    document.querySelectorAll('.sticker-btn').forEach((b) => b.addEventListener('click', () => {
      activeSticker = b.dataset.sticker;
      highlightSticker();
      renderStoryCanvas();
    }));
    $('btn-share-native').addEventListener('click', async () => {
      await renderStoryCanvas();
      const blob = await canvasBlob();
      if (!blob) return;
      const file = new File([blob], 'edge-voltage-card.png', { type: 'image/png' });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        try {
          await navigator.share({ files: [file], title: 'EDGE // Voltage Gambler', text: 'Living at ' + state.level + '% on EDGE.' });
        } catch (e) { /* cancelled */ }
      } else {
        downloadBlob(blob);
      }
    });
    $('btn-download-image').addEventListener('click', async () => {
      await renderStoryCanvas();
      const blob = await canvasBlob();
      if (blob) downloadBlob(blob);
    });

    // install
    let deferredPrompt = null;
    window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferredPrompt = e; });
    window.addEventListener('appinstalled', () => show('btn-pwa-trigger', false));
    const standalone = (window.matchMedia && matchMedia('(display-mode: standalone)').matches) || navigator.standalone;
    if (standalone) show('btn-pwa-trigger', false);
    $('btn-pwa-trigger').addEventListener('click', async () => {
      if (deferredPrompt) {
        deferredPrompt.prompt();
        try { await deferredPrompt.userChoice; } catch (e) { /* ignore */ }
        deferredPrompt = null;
      } else {
        show('pwa-modal', true);
      }
    });
    $('btn-close-pwa').addEventListener('click', () => show('pwa-modal', false));

    // debug tools
    if (DEBUG) {
      show('debug-panel', true);
      $('btn-force-1').addEventListener('click', () => {
        override = { level: 1, charging: false };
        sight(1, false);
        toast('⚡ 1% FORCED (DEBUG)');
      });
      $('btn-sim-shutdown').addEventListener('click', () => {
        state.shutdown = { t: Date.now() - 2.5 * 3600 * 1000, level: 2, boot: 'debug-old-boot' };
        save();
        handleShutdownState();
      });
      $('btn-reset-all').addEventListener('click', () => {
        store.remove(STORE_KEY);
        location.reload();
      });
    }

    // lifecycle
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        handleShutdownState();
        if (mode === 'api') sightApi();
        if (currentTab === 'crew') refreshBoard();
      } else {
        scheduleReport(true, true);
      }
    });
    window.addEventListener('pagehide', () => scheduleReport(true, true));
    window.addEventListener('online', () => scheduleReport(true));

    setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      if (mode === 'api') sightApi();
      else render(); // keeps streak/stats honest at midnight even in manual mode
    }, TICK_MS);
    setInterval(() => {
      if (document.visibilityState === 'visible' && currentTab === 'crew') refreshBoard();
    }, POLL_MS);
  }

  // ---- go --------------------------------------------------------------------
  function init() {
    wire();
    show('tab-crew', Crew.enabled());   // no crew tab until crews are set up in config.js

    // invite links look like  https://site/#crew=K7QX2M
    const m = /crew=([A-Za-z0-9]{4,12})/.exec(location.hash);
    if (m) $('crew-code').value = m[1].toUpperCase();
    $('crew-name').value = store.get(NAME_KEY) || '';
    renderCrewPanels();
    if (m && Crew.enabled() && !Crew.me()) setTab('crew');

    render();
    handleShutdownState();
    initBattery();

    if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
      navigator.serviceWorker.register('sw.js').catch(() => { /* offline support is optional */ });
    }
  }

  init();
})();
