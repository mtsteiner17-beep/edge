'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../engine.js');

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const T0 = new Date(2026, 9, 22, 9, 0, 0).getTime(); // Oct 22 2026, 9:00 local

function fresh() { return E.newState(); }

test('multiplier tiers', () => {
  assert.equal(E.multiplier(100, false), 0);
  assert.equal(E.multiplier(16, false), 0);
  assert.equal(E.multiplier(15, false), 2);
  assert.equal(E.multiplier(6, false), 2);
  assert.equal(E.multiplier(5, false), 5);
  assert.equal(E.multiplier(2, false), 5);
  assert.equal(E.multiplier(1, false), 10);
  assert.equal(E.multiplier(1, true), 0, 'charging is always 0x');
});

test('first sighting earns nothing, second low sighting credits the gap', () => {
  const s = fresh();
  E.observe(s, 4, false, T0);
  assert.equal(E.pointsNow(s), 0);
  const ev = E.observe(s, 3, false, T0 + 10 * MIN);
  // 10 min at the 5x tier (priced at the higher level, 4%)
  assert.equal(E.pointsNow(s), 50);
  assert.equal(ev.find((e) => e.type === 'points').seconds, 600);
});

test('gap is NOT credited when charging, when level jumped up, or when it started high', () => {
  let s = fresh();
  E.observe(s, 4, false, T0);
  E.observe(s, 4, true, T0 + 10 * MIN);
  assert.equal(E.pointsNow(s), 0, 'charging at the end');

  s = fresh();
  E.observe(s, 4, true, T0);
  E.observe(s, 4, false, T0 + 10 * MIN);
  assert.equal(E.pointsNow(s), 0, 'charging at the start');

  s = fresh();
  E.observe(s, 3, false, T0);
  E.observe(s, 12, false, T0 + 2 * HOUR);
  assert.equal(E.pointsNow(s), 0, 'level went UP, so it was charged in between');

  s = fresh();
  E.observe(s, 40, false, T0);
  E.observe(s, 10, false, T0 + 2 * HOUR);
  assert.equal(E.pointsNow(s), 0, 'started above the low line');
});

test('one gap is capped at 6 hours', () => {
  const s = fresh();
  E.observe(s, 1, false, T0);
  E.observe(s, 1, false, T0 + 48 * HOUR);
  assert.equal(s.edgeSeconds, 6 * 3600);
  assert.equal(E.pointsNow(s), 6 * 60 * 10);
});

test('1% battery wobble (level +1) still counts, +2 does not', () => {
  let s = fresh();
  E.observe(s, 8, false, T0);
  E.observe(s, 9, false, T0 + 10 * MIN);
  assert.ok(E.pointsNow(s) > 0);
  s = fresh();
  E.observe(s, 8, false, T0);
  E.observe(s, 10, false, T0 + 10 * MIN);
  assert.equal(E.pointsNow(s), 0);
});

test('streak: counts consecutive days, ignores same-day repeats, resets after a missed day', () => {
  const s = fresh();
  const day = (n) => T0 + n * 24 * HOUR;
  E.observe(s, 8, false, day(0));
  E.observe(s, 7, false, day(0) + HOUR);
  assert.equal(s.streak, 1);
  E.observe(s, 9, false, day(1));
  assert.equal(s.streak, 2);
  E.observe(s, 9, false, day(2));
  assert.equal(s.streak, 3);
  assert.equal(E.streakNow(s, day(3)), 3, 'still alive the day after');
  assert.equal(E.streakNow(s, day(4)), 0, 'dead after a missed day');
  E.observe(s, 9, false, day(5));
  assert.equal(s.streak, 1, 'restarts at 1');
});

test('streak needs <=10% and not charging', () => {
  const s = fresh();
  E.observe(s, 11, false, T0);
  E.observe(s, 5, true, T0 + MIN);
  assert.equal(s.streak, 0);
});

test('1% SURVIVOR needs 1% and no charger', () => {
  let s = fresh();
  E.observe(s, 1, true, T0);
  assert.equal(s.badges[0], false);
  E.observe(s, 1, false, T0 + MIN);
  assert.equal(s.badges[0], true);
});

test('VOLTAGE GAMBLER needs one continuous hour at <=5%, not just a visit', () => {
  const s = fresh();
  let t = T0;
  E.observe(s, 5, false, t);
  for (let i = 0; i < 100; i++) { t += 15 * 1000; E.observe(s, 4, false, t); }
  assert.equal(s.badges[3], false, '25 min is not an hour');
  for (let i = 0; i < 140; i++) { t += 15 * 1000; E.observe(s, 4, false, t); }
  assert.equal(s.badges[3], true);
});

test('VOLTAGE GAMBLER stretch resets when you climb back above 5%', () => {
  const s = fresh();
  E.observe(s, 4, false, T0);
  E.observe(s, 4, false, T0 + 50 * MIN);
  E.observe(s, 8, false, T0 + 51 * MIN);
  assert.equal(s.stretch5, 0);
  E.observe(s, 4, false, T0 + 52 * MIN);
  E.observe(s, 4, false, T0 + 80 * MIN);
  assert.equal(s.badges[3], false);
});

test('shutdown can only be armed at <=10% and not on a charger', () => {
  const s = fresh();
  E.observe(s, 55, false, T0);
  const r = E.markShutdown(s, T0, 'boot-A');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'TOO_HIGH');
  E.observe(s, 4, true, T0 + MIN);
  assert.equal(E.markShutdown(s, T0, 'boot-A').reason, 'CHARGING');
  E.observe(s, 4, false, T0 + 2 * MIN);
  assert.equal(E.markShutdown(s, T0 + 2 * MIN, 'boot-A').ok, true);
  assert.equal(E.markShutdown(s, T0 + 3 * MIN, 'boot-A').reason, 'ALREADY_ARMED');
});

test('cheat guard: same page session after real time passed means the phone never died', () => {
  const s = fresh();
  E.observe(s, 3, false, T0);
  E.markShutdown(s, T0, 'boot-A');
  assert.equal(E.checkShutdown(s, T0 + 2 * MIN, 'boot-A').status, 'ARMED');
  assert.equal(E.checkShutdown(s, T0 + 10 * MIN, 'boot-A').status, 'SAME_SESSION');
});

test('fresh page session after a real gap is READY; under 5 min is TOO_SHORT', () => {
  const s = fresh();
  E.observe(s, 3, false, T0);
  E.markShutdown(s, T0, 'boot-A');
  assert.equal(E.checkShutdown(s, T0 + 2 * MIN, 'boot-B').status, 'TOO_SHORT');
  assert.equal(E.checkShutdown(s, T0 + 3 * HOUR, 'boot-B').status, 'READY');
  assert.equal(E.checkShutdown(fresh(), T0, 'x').status, 'NONE');
});

test('confirming a 2.5h blackout: points, badges, record', () => {
  const s = fresh();
  E.observe(s, 2, false, T0);
  E.markShutdown(s, T0, 'boot-A');
  const r = E.confirmShutdown(s, T0 + 2.5 * HOUR, 0);
  assert.equal(r.ok, true);
  assert.equal(r.dead, 2.5 * 3600);
  assert.equal(r.points, 150 * 15 + 200);
  assert.equal(E.pointsNow(s), 150 * 15 + 200);
  assert.deepEqual(s.badges, [false, true, false, false, true]); // FLATLINER + ZERO HERO
  assert.equal(s.recordDead, 2.5 * 3600);
  assert.equal(s.shutdown, null);
  assert.equal(s.last, null);
});

test('powered-on-ago is deducted, and bonus is 50 when armed above 5%', () => {
  const s = fresh();
  E.observe(s, 9, false, T0);
  E.markShutdown(s, T0, 'boot-A');
  const r = E.confirmShutdown(s, T0 + 3 * HOUR, 3600); // turned it on an hour ago
  assert.equal(r.dead, 2 * 3600);
  assert.equal(r.points, 120 * 15 + 50);
});

test('8h blackout unlocks BLACKOUT KING; 40h is capped at 24h', () => {
  let s = fresh();
  E.observe(s, 1, false, T0);
  E.markShutdown(s, T0, 'A');
  E.confirmShutdown(s, T0 + 9 * HOUR, 0);
  assert.equal(s.badges[2], true);

  s = fresh();
  E.observe(s, 1, false, T0);
  E.markShutdown(s, T0, 'A');
  const r = E.confirmShutdown(s, T0 + 40 * HOUR, 0);
  assert.equal(r.dead, 24 * 3600);
});

test('confirm under the minimum clears the marker and pays nothing', () => {
  const s = fresh();
  E.observe(s, 2, false, T0);
  E.markShutdown(s, T0, 'A');
  const r = E.confirmShutdown(s, T0 + 2 * MIN, 0);
  assert.equal(r.ok, false);
  assert.equal(s.shutdown, null);
  assert.equal(E.pointsNow(s), 0);
  assert.equal(s.badges[4], false);
});

test('an armed shutdown does not also earn low-battery time', () => {
  const s = fresh();
  E.observe(s, 3, false, T0);
  E.markShutdown(s, T0, 'A');
  E.observe(s, 3, false, T0 + 30 * MIN);
  assert.equal(E.pointsNow(s), 0);
});

test('snapshot reports a dead_since only while armed', () => {
  const s = fresh();
  E.observe(s, 3, false, T0);
  assert.equal(E.snapshot(s, T0).dead_since, null);
  E.markShutdown(s, T0, 'A');
  assert.equal(E.snapshot(s, T0).dead_since, new Date(T0).toISOString());
  assert.equal(E.snapshot(s, T0).level, 3);
});

test('hydrate shrugs off garbage', () => {
  const s = E.hydrate({ level: 'banana', pointsExact: -5, streakDay: 'nope', badges: 'x', last: { t: 'x' }, shutdown: { t: NaN } });
  assert.equal(s.level, 100);
  assert.equal(s.pointsExact, 0);
  assert.equal(s.streakDay, '');
  assert.deepEqual(s.badges, [false, false, false, false, false]);
  assert.equal(s.last, null);
  assert.equal(s.shutdown, null);
  assert.equal(E.hydrate(null).level, 100);
});

test('hydrate round-trips a real state through JSON', () => {
  const s = fresh();
  E.observe(s, 2, false, T0);
  E.observe(s, 2, false, T0 + HOUR);
  const back = E.hydrate(JSON.parse(JSON.stringify(s)));
  assert.deepEqual(back, s);
});

test('fmtDur', () => {
  assert.equal(E.fmtDur(0), '0S');
  assert.equal(E.fmtDur(45), '45S');
  assert.equal(E.fmtDur(600), '10M');
  assert.equal(E.fmtDur(2.5 * 3600), '2H 30M');
});
