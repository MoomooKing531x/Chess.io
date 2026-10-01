#!/usr/bin/env node
'use strict';
/*
 CHESS.IO - three SEPARATE real-time multiplayer games in ONE file.
 (Super Chess has been removed. Its nav button still shows on the other games'
 menus with the same icon, greyed out and marked "Soon" - not clickable.)

   node chessio.js battlegrid   -> http://localhost:3000   (Battle Grid)
   node chessio.js kings        -> http://localhost:3001   (Battle of the Kings)
   node chessio.js pieces       -> http://localhost:3002   (Pieces with Pieces)
   node chessio.js selftest     -> headless automated tests (no ports, no assets)

 Each command starts its OWN server process with its own world, players, ELO and leaderboard.
 No npm install needed: HTTP + a small RFC6455 WebSocket server are built on Node core modules.

 Asset folders (override with env PIECES_DIR / TAGS_DIR, or put the folders next to this file):
   C:\Users\moomo\Downloads\chess IO_\pieces-basic-png
   C:\Users\moomo\Downloads\chess IO_\brilliance_v2
 Open http://localhost:<port>/debug/assets to see how every PNG was matched (and any unmatched ones).

 All balance numbers are in the BAL / GRID / PWP / KOTK objects directly below.
 Set CHESSIO_DEBUG=1 to enable the chat command  /tag <badge|all>  for previewing analysis badges.
*/
/* ============================== TABLE OF CONTENTS ==============================
   CONFIG                 - BAL / GRID / PWP / KOTK tunables
   ASSETS                 - PNG scanning + emoji badge fallback
   WEBSOCKET              - minimal RFC6455 server
   TEST HARNESS            - FakeConn + registerTest/runTests (classic games)
   SPATIAL HASH / ORBS    - shared collision grid + ELO orb fields
   ANALYSIS               - event-driven move/tag analysis (shared)
   BASE GAME              - Game/Player base class (battlegrid/kings/pieces)
   SHARED HELPERS
   GAME 1: BATTLE GRID    - port 3000
   GAME 3: PIECES WITH PIECES - port 3002
   GAME 2: BATTLE OF THE KINGS - port 3001
   CLIENT (clientMain)    - injected into battlegrid/kings/pieces pages
   PAGE + SERVER BOOTSTRAP
   ================================================================================ */
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const rnd = (a, b) => a + Math.random() * (b - a);
const r2 = v => Math.round(v * 100) / 100;
const sgn = v => v > .3 ? 1 : v < -.3 ? -1 : 0;
const SQ2 = Math.SQRT2;

/* ============================== CONFIG ============================== */
const MODES = {
  battlegrid: { port: 3000, title: 'Battle Grid' },
  kings: { port: 3001, title: 'Battle of the Kings' },
  pieces: { port: 3002, title: 'Pieces with Pieces' }
};
// [key, title, url, chess icon, notBuiltYet] - Super Chess has been removed; the nav
// button stays visible (same icon) but greyed out and unclickable ("Soon" badge).
let NAV = [
  ['battlegrid', 'Battle Grid', 'http://localhost:3000', 'p', 0],
  ['kings', 'Battle of the Kings', 'http://localhost:3001', 'k', 0],
  ['pieces', 'Pieces with Pieces', 'http://localhost:3002', 'n', 0],
  ['superchess', 'Super Chess', '', 'q', 1]
];

const BAL = {
  tick: 30,
  // hp, shield, damage, move range, chess value, regen HP per period, walking speed (tiles/sec)
  pieces: {
    p: { name: 'Pawn', hp: 100, shield: 0, dmg: 15, range: 2, val: 1, regen: 10, speed: 4.2 },
    n: { name: 'Knight', hp: 100, shield: 10, dmg: 25, range: 3, val: 3, regen: 12, speed: 4.6 },
    b: { name: 'Bishop', hp: 100, shield: 15, dmg: 30, range: 8, val: 3, regen: 12, speed: 4.6 },
    r: { name: 'Rook', hp: 100, shield: 20, dmg: 35, range: 8, val: 5, regen: 15, speed: 4.4 },
    q: { name: 'Queen', hp: 100, shield: 25, dmg: 40, range: 8, val: 9, regen: 18, speed: 4.8 },
    k: { name: 'King', hp: 100, shield: 30, dmg: 20, range: 1, val: 0, regen: 10, speed: 4.6 }
  },
  regen: { delayMs: 5000, periodSec: 2, shieldPerSec: 4 },   // natural regen only. No healing item / key / cost.
  spawnProtectMs: 30000,
  elo: { orb: 100, killShare: 0.5, respawnMs: 20000 },
  knock: { dist: 1.6, durMs: 180, stunMs: 350, immuneMs: 900 }, // immune = anti stun-lock window
  chat: { maxLen: 80, gapMs: 700 },
  resignMs: 2800, deathFreezeMs: 2000,
  analysis: {
    historyMs: 8000, combatMs: 20000, comboMs: 6000, brilliantMs: 30000, sameKeyMs: 1200,
    bookCd: [22000, 40000], bookDist: 10, pairMs: 1000
  }
};
const GRID = {
  world: 128, render: 152, interest: 34, snapEvery: 1, orbSnap: true,
  chargeSecPerGrid: 0.2, maxCharge: 8, dashSpeed: 22, jumpMs: 420,
  cd: { p: 0.5, n: 1.2, b: 1.0, r: 1.2, q: 1.4 },
  startElo: 200,
  promote: { n: 300, b: 300, r: 600, q: 1000 },
  // FOV table is per-piece BASE (25% zoom in from the original p:10,n:12,b:12,r:15,q:19.5).
  // Same KOTK-style diminishing-returns curve now applies on top: base + fovCap*peak/(peak+fovK).
  fov: { p: 7.5, n: 9, b: 9, r: 11.25, q: 14.625 },
  fovCap: 8, fovK: 4000,
  hop: { ms: 500, gap: 0 },
  orbs: null
};
const PWP = {
  world: 128, interest: 34, snapEvery: 1, orbSnap: true,
  chargeSecPerGrid: 0.2, maxCharge: 8, dashSpeed: 20, jumpMs: 450, despawnMs: 380, fov: 11.25, // 25% zoom in from original 15
  hop: { cycleMs: 1000, baseSpeed: 4.6, arcRatio: .32 },      // Pieces with Pieces: base pace is 1 hop/sec; faster movement speed = faster hop cycle
  autoCd: { p: 1.0, n: 1.2, b: 1.0, r: 1.2, q: 1.4 },          // placed-piece automatic attack cooldowns
  cost: { p: 50, n: 150, b: 150, r: 300, q: 500 },
  cd: { p: 0.6, n: 1.5, b: 2.5, r: 3.5, q: 5 },              // per-piece-type throw cooldown (s)
  limit: { p: 20, n: 15, b: 15, r: 10, q: 5 },               // hard cap of active placed pieces per type per player (throwing more is simply blocked, nothing despawns)
  regenPlaced: false, orbs: { cell: 8, fill: 0.4 }
};
const KOTK = {
  world: 160, interest: 42, snapEvery: 2, orbSnap: false,
  speed: 5.6, unitSpeed: 6.8, boostMul: 2.1, boostMs: 450,
  cost: { p: 50, n: 150, b: 150, r: 300, q: 500 },   // house price is dynamic now, see house{} below
  baseCap: 10, houseCap: 10, houseHp: 600, genHp: 300, houseR: 2.0, genR: 1.4,
  cd: { p: 0.8, n: 0.8, b: 0.8, r: 1.2, q: 1.0 },
  range: { n: 6, b: 6.5, r: 6.5, q: 7 }, lineW: { b: 0.8, r: 1.1, q: 1.0 },
  aggro: 12, leash: 24, spreadR: 9, regroupMs: 10000, regenArmy: true,
  // FOV = fovBase + fovCap * peakElo / (peakElo + fovK)   (peak ELO never drops when ELO is spent)
  fovBase: 21.9375, fovCap: 10, fovK: 4000, // base FOV is 1.5x bigger (was 14.625, itself 25% zoom in from original base 19.5)
  orbs: { cell: 10, fill: 0.5 },
  // House economy: max 20 houses, price climbs from `base` (1st house) to `maxCost` (20th house), smooth exponential curve.
  house: { base: 500, cap: 20, maxCost: 20000 },
  // Shared upgrade economy for both houses and generators: 50 upgrade levels, price climbs from `base` to `maxCost` at level 50.
  upgrade: { base: 300, maxCost: 150000, maxLvl: 50 },
  houseCapPerLvl: 1,     // extra army capacity per house upgrade level (on top of houseCap)
  // Towers: a 4x4 (16 slot) garrison. Troops posted here defend the tower and don't roam with the King.
  tower: { cost: 800, cap: 8, r: 2.6, hp: 700, grid: 4, slots: 16, range: 7, sortieMul: 1.4 },
  puddles: { count: 7, radiusMin: 2.0, radiusMax: 5.0, minGap: 7.5, generatorSpacing: 2.2 },
  shine: { healR: 8.5, healPerSec: 18, queenSec: 30, queenWarnSec: 15 },
  generator: {
    cost: 500, radius: 1.45, cycleMs: 1400,
    eloPerHit: [20, 50, 100, 200, 400],
    upgradeCosts: [1000, 3000, 8000, 20000],
    names: ['Pawn', 'Knight', 'Bishop', 'Rook', 'Queen']
  }
};
// ============================== SUPER CHESS ==============================
// Clean slate. Gameplay is being redesigned from scratch; only the shared menu shell
// is kept while we brainstorm the new rules.
const SC = { port: 3003 };
const AVAL = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 4 };
const TAG_KEYS = ['brilliant', 'great_find', 'best', 'excellent', 'good', 'book', 'inaccuracy', 'mistake', 'blunder', 'correct',
  'incorrect', 'forced', 'critical', 'sharp', 'alternative', 'take_back', 'free_piece', 'missed_win', 'fast_win', 'threat',
  'mate', 'checkmate_white', 'checkmate_black', 'winner', 'draw_white', 'draw_black', 'resign_white', 'resign_black',
  'unnamed_clock_white', 'unnamed_clock_black'];

// Placeholder art until the real PNGs land. Set ICONS.usePng = false to force emoji even when PNGs exist;
// when usePng is true a missing PNG still falls back to its emoji automatically (client side).
const TAG_EMOJI = {
  brilliant: '\u2728', great_find: '\ud83d\udd25', best: '\u2b50', excellent: '\ud83d\udc4d', good: '\u2705', book: '\ud83d\udcd6',
  inaccuracy: '\ud83e\udd0f', mistake: '\u2753', blunder: '\ud83d\udca5', correct: '\u2714\ufe0f', incorrect: '\u2716\ufe0f', forced: '\u27a1\ufe0f',
  critical: '\u26a0\ufe0f', sharp: '\u26a1', alternative: '\ud83d\udd00', take_back: '\u21a9\ufe0f', free_piece: '\ud83c\udf81',
  missed_win: '\ud83d\ude2c', fast_win: '\u23e9', threat: '\u2694\ufe0f', mate: '\ud83d\udc51',
  checkmate_white: '\ud83d\udc51', checkmate_black: '\ud83d\udc51', winner: '\ud83c\udfc6',
  draw_white: '\ud83e\udd1d', draw_black: '\ud83e\udd1d', resign_white: '\ud83c\udff3\ufe0f', resign_black: '\ud83c\udff4',
  unnamed_clock_white: '\u23f0', unnamed_clock_black: '\u23f0'
};
const ICONS = { usePng: true };

/* ============================== ASSETS ============================== */
const IMG_EXT = /\.(png|webp|jpg|jpeg|gif|svg)$/i;
const HERE = __dirname;
function firstDir(...c) { for (const d of c) { try { if (d && fs.statSync(d).isDirectory()) return d; } catch (e) { } } return c.find(Boolean); }
const PIECES_DIR = firstDir(process.env.PIECES_DIR, 'C:\\Users\\moomo\\Downloads\\chess IO_\\pieces-basic-png', path.join(HERE, 'pieces-basic-png'));
const TAGS_DIR = firstDir(process.env.TAGS_DIR, 'C:\\Users\\moomo\\Downloads\\chess IO_\\brilliance_v2', path.join(HERE, 'brilliance_v2'));
const PN = { pawn: 'p', knight: 'n', bishop: 'b', rook: 'r', queen: 'q', king: 'k' };
function matchPiece(file) {
  const b = file.replace(IMG_EXT, '').toLowerCase();
  let m = b.match(/^([wb])([pnbrqk])$/); if (m) return m[1] + m[2];
  m = b.match(/(white|black|w|b)[^a-z0-9]*(pawn|knight|bishop|rook|queen|king)/); if (m) return m[1][0] + PN[m[2]];
  m = b.match(/(pawn|knight|bishop|rook|queen|king)[^a-z0-9]*(white|black|w|b)(?![a-z])/); if (m) return m[2][0] + PN[m[1]];
  m = b.match(/(?:^|[^a-z])([wb])[^a-z0-9]*([pnbrqk])(?:[^a-z]|$)/); if (m) return m[1] + m[2];
  return null;
}
let MANIFEST = null;
function scanAssets() {
  const man = { pieces: {}, tags: {}, files: { pieces: [], tags: [] }, unmatched: { pieces: [], tags: [] }, missing: { pieces: [], tags: [] }, dirs: { pieces: PIECES_DIR, tags: TAGS_DIR } };
  let pf = [], tf = [];
  try { pf = fs.readdirSync(PIECES_DIR).filter(f => IMG_EXT.test(f)); } catch (e) { }
  try { tf = fs.readdirSync(TAGS_DIR).filter(f => IMG_EXT.test(f)); } catch (e) { }
  man.files.pieces = pf; man.files.tags = tf;
  const used = new Set();
  for (const f of pf) { const k = matchPiece(f); if (k && !man.pieces[k]) { man.pieces[k] = '/assets/pieces/' + encodeURIComponent(f); used.add(f); man.pieces['_f' + k] = f; } }
  for (const s of 'wb') for (const t of 'pnbrqk') if (!man.pieces[s + t]) man.missing.pieces.push(s + t);
  man.unmatched.pieces = pf.filter(f => !used.has(f));
  const norm = f => f.replace(IMG_EXT, '').toLowerCase().replace(/[_\-\s]?\d+x$/, '').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  const bases = tf.map(f => ({ f, b: norm(f), c: norm(f).replace(/_/g, '') }));
  const usedT = new Set();
  for (const k of TAG_KEYS) {
    const kc = k.replace(/_/g, '');
    let hit = bases.find(x => x.c === kc) || bases.find(x => x.b.startsWith(k + '_'));
    const sub = TAG_KEYS.some(o => o !== k && o.includes(k));
    if (!hit && !sub) hit = bases.find(x => x.b.includes(k) && !TAG_KEYS.some(o => o !== k && o.length > k.length && x.b.includes(o)));
    if (hit) { man.tags[k] = '/assets/tags/' + encodeURIComponent(hit.f); usedT.add(hit.f); man.tags['_f' + k] = hit.f; } else man.missing.tags.push(k);
  }
  man.unmatched.tags = tf.filter(f => !usedT.has(f));
  return man;
}
function logAssets(man) {
  console.log('  pieces dir : ' + PIECES_DIR + '  (' + man.files.pieces.length + ' images, ' + (12 - man.missing.pieces.length) + '/12 matched)');
  console.log('  badges dir : ' + TAGS_DIR + '  (' + man.files.tags.length + ' images, ' + (TAG_KEYS.length - man.missing.tags.length) + '/' + TAG_KEYS.length + ' matched)');
  if (man.missing.pieces.length) console.log('  ! missing piece images: ' + man.missing.pieces.join(', '));
  if (man.missing.tags.length) console.log('  i using emoji placeholders for ' + man.missing.tags.length + '/' + TAG_KEYS.length + ' badges: ' + man.missing.tags.join(', '));
  if (!ICONS.usePng) console.log('  i ICONS.usePng is off - emoji placeholders are forced for every badge');
  if (man.unmatched.tags.length) console.log('  ? unmatched badge files (not used by a known tag): ' + man.unmatched.tags.join(', '));
  if (man.unmatched.pieces.length) console.log('  ? unmatched piece files: ' + man.unmatched.pieces.join(', '));
}
const MIME = { '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml' };
function serveAsset(dir, name, res) {
  name = path.basename(name);
  const fp = path.join(dir, name);
  fs.readFile(fp, (err, buf) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(name).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'max-age=3600' });
    res.end(buf);
  });
}
function debugAssetsPage() {
  const m = MANIFEST = scanAssets();
  const row = (dir, url, f, k) => '<div style="display:inline-block;width:150px;margin:6px;text-align:center;font:12px sans-serif"><img src="/assets/' + dir + '/' + encodeURIComponent(f) + '" style="width:96px;height:96px;object-fit:contain;background:#ddd"><br>' + f.replace(/</g, '') + '<br><b>' + (k || 'UNMATCHED') + '</b></div>';
  let h = '<body style="background:#fafafa"><h2>Pieces</h2>';
  for (const f of m.files.pieces) { const k = Object.keys(m.pieces).find(x => m.pieces['_f' + x] === f && x[0] !== '_'); h += row('pieces', '', f, k); }
  h += '<h2>Analysis badges</h2>';
  for (const f of m.files.tags) { const k = Object.keys(m.tags).find(x => x[0] !== '_' && m.tags['_f' + x] === f); h += row('tags', '', f, k); }
  return h + '</body>';
}

/* ============================== WEBSOCKET (RFC 6455, minimal) ============================== */
class WS {
  constructor(sock) {
    this.sock = sock; this.buf = Buffer.alloc(0); this.alive = true; this.frag = []; this.onmessage = null; this.onclose = null;
    sock.setNoDelay(true);
    sock.on('data', d => { this.buf = Buffer.concat([this.buf, d]); this.parse(); });
    sock.on('close', () => this.close()); sock.on('error', () => this.close());
  }
  parse() {
    for (; ;) {
      const b = this.buf; if (b.length < 2) return;
      const fin = !!(b[0] & 0x80), op = b[0] & 15, masked = !!(b[1] & 0x80); let len = b[1] & 0x7f, off = 2;
      if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (b.length < 10) return; len = Number(b.readBigUInt64BE(2)); off = 10; }
      if (len > (1 << 20)) { this.close(); return; }
      const ml = masked ? 4 : 0; if (b.length < off + ml + len) return;
      let pl = b.slice(off + ml, off + ml + len);
      if (masked) { const mk = b.slice(off, off + 4); pl = Buffer.from(pl); for (let i = 0; i < pl.length; i++) pl[i] ^= mk[i & 3]; }
      this.buf = b.slice(off + ml + len);
      if (op === 8) { this.close(); return; }
      if (op === 9) { this.raw(10, pl); continue; }
      if (op === 10 || op === 2) continue;
      this.frag.push(pl);
      if (fin) { const s = Buffer.concat(this.frag).toString('utf8'); this.frag = []; if (this.onmessage) this.onmessage(s); }
    }
  }
  raw(op, pl) {
    if (!this.alive) return; const len = pl.length; let h;
    if (len < 126) h = Buffer.from([0x80 | op, len]);
    else if (len < 65536) { h = Buffer.alloc(4); h[0] = 0x80 | op; h[1] = 126; h.writeUInt16BE(len, 2); }
    else { h = Buffer.alloc(10); h[0] = 0x80 | op; h[1] = 127; h.writeBigUInt64BE(BigInt(len), 2); }
    try { this.sock.write(Buffer.concat([h, pl])); } catch (e) { this.close(); }
  }
  send(o) { if (!this.alive || this.sock.writableLength > 600000) return; this.raw(1, Buffer.from(JSON.stringify(o))); }
  close() { if (!this.alive) return; this.alive = false; try { this.sock.destroy(); } catch (e) { } if (this.onclose) this.onclose(); }
}

/* ============================== SUPER CHESS TEST HARNESS (headless) ============================== */
// Fake WS-compatible connection: same surface as class WS (onmessage/onclose setters,
// .send(o), .alive) but talks to in-memory arrays instead of a socket. Used by automated
// tests for Super Chess (Phase 3+) and reusable for the existing 3 games too.
class FakeConn {
  constructor(label) {
    this.label = label || 'fake';
    this.alive = true;
    this.sent = [];        // every object passed to send()
    this.onmessage = null; // set by the server-side game connection
    this.onclose = null;
  }
  send(o) { if (this.alive) this.sent.push(o); }
  close() { if (!this.alive) return; this.alive = false; if (this.onclose) this.onclose(); }
  // Simulate the client sending a message to the server.
  emit(o) { if (this.onmessage) this.onmessage(JSON.stringify(o)); }
  // Convenience: last message sent to this client, or last matching type.
  last(type) {
    if (!type) return this.sent[this.sent.length - 1];
    for (let i = this.sent.length - 1; i >= 0; i--) if (this.sent[i] && this.sent[i].t === type) return this.sent[i];
    return null;
  }
}

// Minimal test registry so each phase can add its own tests without a test framework dependency.
const TESTS = [];
function registerTest(name, fn) { TESTS.push({ name, fn }); }
function runTests() {
  let pass = 0, fail = 0;
  for (const t of TESTS) {
    try { t.fn(); console.log('  ok   - ' + t.name); pass++; }
    catch (e) { console.log('  FAIL - ' + t.name + '\n         ' + (e && e.message || e)); fail++; }
  }
  console.log('\n  ' + pass + ' passed, ' + fail + ' failed (' + TESTS.length + ' total)');
  return fail === 0;
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function assertEq(a, b, msg) { if (a !== b) throw new Error((msg || 'expected equal') + ' (got ' + JSON.stringify(a) + ', wanted ' + JSON.stringify(b) + ')'); }

// ---- Phase 0 smoke tests: config shape, not gameplay ----
registerTest('Battle Grid ELO numbers are locked as specified', () => {
  assertEq(GRID.startElo, 200, 'GRID.startElo');
  assertEq(GRID.promote.n, 300, 'promote.n'); assertEq(GRID.promote.b, 300, 'promote.b');
  assertEq(GRID.promote.r, 600, 'promote.r'); assertEq(GRID.promote.q, 1000, 'promote.q');
});
registerTest('FakeConn mimics WS send/receive surface', () => {
  const c = new FakeConn('t');
  let got = null;
  c.onmessage = s => { got = JSON.parse(s); };
  c.emit({ t: 'ping' });
  assertEq(got.t, 'ping', 'onmessage did not fire');
  c.send({ t: 'pong' });
  assertEq(c.last('pong').t, 'pong', 'send/last did not record message');
});

registerTest('FOV reduced ~25% from original baseline, everywhere (Kings base FOV is 1.5x bigger on top of that)', () => {
  assertEq(GRID.fov.q, 14.625, 'GRID.fov.q'); assertEq(GRID.fov.p, 7.5, 'GRID.fov.p');
  assert(GRID.fovCap && GRID.fovK, 'GRID missing diminishing-returns fovCap/fovK');
  assertEq(PWP.fov, 11.25, 'PWP.fov');
  assertEq(KOTK.fovBase, 21.9375, 'KOTK.fovBase');
});

/* ============================== SPATIAL HASH / ORBS ============================== */
class Hash {
  constructor(cs) { this.cs = cs; this.m = new Map(); }
  clear() { this.m.clear(); }
  add(e) { const k = (Math.floor(e.x / this.cs) + 64) * 4096 + Math.floor(e.y / this.cs) + 64; let a = this.m.get(k); if (!a) this.m.set(k, a = []); a.push(e); }
  query(x, y, r, fn) {
    const cs = this.cs, x0 = Math.floor((x - r) / cs) + 64, x1 = Math.floor((x + r) / cs) + 64, y0 = Math.floor((y - r) / cs) + 64, y1 = Math.floor((y + r) / cs) + 64;
    for (let i = x0; i <= x1; i++) for (let j = y0; j <= y1; j++) { const a = this.m.get(i * 4096 + j); if (a) for (let k = 0; k < a.length; k++) fn(a[k]); }
  }
}
// ELO orbs live on an invisible spawn lattice so they are spread out fairly (no clumps). One orb per lattice cell.
class Orbs {
  constructor(g, world, cell, fill, snap) {
    this.g = g; this.c = cell; this.n = Math.floor(world / cell); this.snap = snap; this.s = [];
    for (let j = 0; j < this.n; j++) for (let i = 0; i < this.n; i++) {
      const o = { id: j * this.n + i, i, j, x: 0, y: 0, on: false, at: 0, en: Math.random() < fill };
      this.s.push(o); if (o.en) this.place(o);
    }
  }
  place(o) {
    for (let t = 0; t < 6; t++) {
      let x = (o.i + .12 + Math.random() * .76) * this.c, y = (o.j + .12 + Math.random() * .76) * this.c;
      if (this.snap) { x = Math.floor(x) + .5; y = Math.floor(y) + .5; }
      if (!this.g.isOrbBlocked(x, y, .8)) { o.x = x; o.y = y; o.on = true; return; }
    }
    o.at = Date.now() + 1000;
  }
  update(now) { for (const o of this.s) if (o.en && !o.on && now >= o.at) this.place(o); }
  take(p) {
    const ci = Math.floor(p.x / this.c), cj = Math.floor(p.y / this.c); let got = 0;
    for (let j = cj - 1; j <= cj + 1; j++) for (let i = ci - 1; i <= ci + 1; i++) {
      if (i < 0 || j < 0 || i >= this.n || j >= this.n) continue;
      const o = this.s[j * this.n + i];
      if (o.en && o.on) { const dx = o.x - p.x, dy = o.y - p.y; if (dx * dx + dy * dy < (p.r + .55) * (p.r + .55)) { o.on = false; o.at = this.g.now + BAL.elo.respawnMs; got += BAL.elo.orb; } }
    }
    return got;
  }
  takeUnit(u) {
    const ci = Math.floor(u.x / this.c), cj = Math.floor(u.y / this.c); let got = 0;
    for (let j = cj - 1; j <= cj + 1; j++) for (let i = ci - 1; i <= ci + 1; i++) {
      if (i < 0 || j < 0 || i >= this.n || j >= this.n) continue;
      const o = this.s[j * this.n + i];
      if (o.en && o.on) { const dx = o.x - u.x, dy = o.y - u.y; if (dx * dx + dy * dy < (u.r + .55) * (u.r + .55)) { o.on = false; o.at = this.g.now + BAL.elo.respawnMs; got += BAL.elo.orb; } }
    }
    return got;
  }
  pack(x, y, R) {
    const out = [], c = this.c, i0 = Math.max(0, Math.floor((x - R) / c)), i1 = Math.min(this.n - 1, Math.floor((x + R) / c)), j0 = Math.max(0, Math.floor((y - R) / c)), j1 = Math.min(this.n - 1, Math.floor((y + R) / c));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) { const o = this.s[j * this.n + i]; if (o.en && o.on) out.push(o.id, r2(o.x), r2(o.y)); }
    return out;
  }
}

/* ============================== ANALYSIS (event driven, lightweight) ============================== */
// A contextual combat-judging layer (not a chess engine). It only runs when something meaningful happens
// (hit, kill, near-miss, piece loss) and keeps a short rolling history per player.
class Analysis {
  constructor(g) { this.g = g; }
  link(a, b) { const t = this.g.now + BAL.analysis.combatMs; a.combat.set(b.id, t); b.combat.set(a.id, t); }
  inCombat(p) { const n = this.g.now; for (const [id, t] of p.combat) { if (t > n) return true; p.combat.delete(id); } return false; }
  hist(p, ev) { const h = p.hist; h.push(ev); const cut = this.g.now - BAL.analysis.historyMs; while (h.length && h[0].t < cut) h.shift(); while (h.length > 20) h.shift(); }
  // Badge for `subj`: seen by subj and by players in ACTIVE COMBAT with subj (20 s timer refreshed by every hit).
  badge(subj, key, dmg, force, text) {
    if (!key) return; const n = this.g.now;
    if (!force) { if (n - (subj.badgeAt[key] || 0) < BAL.analysis.sameKeyMs) return; subj.badgeAt[key] = n; }
    const msg = { t: 'badge', pid: subj.id, key, dmg: dmg ? 1 : 0 };
    if (text) msg.msg = text;
    this.g.send(subj, msg);
    if (force) return;
    for (const [id, t] of subj.combat) { if (t <= n) { subj.combat.delete(id); continue; } const o = this.g.players.get(id); if (o) this.g.send(o, msg); }
  }
  tick(p) { // occasional BOOK on ordinary repositioning (never spammed); a King running low on HP mid-fight gets an occasional clock warning
    const n = this.g.now, A = BAL.analysis;
    if (p.trav > A.bookDist && n > p.bookAt && Math.random() < .02 && !this.inCombat(p)) { this.badge(p, 'book', false); p.bookAt = n + rnd(A.bookCd[0], A.bookCd[1]); p.trav = 0; }
    if (p.type === 'k' && p.hp / p.maxHp <= .18 && this.inCombat(p) && n > (p.clockAt || 0)) {
      this.badge(p, 'unnamed_clock_' + (p.side === 'w' ? 'white' : 'black'), true);
      p.clockAt = n + 12000;
    }
  }
  // Simple, event-driven mapping: land a clean hit -> a positive tag scaled by how good it was; get hit -> a
  // negative tag scaled by how bad it was; dodge an attack cleanly -> a positive tag; a King going down is its
  // own pair of tags (checkmate for the loser, winner for whoever landed it). Never more than one tag per event,
  // and the same tag on the same player is throttled (see badge()) so it stays readable instead of spammy.
  hit(att, vic, i) {
    const g = this.g, n = g.now, A = BAL.analysis;
    this.link(att, vic);
    const vMax = vic.maxHp + vic.maxShield, pct = i.dmg / vMax, vf = Math.max(0, vic.hp) / vic.maxHp, af = att.hp / att.maxHp;
    this.hist(att, { t: n, ty: 'h', v: vic.id, d: i.dmg }); this.hist(vic, { t: n, ty: 't', a: att.id, d: i.dmg });
    const fh0 = att.firstHit.get(vic.id);
    if (fh0 === undefined || n - fh0 > BAL.analysis.combatMs) att.firstHit.set(vic.id, n);
    const fh = n - att.firstHit.get(vic.id), tookRecent = n - att.lastDmgAt < 5000;
    const hs = att.hist.filter(e => e.ty === 'h' && e.v === vic.id && e.t > att.comboAt && n - e.t <= A.comboMs);
    const last3 = hs.slice(-3);
    // BRILLIANT (rare): clean three-hit combo, no damage taken, ends in kill / big advantage, then long personal cooldown.
    const clean = last3.length === 3 && att.lastDmgAt < last3[0].t;
    const sig = i.killed || vf <= .35 || last3.reduce((s, e) => s + e.d, 0) >= .6 * vMax;
    const kingDeath = i.killed && vic.type === 'k';
    let key = null;
    if (kingDeath) {
      // a King falls: checkmate for the side that lost it, winner for whoever delivered it
      this.badge(vic, 'checkmate_' + (vic.side === 'w' ? 'white' : 'black'), true, false, 'Checkmate — ' + att.name + ' got you.');
      this.badge(att, 'winner', true, false, 'Checkmate! You beat ' + vic.name + '.');
    }
    else if (clean && sig && n - att.brilAt > A.brilliantMs) { key = 'brilliant'; att.brilAt = n; att.comboAt = n; }
    else if (i.killed) key = (fh <= 6000 && hs.length <= 3) ? 'fast_win' : i.vicVal > i.attVal ? 'great_find' : 'critical';
    else if (att.lastDmgBy === vic.id && n - att.lastDmgAt < 4000 && n - att.takeAt > 8000) { key = 'take_back'; att.takeAt = n; }
    else if (af < .3) key = 'forced';
    else if (af < .5 && vf < .5) key = 'sharp';
    else if (vf <= .25 && pct >= .12) key = 'critical';
    else if (i.stunned && vf <= .5 && !tookRecent) key = 'free_piece';
    else if (vf < .2 && (i.stunned || i.cornered)) key = 'mate';
    else if (i.vicVal > i.attVal && pct >= .15) key = 'great_find';
    else if (pct >= .3) key = 'best';
    else if (pct >= .2 && !tookRecent) key = 'excellent';
    else if (pct >= .1) key = 'good';
    if (key) this.badge(att, key, true, false, ANALYSIS_PHRASE[key] ? ANALYSIS_PHRASE[key](vic.name) : null);
    if (!kingDeath && (key === 'good' || key === 'excellent' || !key) && n - att.altAt > 15000 && g.hasAlt(att, vic)) { att.altAt = n; this.badge(att, 'alternative', false); }
    // victim: getting hit for real HP is a graded "blunder" family tag, scaled by how much it cost; a hit that only
    // ate shield (no HP lost) is credited as 'good' instead - you were positioned well enough that it didn't hurt.
    if (!kingDeath) {
      const avoid = i.tele && !i.vicMoved, pressure = n - vic.prevDmgAt < 5000; let vk = null;
      if (i.hpLost === 0 && i.dmg > 0) vk = 'good';
      else if (i.hpLost > 0) {
        let tier = pct >= .35 ? 3 : pct >= .2 ? 2 : pct >= .1 ? 1 : 0;
        if (avoid && pressure && tier > 1) tier--; // already under pressure from this fight - go a little easier
        vk = ['incorrect', 'inaccuracy', 'mistake', 'blunder'][tier];
        if (i.killed) vk = 'blunder';
      }
      if (vk) this.badge(vic, vk, !!i.killed, false, VICTIM_PHRASE[vk] ? VICTIM_PHRASE[vk](att.name) : null); // only force-shown (bypassing the spam throttle) on a kill
    }
  }
  miss(att, e) { // an attack went past its target without landing: a clean dodge
    this.link(att, e); const n = this.g.now;
    const near = e.hp / e.maxHp < .25;
    this.badge(att, near ? 'missed_win' : 'threat', true, false, near ? 'Missed a winning shot on ' + e.name + '!' : 'Threat! ' + e.name + ' barely escaped.');
    const justMoved = n - e.lastMoveAt < 1000;           // actively moved out of the way, not just lucky
    this.badge(e, justMoved ? 'excellent' : 'good', false, false, justMoved ? 'Nice dodge — ' + att.name + '\'s attack whiffed.' : null);
  }
  pieceHit(att, vic, ptype, destroyed) {
    this.link(att, vic); const v = BAL.pieces[ptype].val, pn = BAL.pieces[ptype].name;
    this.badge(att, destroyed ? (v >= 5 ? 'great_find' : v >= 3 ? 'excellent' : 'good') : 'good', true, false, destroyed ? 'Destroyed ' + vic.name + '\'s ' + pn + '!' : null);
    if (destroyed) { const vk = v >= 5 ? 'mistake' : v >= 3 ? 'inaccuracy' : null; if (vk) this.badge(vic, vk, true, false, 'Lost your ' + pn + ' to ' + att.name + '.'); }
  }
  bldKill(att, vic, type) {
    this.link(att, vic); const what = type === 'H' ? 'house' : 'generator';
    this.badge(att, type === 'H' ? 'great_find' : 'excellent', true, false, 'Destroyed ' + vic.name + '\'s ' + what + '!');
  }
}
// Short contextual chess-style feedback text for the attacker's own badge, and for the victim's
// blunder-family badge - reuses whatever data Analysis already computed, just phrased in plain words.
const ANALYSIS_PHRASE = {
  brilliant: n => 'Brilliant combo on ' + n + '!', great_find: n => 'Great find against ' + n + '!',
  fast_win: n => 'Fast win over ' + n + '!', critical: n => 'Critical hit on ' + n + '!',
  forced: n => 'Forced trade with ' + n + '.', sharp: n => 'Sharp exchange with ' + n + '!',
  take_back: n => 'Take-back on ' + n + '!', free_piece: n => 'Free piece — ' + n + ' was exposed!',
  mate: n => 'Mating attack on ' + n + '!'
};
const VICTIM_PHRASE = {
  incorrect: n => 'Inaccurate — ' + n + ' punished it.', inaccuracy: n => 'Inaccuracy against ' + n + '.',
  mistake: n => 'Mistake — ' + n + ' capitalized.', blunder: n => 'You blundered into ' + n + '\'s square.'
};

/* ============================== BASE GAME (server authoritative) ============================== */
class Player {
  constructor(id, conn) {
    Object.assign(this, {
      id, conn, ent: 'player', owner: id, name: '', side: 'w', joined: false, alive: false, leaving: false, leaveAt: 0, type: 'p',
      x: 0, y: 0, r: .4, hp: 100, maxHp: 100, shield: 0, maxShield: 0, elo: 0, kills: 0, score: 0, protUntil: 0,
      lastDmgAt: 0, prevDmgAt: 0, lastDmgBy: 0, stunUntil: 0, stunImmune: 0, kb: null, act: null, air: false, charge: null,
      in: { dx: 0, dy: 0 }, cdUntil: 0, lastMoveAt: 0, trav: 0, bookAt: 0, combat: new Map(), hist: [], badgeAt: {}, firstHit: new Map(),
      comboAt: 0, brilAt: -1e9, takeAt: -1e9, altAt: -1e9, clockAt: 0, view: { x: 0, y: 0 }, killer: 0, deadAt: 0, chatAt: 0,
      peak: 0, hopAt: 0, sel: null
    });
  }
}
const AVALf = t => AVAL[t] || 1;

class Game {
  constructor(mode, cfg) {
    this.mode = mode; this.cfg = cfg; this.players = new Map(); this.units = new Map(); this.nextId = 1;
    this.now = Date.now(); this.last = this.now; this.tickN = 0; this.fx = []; this.lbAt = 0; this.lb = []; this.ranked = [];
    this.hash = new Hash(4); this.an = new Analysis(this);
    this.orbs = cfg.orbs ? new Orbs(this, cfg.world, cfg.orbs.cell, cfg.orbs.fill, cfg.orbSnap) : null;
    setInterval(() => this.tick(), 1000 / BAL.tick);
  }
  /* ---- connections ---- */
  connect(conn) {
    const p = new Player(this.nextId++, conn); this.players.set(p.id, p);
    conn.onmessage = s => { let m; try { m = JSON.parse(s); } catch (e) { return; } try { this.msg(p, m); } catch (e) { console.error(e); } };
    conn.onclose = () => this.leave(p);
  }
  send(p, o) { if (p.conn && p.conn.alive) p.conn.send(o); }
  msg(p, m) {
    if (!m || typeof m.t !== 'string') return;
    if (m.t === 'join') return this.join(p, m);
    if (!p.joined) return;
    if (m.t === 'chat') return this.chat(p, m);
    this.onMsg(p, m);
  }
  join(p, m) {
    if (p.joined) return;
    let name = String(m.name || '').replace(/[^\w \-\.]/g, '').trim().slice(0, 16) || ('Player' + (1000 + Math.floor(Math.random() * 9000)));
    // Handle name collisions by appending numbers
    let suffix = 0;
    const baseName = name;
    while (true) {
      let collision = false;
      for (const o of this.players.values()) {
        if (o !== p && o.joined && o.name === name) {
          collision = true;
          break;
        }
      }
      if (!collision) break;
      suffix++;
      name = baseName + ' ' + suffix;
      if (name.length > 16) name = baseName.slice(0, 16 - String(suffix).length - 1) + ' ' + suffix;
    }
    p.name = name;
    p.side = m.side === 'b' ? 'b' : 'w'; p.joined = true;
    this.initPlayer(p);
    p.bookAt = this.now + rnd(8000, 15000);
    this.send(p, { t: 'welcome', id: p.id });
  }
  leave(p) { // players never vanish instantly: resign badge + fade first
    p.conn.alive = false;
    if (!p.joined || !p.alive) { this.onRemove(p); this.players.delete(p.id); return; }
    p.leaving = true; p.leaveAt = this.now; p.act = null; p.charge = null; p.in = { dx: 0, dy: 0 }; p.air = false;
    this.onLeave(p);
  }
  chat(p, m) {
    const s = String(m.m || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, BAL.chat.maxLen);
    if (!s || this.now - p.chatAt < BAL.chat.gapMs) return; p.chatAt = this.now;
    if (process.env.CHESSIO_DEBUG && s.startsWith('/tag ')) { this.debugTag(p, s.slice(5).trim()); return; }
    for (const o of this.players.values()) if (o.joined) this.send(o, { t: 'chat', id: p.id, n: p.name, m: s });
  }
  debugTag(p, a) {
    const ks = a === 'all' ? TAG_KEYS.filter(k => k.indexOf('resign') < 0) : TAG_KEYS.includes(a) ? [a] : [];
    ks.forEach((k, i) => setTimeout(() => this.an.badge(p, k, i % 2 === 0, true), i * 260));
  }
  /* ---- hooks for modes ---- */
  onMsg() { } onDeath() { } onLeave() { } onRemove() { } onDamaged() { }
  /* ---- main loop ---- */
  tick() {
    const t = Date.now(); const dt = Math.min(.06, (t - this.last) / 1000); this.last = t; this.now = t; this.tickN++;
    this.hash.clear();
    if (this.puddles) for (const q of this.puddles) if (!q.dead) this.hash.add(q);
    for (const p of this.players.values()) if (p.alive) this.hash.add(p);
    for (const u of this.units.values()) if (!u.dead) this.hash.add(u);
    for (const p of [...this.players.values()]) if (p.leaving && t - p.leaveAt > BAL.resignMs) { this.onRemove(p); this.players.delete(p.id); }
    this.update(dt);
    for (const p of this.players.values()) if (p.elo > p.peak) p.peak = p.elo;   // peak never falls when ELO is lost or spent
    for (const [id, u] of this.units) if (u.dead) this.units.delete(id);
    if (this.orbs) this.orbs.update(t);
    if (t - this.lbAt > 500) this.leaderboard();
    if (this.tickN % this.cfg.snapEvery === 0) { for (const p of this.players.values()) if (p.joined) this.snapshot(p); this.fx.length = 0; }
  }
  leaderboard() {
    this.ranked = [...this.players.values()].filter(p => p.joined && p.alive && !p.leaving).sort((a, b) => b.elo - a.elo);
    this.lb = this.ranked.slice(0, 10).map(p => [p.id, p.name, Math.floor(p.elo)]); this.lbAt = this.now;
    // Most-kills crown: any connected player with kills counts (not just those currently alive/ranked).
    // Ties keep whoever already holds it instead of flip-flopping every 500ms.
    const cur = this.topKiller ? this.players.get(this.topKiller) : null;
    let top = (cur && cur.joined && cur.kills > 0) ? cur : null;
    for (const p of this.players.values()) { if (p.joined && p.kills > 0 && (!top || p.kills > top.kills)) top = p; }
    this.topKiller = top ? top.id : 0;
  }
  rankOf(p) { let r = 1; for (const o of this.ranked) if (o !== p && o.elo > p.elo) r++; return r; }
  pickSpectate(p) { for (const o of this.ranked) if (o !== p && o.alive && !o.leaving) return o; return null; }
  viewOf(p) {
    if (p.alive) return { x: p.x, y: p.y, id: p.id };
    if (this.now - p.deadAt < BAL.deathFreezeMs) return { x: p.view.x, y: p.view.y, id: 0 };
    let t = this.players.get(p.killer);
    if (!t || !t.alive || t.leaving) { t = this.pickSpectate(p); p.killer = t ? t.id : 0; }
    return t ? { x: t.x, y: t.y, id: t.id } : { x: p.view.x, y: p.view.y, id: 0 };
  }
  packPlayer(e) {
    const o = { i: e.id, n: e.name, k: e.type, x: r2(e.x), y: r2(e.y), h: Math.ceil(e.hp), s: Math.ceil(e.shield), p: e.protUntil > this.now ? 1 : 0, st: e.stunUntil > this.now ? 1 : 0, rs: e.leaving ? 1 : 0 };
    if (e.act && (e.act.kind === 'jump' || e.act.kind === 'hop')) {
      o.j = r2(Math.min(1, (this.now - e.act.t0) / e.act.dur));
      if (e.act.kind === 'hop') { o.hk = 1; o.hsx = r2(e.act.sx); o.hsy = r2(e.act.sy); o.htx = r2(e.act.tx); o.hty = r2(e.act.ty); o.hdur = e.act.dur; }
    }
    if (e.sel) o.sl = e.sel;
    if (e.fallUntil > this.now) { o.f = r2(clamp((this.now - e.fallAt) / Math.max(1, e.fallDur), 0, 1)); o.fx = r2(e.fallDx); o.fy = r2(e.fallDy); } else o.f = 0;
    // Include aiming direction for tilt animation (visible to enemies)
    if (e.in) { o.dx = e.in.dx; o.dy = e.in.dy; }
    return o;
  }
  packUnit(u) {
    let fl = (u.rs ? 1 : 0) | (u.st === 'despawn' ? 2 : 0) | (u.act && u.act.kind === 'dash' ? 4 : 0) | (u.air ? 8 : 0), aux = 0;
    if (u.transferTo) fl |= 16;
    if (u.ent === 'bld') aux = u.lvl || 0;
    else if (u.act && u.act.kind === 'jump') aux = r2(Math.min(1, (this.now - u.act.t0) / u.act.dur));
    const aux2 = u.ent === 'bld' && u.type === 'G' ? r2(u.minePhase || 0) : 0;
    const aux3 = u.ent === 'piece' && this.mode === 'kings' && u.type === 'p' && u.queenChargeAt ? r2(clamp((this.now - u.queenChargeAt) / (KOTK.shine.queenSec * 1000), 0, 1)) : 0;
    return [u.id, u.type, u.owner, r2(u.x), r2(u.y), Math.ceil(u.hp), Math.ceil(u.shield), fl, aux, u.ent === 'piece' ? (u.garrison || 0) : 0, aux2, u.ent === 'bld' && u.type === 'G' ? (u.puddleId || 0) : 0, u.transferTo || 0, aux3];
  }
  meState(p) { return { elo: Math.floor(p.elo), pk: Math.floor(p.peak), kills: p.kills, score: p.score, hp: Math.ceil(p.hp), sh: Math.ceil(p.shield), k: p.type, pr: Math.max(0, p.protUntil - this.now) }; }
  snapshot(p) {
    const v = this.viewOf(p), R = this.cfg.interest, ents = [], units = [], seenUnits = new Set();
    this.hash.query(v.x, v.y, R, e => {
      // Ponds have their own `pd` snapshot stream below. Never pack them as units:
      // puddles have no chess-piece `type`, which previously became the literal
      // `undefined` sprite/text on top of the pond.
      if (e.ent === 'puddle') return;
      if (e.ent === 'player') ents.push(this.packPlayer(e));
      else { units.push(this.packUnit(e)); seenUnits.add(e.id); }
    });
    if (this.mode === 'kings') {
      if (p.blds) for (const b of p.blds) if (b && !b.dead && !seenUnits.has(b.id)) { units.push(this.packUnit(b)); seenUnits.add(b.id); }
      for (const u of this.units.values()) if (u && !u.dead && u.owner === p.id && !seenUnits.has(u.id)) { units.push(this.packUnit(u)); seenUnits.add(u.id); }
    }
    const fx = []; for (const f of this.fx) if (Math.abs(f[1] - v.x) < R && Math.abs(f[2] - v.y) < R) fx.push(f);
    const pd = this.puddles ? this.puddles.map(q => {
      const id = Number.isFinite(Number(q.id)) ? Number(q.id) : 0;
      const x = Number.isFinite(Number(q.x)) ? Number(q.x) : 0;
      const y = Number.isFinite(Number(q.y)) ? Number(q.y) : 0;
      const r = Number.isFinite(Number(q.r)) && Number(q.r) > 0 ? Number(q.r) : (this.mode === 'kings' ? KOTK.puddles.radiusMin : 1);
      const used = q.genIds ? Math.max(0, q.genIds.length | 0) : 0;
      const cap = this.mode === 'kings' ? Math.max(1, Number(this.pondGenCapacity(q)) || 1) : 0;
      return [id, r2(x), r2(y), r2(r), used, cap];
    }) : [];
    let tc;
    if (this.mode === 'battlegrid' && this.territory.size) {
      tc = [];
      for (const [key, val] of this.territory) {
        const comma = key.indexOf(','), gx = +key.slice(0, comma), gy = +key.slice(comma + 1);
        if (Math.abs(gx + .5 - v.x) < R && Math.abs(gy + .5 - v.y) < R) tc.push(gx, gy, val.side === 'w' ? 1 : 2);
      }
    }
    const sh = this.mode === 'kings' ? [r2(this.shrine.x), r2(this.shrine.y), this.shrine.r, this.shrine.owner, r2(this.shrine.control), KOTK.shine.healR] : undefined;
    this.send(p, { t: 's', tm: this.now, v: { x: r2(v.x), y: r2(v.y), id: v.id }, me: this.meState(p), e: ents, u: units, o: this.orbs ? this.orbs.pack(v.x, v.y, R) : [], pd, lb: this.lb, tk: this.topKiller, rk: this.rankOf(p), fx, tc, sh });
  }
  /* ---- world queries ---- */
  isSolid(e) { if (e.ghost || e.air || e.dead || e.st === 'despawn') return false; if (e.ent === 'player') return e.alive && !e.leaving; if (e.ent === 'puddle') return true; return true; }
  walkSolid(m, e) { return this.isSolid(e); }
  solidNear(x, y, r, ign) { let f = false; this.hash.query(x, y, r + 1.5, e => { if (f || e === ign || !this.isSolid(e)) return; const dx = e.x - x, dy = e.y - y, rr = r + e.r; if (dx * dx + dy * dy < rr * rr) f = true; }); return f; }
  isOrbBlocked(x, y, r) {
    if (this.mode === 'kings' && this.puddles) {
      for (const q of this.puddles) if (Math.hypot(q.x - x, q.y - y) < q.r + r + .05) return true;
    }
    return this.solidNear(x, y, r);
  }
  spawnPos() {
    const W = this.cfg.world;
    for (let t = 0; t < 60; t++) { const x = rnd(6, W - 6), y = rnd(6, W - 6); if (!this.solidNear(x, y, 5)) return this.cfg.orbSnap ? { x: Math.floor(x) + .5, y: Math.floor(y) + .5 } : { x, y }; }
    return { x: W / 2, y: W / 2 };
  }
  blockedAt(m, x, y) {
    let b = false;
    this.hash.query(x, y, m.r + 1.2, e => {
      if (b || e === m || !this.walkSolid(m, e)) return;
      const dx = e.x - x, dy = e.y - y, rr = m.r + e.r, d2 = dx * dx + dy * dy;
      if (d2 < rr * rr - 1e-6) { const ox = e.x - m.x, oy = e.y - m.y; if (d2 < ox * ox + oy * oy - 1e-6) b = true; } // allow moving apart when already overlapping
    });
    return b;
  }
  walk(m, dx, dy) {
    const W = this.cfg.world;
    const nx = clamp(m.x + dx, m.r, W - m.r); if (!this.blockedAt(m, nx, m.y)) m.x = nx;
    const ny = clamp(m.y + dy, m.r, W - m.r); if (!this.blockedAt(m, m.x, ny)) m.y = ny;
  }
  push(m) { // push a mover out of anything it overlaps
    const W = this.cfg.world;
    for (let it = 0; it < 3; it++) {
      let moved = false;
      this.hash.query(m.x, m.y, m.r + 1.2, e => {
        if (e === m || !this.isSolid(e)) return;
        let dx = m.x - e.x, dy = m.y - e.y, d = Math.hypot(dx, dy); const rr = m.r + e.r;
        if (d < rr) { if (d < 1e-4) { dx = 1; dy = 0; d = 1; } const o = rr - d + .01; m.x = clamp(m.x + dx / d * o, m.r, W - m.r); m.y = clamp(m.y + dy / d * o, m.r, W - m.r); moved = true; }
      });
      if (!moved) break;
    }
  }
  // Server-side swept dash: the mover travels the real line in sub-steps; every cell it crosses is a collision test.
  runDash(m, dt, contact) {
    const a = m.act, W = this.cfg.world; let step = a.speed * dt;
    while (step > 1e-6 && m.act) {
      const s = Math.min(step, .2, a.len - a.moved), nx = m.x + a.ux * s, ny = m.y + a.uy * s;
      if (nx < m.r - 1e-3 || nx > W - m.r + 1e-3 || ny < m.r - 1e-3 || ny > W - m.r + 1e-3) { this.endDash(m); return; }
      let stop = false;
      this.hash.query(nx, ny, m.r + 1.6, e => {
        if (stop || e === m || !this.isSolid(e)) return;
        const dx = e.x - nx, dy = e.y - ny, rr = m.r + e.r;
        if (dx * dx + dy * dy < rr * rr && contact(m, e) === 'stop') stop = true;
      });
      if (stop) { this.endDash(m); return; }
      m.x = nx; m.y = ny; a.moved += s; step -= s;
      if (a.moved >= a.len - 1e-4) { this.endDash(m); return; }
    }
  }
  endDash(m) { const a = m.act; m.act = null; if (a.landOnGrid) { m.x = Math.floor(m.x) + .5; m.y = Math.floor(m.y) + .5; } this.onDashEnd(m, a); }
  /* ---- grid hopping: one whole cell at a time, fully validated by the server ---- */
  cellFree(p, tx, ty) {
    const W = this.cfg.world;
    if (tx < .5 || ty < .5 || tx > W - .5 || ty > W - .5) return false;          // in bounds
    if (this.solidNear(tx, ty, p.r, p)) return false;                            // unoccupied
    for (const o of this.players.values())                                       // nobody already hopping into it
      if (o !== p && o.alive && o.act && o.act.kind === 'hop' && Math.abs(o.act.tx - tx) < .1 && Math.abs(o.act.ty - ty) < .1) return false;
    return true;
  }
  hopTry(p, dx, dy) {
    const n = this.now, H = this.cfg.hop;
    if ((!dx && !dy) || p.act || p.charge || n < p.stunUntil || n < p.hopAt) return false;
    // pawns cannot move diagonally at all
    if (p.type === 'p' && dx && dy) return false;
    const cx = Math.floor(p.x) + .5, cy = Math.floor(p.y) + .5;
    if (this.cellFree(p, cx + dx, cy + dy)) return this.startHop(p, cx + dx, cy + dy, H.ms);
    if (dx && dy) {                                                              // diagonal blocked: slide along whichever axis is open
      if (this.cellFree(p, cx + dx, cy)) return this.startHop(p, cx + dx, cy, H.ms);
      if (this.cellFree(p, cx, cy + dy)) return this.startHop(p, cx, cy + dy, H.ms);
    }
    // Movement blocked - trigger shake effect
    this.send(p, { t: 'shake' });
    p.hopAt = n + 60;                                                            // blocked: brief re-check delay, no spam
    return false;
  }
  startHop(p, tx, ty, ms, kb) {
    const l = Math.hypot(tx - p.x, ty - p.y) || 1;
    p.act = { kind: 'hop', sx: p.x, sy: p.y, tx, ty, t0: this.now, dur: ms, ux: (tx - p.x) / l, uy: (ty - p.y) / l, kb: !!kb };
    p.hopAt = this.now + ms + this.cfg.hop.gap; p.protUntil = kb ? p.protUntil : 0;
    return true;
  }
  endHop(p) { const a = p.act; if (!a || a.kind !== 'hop') return; p.x = a.tx; p.y = a.ty; p.act = null; }
  runHop(p) {
    const a = p.act, k = Math.min(1, (this.now - a.t0) / a.dur);
    // Improved easing: quadratic ease-in-out for smoother motion
    const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
    p.x = a.sx + (a.tx - a.sx) * e; p.y = a.sy + (a.ty - a.sy) * e;
    if (k < 1) return;
    p.x = a.tx; p.y = a.ty; p.act = null;
    this.fx.push(['dust', p.x, p.y, a.kb ? 1 : 0, 0, p.type]);
  }
  // knockback in the grid games is a whole-cell shove instead of a slide
  gridKnock(e, ux, uy, noStun, cells) {
    if (e.ent !== 'player' || !e.alive || e.protUntil > this.now) return;
    const K = BAL.knock, n = this.now, s8 = v => v > .45 ? 1 : v < -.45 ? -1 : 0;
    e.charge = null; e.kb = null;
    if (e.act && e.act.kind === 'dash') e.act = null;
    if (!e.act || e.act.kind === 'hop') {
      const dx = s8(ux), dy = s8(uy), cx = Math.floor(e.x) + .5, cy = Math.floor(e.y) + .5;
      if (dx || dy) { e.act = null; for (let k = cells || 2; k >= 1; k--) if (this.cellFree(e, cx + dx * k, cy + dy * k)) { this.startHop(e, cx + dx * k, cy + dy * k, 90 + 55 * k, true); break; } }
    }
    if (!noStun && n > e.stunImmune) { e.stunUntil = n + K.stunMs; e.stunImmune = e.stunUntil + K.immuneMs; }
  }
  onDashEnd() { }
  knock(e, ux, uy, noStun) {
    if (e.ent !== 'player' || !e.alive || e.protUntil > this.now) return;
    const K = BAL.knock, n = this.now, sp = K.dist / (K.durMs / 1000);
    e.kb = { vx: ux * sp, vy: uy * sp, until: n + K.durMs }; e.charge = null;
    if (e.act && e.act.kind === 'dash') e.act = null;
    if (!noStun && n > e.stunImmune) { e.stunUntil = n + K.stunMs; e.stunImmune = e.stunUntil + K.immuneMs; }
  }
  regen(t, dt) {
    if (this.now - t.lastDmgAt < BAL.regen.delayMs) return;
    const per = BAL.pieces[t.type].regen / BAL.regen.periodSec;
    if (t.hp < t.maxHp) t.hp = Math.min(t.maxHp, t.hp + per * dt);
    if (t.shield < t.maxShield) t.shield = Math.min(t.maxShield, t.shield + BAL.regen.shieldPerSec * dt);
  }
  /* ---- damage / death ---- shield absorbs first, then HP. Only the server ever calls this. */
  damage(t, amt, att, meta) {
    meta = meta || {};
    if (t.ghost || t.dead || amt <= 0) return 0;
    if (t.ent === 'player' && (t.protUntil > this.now || !t.alive || t.leaving)) return 0;
    let d = amt; const sh = Math.min(t.shield, d); t.shield -= sh; d -= sh; const hl = Math.min(t.hp, d); t.hp -= hl;
    const dealt = sh + hl; if (dealt <= 0) return 0;
    t.prevDmgAt = t.lastDmgAt; t.lastDmgAt = this.now; t.lastDmgBy = att ? att.id : 0;
    this.onDamaged(t, att, dealt, hl, meta);
    if (t.hp <= 0) this.onKilled(t, att, meta);
    return dealt;
  }
  hitInfo(t, dealt, hl, meta, attType) {
    const n = this.now, W = this.cfg.world;
    return { dmg: dealt, hpLost: hl, killed: t.hp <= 0, tele: (meta.chargeMs || 0) >= 400, vicMoved: n - t.lastMoveAt < 800, stunned: t.stunUntil > n, cornered: Math.min(t.x, t.y, W - t.x, W - t.y) < 2.2, attVal: AVALf(attType), vicVal: AVALf(t.type) };
  }
  onKilled(t, att) { if (t.ent === 'player') this.killPlayer(t, att); }
  killPlayer(v, k) {
    if (!v.alive) return;
    v.alive = false; v.deadAt = this.now; v.view = { x: v.x, y: v.y }; v.act = null; v.charge = null; v.kb = null; v.air = false;
    if (k && k !== v) { // killer receives 50% of the victim's CURRENT elo (transfer, nothing extra)
      const g = Math.floor(v.elo * BAL.elo.killShare); v.elo -= g; k.elo += g; k.kills++; k.score += BAL.pieces[v.type].val; v.killer = k.id;
      this.send(k, { t: 'kill', n: v.name, g });
    } else v.killer = 0;
    this.onDeath(v, k);
    this.send(v, { t: 'dead', x: r2(v.x), y: r2(v.y), by: k ? k.name : '' });
    this.fx.push(['die', v.x, v.y, 0, 0, v.type]);
  }
  hasAlt(att, vic) { // another valid target close by (for ALTERNATIVE)
    let f = false;
    this.hash.query(att.x, att.y, 6, e => { if (f || e.ent !== 'player' || e === att || e === vic || !e.alive || e.leaving) return; if (Math.hypot(e.x - att.x, e.y - att.y) < 5 && e.hp / e.maxHp < vic.hp / vic.maxHp) f = true; });
    return f;
  }
}

/* ============================== SHARED HELPERS ============================== */
const DESPAWN_MS = 380;
const KV = { '0,-1': [1, -2], '1,-1': [2, -1], '1,0': [2, 1], '1,1': [1, 2], '0,1': [-1, 2], '-1,1': [-2, 1], '-1,0': [-2, -1], '-1,-1': [-1, -2] };
const knightVec = (dx, dy) => KV[dx + ',' + dy];
function distSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy; let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0; t = clamp(t, 0, 1);
  return Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
}
function dirOk(t, dx, dy) { if (!dx && !dy) return false; const d = dx && dy; return t === 'b' ? !!d : t === 'r' ? !d : true; }

/* ============================== GAME 1: BATTLE GRID ============================== */
class BattleGrid extends Game {
  constructor() {
    super('battlegrid', GRID);
    this.territory = new Map(); // "gx,gy" -> { side } - claimed board squares (chess "control the center" theme)
    this.contact = (m, e) => {
      if (e.owner === m.owner) return 'stop';
      const a = m.act; if (a.hit.has(e.id)) return 'stop';
      a.hit.add(e.id); a.hits++;
      if (!a.noDmg) this.damage(e, BAL.pieces[m.type].dmg, m, { chargeMs: a.chargeMs, atype: m.type });
      // The attacker takes over the exact cell the victim was standing on; the victim gets shoved one cell further.
      const vx = Math.floor(e.x) + .5, vy = Math.floor(e.y) + .5, wasPlayer = e.ent === 'player' && e.alive;
      this.knock(e, a.ux, a.uy, false);
      if (wasPlayer) { m.x = vx; m.y = vy; a.landOnGrid = true; }
      return 'stop';
    };
  }
  setType(p, t) { const s = BAL.pieces[t]; p.type = t; p.maxHp = s.hp; p.hp = s.hp; p.maxShield = s.shield; p.shield = s.shield; }
  initPlayer(p) {
    const s = this.spawnPos(); p.x = s.x; p.y = s.y; p.elo = GRID.startElo; p.peak = Math.max(p.peak, GRID.startElo);
    p.alive = true; this.setType(p, 'p'); p.protUntil = this.now + BAL.spawnProtectMs;
  }
  meState(p) { const o = super.meState(p); o.cd = Math.max(0, p.cdUntil - this.now); return o; }
  knock(e, ux, uy, noStun) { this.gridKnock(e, ux, uy, noStun, 1); }
  onMsg(p, m) {
    if (!p.alive || p.leaving) return;
    if (m.t === 'in') { p.in = { dx: sgn(m.dx), dy: sgn(m.dy) }; if (p.in.dx || p.in.dy) p.protUntil = 0; }
    else if (m.t === 'chg') this.startCharge(p, sgn(m.dx), sgn(m.dy));
    else if (m.t === 'rel') this.release(p);
    else if (m.t === 'cx') p.charge = null;
    else if (m.t === 'promo') this.promo(p, m.to);
  }
  onDamaged(t, att, dealt, hl, meta) { if (att && att !== t && t.ent === 'player') this.an.hit(att, t, this.hitInfo(t, dealt, hl, meta, meta.atype || att.type)); }
  startCharge(p, dx, dy) {
    const n = this.now;
    if (p.act && p.act.kind === 'hop') this.endHop(p);          // land the hop, then charge from that cell
    if (p.act || p.charge || n < p.stunUntil || n < p.cdUntil || !dirOk(p.type, dx, dy)) return;
    p.charge = { dx, dy, t0: n }; p.protUntil = 0;
  }
  enemyAt(p, x, y, r) {
    let f = false;
    this.hash.query(x, y, r + 1, e => { if (f || e === p || e.ent !== 'player' || !this.isSolid(e)) return; if (Math.hypot(e.x - x, e.y - y) < r) f = true; });
    return f;
  }
  // Server measures the charge itself (client cannot claim a longer/shorter charge).
  release(p) {
    const c = p.charge; if (!c) return; p.charge = null;
    const n = this.now, t = p.type;
    if (!p.alive || p.act || n < p.cdUntil || n < p.stunUntil) return;
    const dur = n - c.t0, G = GRID;
    if (t === 'n') { const v = knightVec(c.dx, c.dy); return this.startJump(p, v[0], v[1]); }
    if (t === 'p') {
      if (c.dx && c.dy) { // diagonal attack needs a target; otherwise cancelled (no invented damage)
        const cx = Math.floor(p.x) + c.dx + .5, cy = Math.floor(p.y) + c.dy + .5;
        if (!this.enemyAt(p, cx, cy, .8)) return; // must have enemy at diagonal target
        // Land exactly on the target cell after diagonal attack
        return this.startDash(p, c.dx, c.dy, 1, { pawn: true, chargeMs: dur, landOnGrid: true });
      }
      if (c.dx || c.dy) return this.startDash(p, c.dx, c.dy, 1, { pawn: true, noDmg: true, landOnGrid: true }); // straight = push only, no damage
      return; // no movement if no direction
    }
    this.startDash(p, c.dx, c.dy, clamp(Math.ceil(dur / (G.chargeSecPerGrid * 1000)), 1, G.maxCharge), { chargeMs: dur });
  }
  startDash(p, dx, dy, n, o) {
    const W = GRID.world, cx = Math.floor(p.x) + .5, cy = Math.floor(p.y) + .5; let k = n;
    while (k > 0) { const tx = cx + dx * k, ty = cy + dy * k; if (tx >= .5 && tx <= W - .5 && ty >= .5 && ty <= W - .5) break; k--; }
    if (k <= 0) return;
    const tx = cx + dx * k, ty = cy + dy * k, vx = tx - p.x, vy = ty - p.y, L = Math.hypot(vx, vy); if (L < .05) return;
    p.act = { kind: 'dash', ux: vx / L, uy: vy / L, len: L, moved: 0, speed: o.pawn ? 10 : GRID.dashSpeed, hit: new Set(), hits: 0, noDmg: !!o.noDmg, chargeMs: o.chargeMs || 0, sx: p.x, sy: p.y, landOnGrid: !!o.landOnGrid };
    p.cdUntil = this.now + GRID.cd[p.type] * 1000; p.protUntil = 0;
    this.fx.push(['dash', p.x, p.y, tx, ty, p.type]);
  }
  startJump(p, lx, ly) {
    const W = GRID.world, cx = Math.floor(p.x) + .5, cy = Math.floor(p.y) + .5, tx = cx + lx, ty = cy + ly;
    if (tx < .5 || ty < .5 || tx > W - .5 || ty > W - .5) return;
    const l = Math.hypot(tx - p.x, ty - p.y) || 1;
    p.act = { kind: 'jump', sx: p.x, sy: p.y, tx, ty, t0: this.now, dur: GRID.jumpMs, ux: (tx - p.x) / l, uy: (ty - p.y) / l };
    p.air = true; p.cdUntil = this.now + GRID.cd.n * 1000; p.protUntil = 0;
    this.fx.push(['jump', p.x, p.y, tx, ty, 'n']);
  }
  runJump(p) {
    const a = p.act, k = Math.min(1, (this.now - a.t0) / a.dur);
    p.x = a.sx + (a.tx - a.sx) * k; p.y = a.sy + (a.ty - a.sy) * k;
    if (k < 1) return;
    p.act = null; p.air = false;
    this.hash.query(p.x, p.y, 2.5, e => {
      if (e === p || e.ent !== 'player' || !this.isSolid(e)) return;
      if (Math.hypot(e.x - p.x, e.y - p.y) < 1.15) { this.damage(e, BAL.pieces.n.dmg, p, { chargeMs: 500, atype: 'n' }); this.knock(e, a.ux, a.uy, false); }
    });
    this.push(p); this.fx.push(['stomp', p.x, p.y, 0, 0, 'n']);
  }
  onDashEnd(m, a) {
    if (m.ent !== 'player' || !a || a.hits > 0 || a.len < 1.5) return;
    const mx = (a.sx + m.x) / 2, my = (a.sy + m.y) / 2, L = Math.hypot(m.x - a.sx, m.y - a.sy); let best = null;
    this.hash.query(mx, my, L / 2 + 3, e => {
      if (best || e === m || e.ent !== 'player' || !e.alive || e.leaving || e.protUntil > this.now) return;
      const d = distSeg(e.x, e.y, a.sx, a.sy, m.x, m.y); if (d > .6 && d < 2.4) best = e;
    });
    if (best) this.an.miss(m, best);
  }
  // Promotion needs ELO but does not spend it. No downgrade.
  promo(p, to) {
    const t = p.type, ok = (t === 'p' && (to === 'n' || to === 'b')) || ((t === 'n' || t === 'b') && to === 'r') || (t === 'r' && to === 'q');
    if (!ok || p.elo < GRID.promote[to]) return;
    this.setType(p, to); p.protUntil = 0; this.send(p, { t: 'promoted', k: to });
  }
  // Territory control: stand still on a square for a beat and it becomes yours (tinted your colour).
  // Standing on a square you already own gives a small passive HP/shield trickle - a reason to hold
  // ground instead of only ever chasing fights, chess-style "control the center" without any new input.
  claimTick(p, dt) {
    const n = this.now;
    if (p.act || p.charge) { p.holdKey = null; return; }
    const gx = Math.floor(p.x), gy = Math.floor(p.y), key = gx + ',' + gy;
    if (p.holdKey !== key) { p.holdKey = key; p.holdSince = n; }
    const cell = this.territory.get(key);
    if (cell && cell.side === p.side) {
      if (p.hp < p.maxHp) p.hp = Math.min(p.maxHp, p.hp + 1.5 * dt);
      if (p.shield < p.maxShield) p.shield = Math.min(p.maxShield, p.shield + 2 * dt);
    } else if (n - p.holdSince > 1000) {
      this.territory.set(key, { side: p.side });
    }
  }
  update(dt) {
    for (const p of this.players.values()) {
      if (!p.alive || p.leaving) continue;
      const n = this.now; this.regen(p, dt);
      const ox = p.x, oy = p.y;
      if (p.act) { const k = p.act.kind; if (k === 'dash') this.runDash(p, dt, this.contact); else if (k === 'hop') this.runHop(p); else this.runJump(p); }
      // Battle Grid: NO automatic WASD movement - only charge+release for movement
      const mv = Math.hypot(p.x - ox, p.y - oy); if (mv > 1e-3) { p.lastMoveAt = n; p.trav += mv; }
      this.claimTick(p, dt);
      this.an.tick(p);
    }
  }
}

/* ============================== GAME 3: PIECES WITH PIECES ============================== */
class Pieces extends Game {
  constructor() {
    super('pieces', PWP);
    this.contact = (m, e) => { // m = flying piece
      if (e.owner === m.owner) return 'stop';
      const a = m.act; if (a.hit.has(e.id)) return 'pass';
      a.hit.add(e.id); a.hits++;
      const own = this.players.get(m.owner), dm = BAL.pieces[m.type].dmg;
      if (e.ent === 'player') {
        if (!a.noDmg) this.damage(e, dm, own, { chargeMs: a.chargeMs, atype: m.type });
        // A thrown piece takes the King's exact square. The King is shoved/falls over instead of using the old generic slide.
        const vx = Math.floor(e.x) + .5, vy = Math.floor(e.y) + .5, wasAlive = e.alive;
        if (wasAlive) this.kingHit(e, a.ux, a.uy);
        if (wasAlive) { m.x = vx; m.y = vy; a.landOnGrid = true; }
        this.fx.push(['capture', vx, vy, e.id, 0, m.type]);
        return 'stop';
      }
      // Throwing directly onto an enemy placed piece is a capture: the thrown piece takes its square.
      if (e.ent === 'piece') {
        const ex = e.x, ey = e.y;
        e.dead = true; e.act = null; e.air = false; e.st = 'captured';
        m.x = ex; m.y = ey; a.landOnGrid = true; a.captured = true;
        this.fx.push(['capture', ex, ey, e.id, 0, m.type]);
        return 'stop';
      }
      const eMoving = !!e.act;
      if (!a.noDmg) this.damage(e, dm, own, { atype: m.type });
      this.damage(m, BAL.pieces[e.type].dmg * (eMoving ? .5 : .35), this.players.get(e.owner), { atype: e.type });
      if (m.dead) return 'stop';
      if (e.dead) return 'pass';                                             // destroyed: path is clear
      if (eMoving && this.power(m) > this.power(e)) { e.act = null; e.air = false; this.settle(e); return 'pass'; } // stronger keeps going
      return 'stop';
    };
  }
  power(u) { return (u.hp + u.shield) * (1 + .15 * BAL.pieces[u.type].val); }
  hopTiming(p) {
    const speed = BAL.pieces[p.type] && BAL.pieces[p.type].speed || PWP.hop.baseSpeed;
    const cycle = PWP.hop.cycleMs * PWP.hop.baseSpeed / Math.max(.1, speed);
    const dur = clamp(cycle * PWP.hop.arcRatio, 220, 420);
    return { dur, gap: Math.max(0, cycle - dur) };
  }
  kingHit(p, ux, uy) {
    if (!p || p.ent !== 'player' || !p.alive || p.protUntil > this.now) return;
    p.fallAt = this.now; p.fallDur = 420; p.fallUntil = this.now + p.fallDur; p.fallDx = ux; p.fallDy = uy;
    this.gridKnock(p, ux, uy, false, 1);
  }
  lineTarget(u) {
    const t = u.type, max = BAL.pieces[t].range;
    const dirs = t === 'b'
      ? [[1,1],[1,-1],[-1,1],[-1,-1]]
      : t === 'r'
        ? [[1,0],[-1,0],[0,1],[0,-1]]
        : [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]];
    const rays = new Map();
    this.hash.query(u.x, u.y, max + 1.2, e => {
      if (e === u || e.dead || e.ghost || e.air || e.st === 'despawn' || e.st === 'captured' || e.ent === 'puddle') return;
      if (e.ent !== 'player' && e.ent !== 'piece') return;
      if (e.ent === 'player' && (!e.alive || e.leaving)) return;
      const dx = e.x - u.x, dy = e.y - u.y, d = Math.hypot(dx, dy);
      if (d < .05 || d > max + e.r) return;
      for (let i = 0; i < dirs.length; i++) {
        const v = dirs[i], l = Math.hypot(v[0], v[1]), ux = v[0] / l, uy = v[1] / l;
        const along = dx * ux + dy * uy;
        const side = Math.abs(dx * uy - dy * ux);
        if (along > 0 && along <= max + e.r && side <= Math.max(.42, e.r * .7)) {
          const cur = rays.get(i);
          if (!cur || along < cur.d) rays.set(i, { e, d: along });
          break;
        }
      }
    });
    const targets = [];
    for (const hit of rays.values()) if (hit.e.owner !== u.owner) targets.push(hit);
    targets.sort((a, b) => a.d - b.d);
    return targets.length ? targets[0].e : null;
  }

  attackTarget(u) {
    const t = u.type, range = BAL.pieces[t].range;
    if (t === 'p') {
      let best = null, bd = 1e9;
      this.hash.query(u.x, u.y, 2.0, e => {
        if (e === u || e.dead || e.ghost || e.air || e.st === 'despawn' || e.ent !== 'player' && e.ent !== 'piece' || e.owner === u.owner) return;
        const dx = Math.abs(e.x - u.x), dy = Math.abs(e.y - u.y), d = Math.hypot(dx, dy);
        if (dx > .85 || dy > .85 || d > 1.45) return;
        if (d < bd) { bd = d; best = e; }
      });
      return best;
    }
    if (t === 'n') {
      const v = [[2,1],[2,-1],[-2,1],[-2,-1],[1,2],[1,-2],[-1,2],[-1,-2]]; let best = null, bd = 1e9;
      for (const d of v) this.hash.query(u.x + d[0], u.y + d[1], 1.0, e => { if (e === u || e.dead || e.ghost || e.air || e.st === 'despawn' || (e.ent !== 'player' && e.ent !== 'piece') || e.owner === u.owner) return; const dd = Math.hypot(e.x-u.x,e.y-u.y); if (dd < bd && dd <= 2.6) { bd=dd; best=e; } });
      return best;
    }
    return this.lineTarget(u);
  }
  updatePlacedAttacks() {
    const now = this.now;
    for (const u of this.units.values()) {
      if (u.dead || u.st !== 'placed' || u.act || u.air || u.ghost) continue;
      if (now < u.cdUntil) continue;
      const target = this.attackTarget(u); if (!target) continue;
      const owner = this.players.get(u.owner); if (!owner) continue;
      const dmg = BAL.pieces[u.type].dmg;
      u.cdUntil = now + (PWP.autoCd[u.type] || 1.2) * 1000;
      this.fx.push(['piecehit', u.x, u.y, target.x, target.y, u.type]);
      this.damage(target, dmg, owner, { atype: u.type, auto: true });
      if (target.ent === 'player' && target.alive) this.kingHit(target, Math.sign(target.x - u.x) || 1, Math.sign(target.y - u.y) || 0);
    }
  }
  initPlayer(p) {
    const s = this.spawnPos(); p.x = s.x; p.y = s.y; p.elo = 0; p.alive = true; p.type = 'k'; p.sel = null;
    p.cds = { p: 0, n: 0, b: 0, r: 0, q: 0 };
    const st = BAL.pieces.k; p.maxHp = st.hp; p.hp = st.hp; p.maxShield = st.shield; p.shield = st.shield; p.protUntil = this.now + BAL.spawnProtectMs;
  }
  knock(e, ux, uy, noStun) { this.gridKnock(e, ux, uy, noStun, 2); }
  meState(p) { const o = super.meState(p), n = this.now; o.sel = p.sel; o.cd = {}; for (const k in p.cds) o.cd[k] = Math.max(0, p.cds[k] - n); return o; }
  onMsg(p, m) {
    if (!p.alive || p.leaving) return;
    if (m.t === 'in') { p.in = { dx: sgn(m.dx), dy: sgn(m.dy) }; if (p.in.dx || p.in.dy) p.protUntil = 0; }
    else if (m.t === 'sel') {   // clicking the piece you are already holding puts it away again
      if (m.k === null) { p.sel = null; return; }
      if (typeof m.k === 'string' && m.k.length === 1 && 'pnbrq'.includes(m.k)) { p.sel = p.sel === m.k ? null : m.k; p.charge = null; p.protUntil = 0; if (p.sel) this.endHop(p); }
    }
    else if (m.t === 'chg') {
      const dx = sgn(m.dx), dy = sgn(m.dy), n = this.now, t = p.sel;
      if (!t || p.charge || n < p.stunUntil || n < p.cds[t] || p.elo < PWP.cost[t] || !dirOk(t, dx, dy)) return;
      this.endHop(p);
      p.charge = { dx, dy, t0: n }; p.protUntil = 0;
    }
    else if (m.t === 'rel') this.release(p);
    else if (m.t === 'cx') p.charge = null;
  }
  onDamaged(t, att, dealt, hl, meta) {
    if (!att) return;
    if (t.ent === 'player') { if (att !== t) this.an.hit(att, t, this.hitInfo(t, dealt, hl, meta, meta.atype || 'q')); return; }
    const vic = this.players.get(t.owner); if (!vic || vic === att) return;
    if (t.hp <= 0) this.an.pieceHit(att, vic, t.type, true);
    else if (dealt / (t.maxHp + t.maxShield) >= .3) this.an.pieceHit(att, vic, t.type, false);
  }
  onKilled(t, att) { if (t.ent === 'player') return this.killPlayer(t, att); t.dead = true; t.act = null; this.fx.push(['pop', t.x, t.y, 0, 0, t.type]); }
  onDeath(v) { for (const u of this.units.values()) if (u.owner === v.id && !u.dead) { u.st = 'despawn'; u.ds = this.now; u.act = null; u.air = false; } }
  onLeave(p) { for (const u of this.units.values()) if (u.owner === p.id) { u.ghost = true; u.rs = true; u.act = null; u.air = false; } }
  onRemove(p) { for (const u of this.units.values()) if (u.owner === p.id) u.dead = true; }
  release(p) {
    const c = p.charge; if (!c) return; p.charge = null;
    const n = this.now, t = p.sel, W = PWP.world;
    if (!t || !p.alive || n < p.stunUntil || n < p.cds[t] || p.elo < PWP.cost[t] || !dirOk(t, c.dx, c.dy)) return;
    const dur = n - c.t0, len = Math.hypot(c.dx, c.dy), ux = c.dx / len, uy = c.dy / len, kcx = Math.floor(p.x) + .5, kcy = Math.floor(p.y) + .5;
    if (t === 'n') { // fixed knight jump over anything in the way
      const v = knightVec(c.dx, c.dy), tx = kcx + v[0], ty = kcy + v[1];
      if (tx < .5 || ty < .5 || tx > W - .5 || ty > W - .5) return;
      const l = Math.hypot(tx - p.x, ty - p.y) || 1;
      return this.spawn(p, t, p.x, p.y, { kind: 'jump', sx: p.x, sy: p.y, tx, ty, t0: n, dur: PWP.jumpMs, ux: (tx - p.x) / l, uy: (ty - p.y) / l }, true);
    }
    let cnt = t === 'p' ? (dur >= 400 ? 2 : 1) : clamp(Math.ceil(dur / (PWP.chargeSecPerGrid * 1000)), 1, PWP.maxCharge);
    const sx = p.x + ux * .95, sy = p.y + uy * .95;
    if (sx < .5 || sy < .5 || sx > W - .5 || sy > W - .5) return;
    while (cnt > 0) { const tx = kcx + c.dx * cnt, ty = kcy + c.dy * cnt; if (tx >= .5 && tx <= W - .5 && ty >= .5 && ty <= W - .5) break; cnt--; }
    if (cnt <= 0) return;
    const tx = kcx + c.dx * cnt, ty = kcy + c.dy * cnt, vx = tx - sx, vy = ty - sy, L = Math.hypot(vx, vy), along = vx * ux + vy * uy;
    const noDmg = t === 'p' && !(c.dx && c.dy);
    const act = along > .05 ? { kind: 'dash', ux: vx / L, uy: vy / L, len: L, moved: 0, speed: PWP.dashSpeed, hit: new Set(), hits: 0, noDmg, chargeMs: dur, sx, sy } : null;
    this.spawn(p, t, sx, sy, act, false, tx, ty);
  }
  spawn(p, t, x, y, act, air, tx, ty) {
    if (!air) { // start spot must not be inside a wall / own piece (an enemy King there is simply the first thing hit)
      let bad = false; this.hash.query(x, y, 1.6, e => { if (bad || !this.isSolid(e) || e.ent === 'player') return; if (Math.hypot(e.x - x, e.y - y) < .42 + e.r) bad = true; });
      if (bad) return;
    }
    // Hard cap per piece type: once the limit is reached, throwing another of that type despawns
    // the oldest one of that type to make room (newest is always kept).
    const own = [...this.units.values()].filter(u => u.owner === p.id && u.type === t && !u.dead && u.st !== 'despawn').sort((a, b) => a.born - b.born);
    while (own.length >= PWP.limit[t]) { const o = own.shift(); o.st = 'despawn'; o.ds = this.now; o.act = null; o.air = false; }
    const st = BAL.pieces[t], n = this.now;
    const u = { id: this.nextId++, ent: 'piece', owner: p.id, type: t, x, y, r: .42, hp: st.hp, maxHp: st.hp, shield: st.shield, maxShield: st.shield, st: 'fly', born: n, act, air: !!air, dead: false, lastDmgAt: 0, prevDmgAt: 0, lastDmgBy: 0, lastMoveAt: 0 };
    p.elo -= PWP.cost[t]; p.cds[t] = n + PWP.cd[t] * 1000; p.protUntil = 0;
    this.units.set(u.id, u); this.hash.add(u);
    if (air) this.fx.push(['jump', x, y, act ? act.tx : x, act ? act.ty : y, t]);
    if (!act) this.settle(u);
  }
  settle(u, exact = false) {
    const W = PWP.world;
    if (exact) { u.x = clamp(u.x, u.r, W - u.r); u.y = clamp(u.y, u.r, W - u.r); u.st = 'placed'; u.act = null; u.air = false; return; }
    const cx = Math.floor(u.x) + .5, cy = Math.floor(u.y) + .5, c = [];
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) { const x = cx + i, y = cy + j; if (x >= .5 && y >= .5 && x <= W - .5 && y <= W - .5) c.push([x, y, Math.hypot(x - u.x, y - u.y)]); }
    c.sort((a, b) => a[2] - b[2]);
    for (const q of c) if (!this.solidNear(q[0], q[1], u.r, u)) { u.x = q[0]; u.y = q[1]; break; }
    u.st = 'placed'; u.act = null; u.air = false;
  }
  onDashEnd(m, a) { if (m.ent === 'piece' && !m.dead) this.settle(m, !!(a && a.landOnGrid)); }
  runJump(u) {
    const a = u.act, k = Math.min(1, (this.now - a.t0) / a.dur);
    u.x = a.sx + (a.tx - a.sx) * k; u.y = a.sy + (a.ty - a.sy) * k;
    if (k < 1) return;
    u.act = null; u.air = false; const own = this.players.get(u.owner);
    this.hash.query(u.x, u.y, 2.5, e => {
      if (e === u || !this.isSolid(e) || e.owner === u.owner) return;
      if (Math.hypot(e.x - u.x, e.y - u.y) < 1.15) { this.damage(e, BAL.pieces.n.dmg, own, { chargeMs: 500, atype: 'n' }); if (e.ent === 'player') this.knock(e, a.ux, a.uy, false); }
    });
    this.settle(u); this.fx.push(['stomp', u.x, u.y, 0, 0, 'n']);
  }
  update(dt) {
    const n = this.now;
    for (const p of this.players.values()) {
      if (!p.alive || p.leaving) continue;
      this.regen(p, dt);
      const ox = p.x, oy = p.y;
      if (p.act && p.act.kind === 'hop') this.runHop(p);
      else if (!p.sel && n >= p.stunUntil && !p.charge) this.hopTry(p, p.in.dx, p.in.dy);   // holding a piece roots the King: WASD aims instead
      const mv = Math.hypot(p.x - ox, p.y - oy); if (mv > 1e-3) { p.lastMoveAt = n; p.trav += mv; }
      const got = this.orbs.take(p); if (got) p.elo += got;
      this.an.tick(p);
    }
    for (const u of this.units.values()) {
      if (u.dead) continue;
      if (u.st === 'despawn' || u.st === 'captured') { if (n - (u.ds || n) > PWP.despawnMs) u.dead = true; continue; }
      if (u.act) { if (u.act.kind === 'dash') this.runDash(u, dt, this.contact); else this.runJump(u); }
    }
    this.updatePlacedAttacks();
  }
  startHop(p, tx, ty, ms) {
    const timing = this.hopTiming(p);
    super.startHop(p, tx, ty, timing.dur, false);
    p.hopAt = this.now + timing.dur + timing.gap;
    return true;
  }
  // Override runHop for Pieces with Pieces to fix jump/land/jump bug
  runHop(p) {
    const a = p.act, k = Math.min(1, (this.now - a.t0) / a.dur);
    const e = k < .5 ? 2*k*k : 1 - Math.pow(-2*k + 2, 2)/2;
    p.x = a.sx + (a.tx - a.sx) * e; p.y = a.sy + (a.ty - a.sy) * e;
    if (k < 1) return;
    p.x = a.tx; p.y = a.ty; p.act = null;
    this.fx.push(['dust', p.x, p.y, a.kb ? 1 : 0, 0, p.type]);
  }
}

registerTest('PWP: hop cycle is 1 second at base speed and speeds up with movement speed', () => {
  const g = new Pieces(); const c = new FakeConn('a'); g.connect(c); c.emit({ t:'join', name:'A' });
  const p = [...g.players.values()][0];
  const base = g.hopTiming(p);
  assert(Math.abs((base.dur + base.gap) - 1000) < 1, 'base hop cycle must be 1 second');
  const fast = { ...p, type:'q' }; const faster = g.hopTiming(fast);
  assert(faster.dur + faster.gap < base.dur + base.gap, 'faster movement speed must mean faster hop cycle');
});
registerTest('PWP: thrown piece captures an enemy placed piece onto its exact square', () => {
  const g = new Pieces(); const c1=new FakeConn('a'), c2=new FakeConn('b'); g.connect(c1); g.connect(c2);
  c1.emit({t:'join',name:'A'}); c2.emit({t:'join',name:'B'});
  const [p1,p2]=[...g.players.values()]; p1.elo=p2.elo=9999;
  const enemy={id:900,ent:'piece',owner:p2.id,type:'r',x:10.5,y:10.5,r:.42,hp:100,maxHp:100,shield:0,maxShield:0,dead:false,st:'placed',act:null,air:false};
  const attacker={id:901,ent:'piece',owner:p1.id,type:'n',x:9.5,y:10.5,r:.42,hp:100,maxHp:100,shield:0,maxShield:0,dead:false,act:{hit:new Set(),hits:0,noDmg:false,chargeMs:0,ux:1,uy:0},air:true,st:'fly'};
  g.units.set(enemy.id,enemy); g.units.set(attacker.id,attacker);
  g.contact(attacker,enemy);
  assert(enemy.dead,'enemy piece should be captured'); assertEq(attacker.x,10.5,'capturing piece must replace target x'); assertEq(attacker.y,10.5,'capturing piece must replace target y');
});
registerTest('PWP: placed rook attacks a King who walks into its line', () => {
  const g = new Pieces(); const c1=new FakeConn('a'), c2=new FakeConn('b'); g.connect(c1); g.connect(c2); c1.emit({t:'join',name:'A'}); c2.emit({t:'join',name:'B'});
  const [p1,p2]=[...g.players.values()]; p1.x=5.5;p1.y=5.5;p2.x=8.5;p2.y=5.5;p2.protUntil=0;
  const rook={id:901,ent:'piece',owner:p1.id,type:'r',x:6.5,y:5.5,r:.42,hp:100,maxHp:100,shield:0,maxShield:0,dead:false,st:'placed',act:null,air:false,cdUntil:0}; g.units.set(rook.id,rook);
  g.hash.clear();g.hash.add(p1);g.hash.add(p2);g.hash.add(rook);const before=p2.hp+p2.shield;g.updatePlacedAttacks();
  assert(p2.hp+p2.shield<before,'King should be auto-attacked inside a rook line');
});
/* ============================== PHASE 2 TESTS: battle grid + pwp ============================== */
registerTest('Battle Grid: grid movement validation (bounds + occupancy)', () => {
  const g = new BattleGrid();
  const c1 = new FakeConn('a'), c2 = new FakeConn('b');
  g.connect(c1); g.connect(c2);
  c1.emit({ t: 'join', name: 'A' }); c2.emit({ t: 'join', name: 'B' });
  const [p1, p2] = [...g.players.values()];
  p1.x = 10.5; p1.y = 10.5; p2.x = 11.5; p2.y = 10.5;
  g.hash.clear(); g.hash.add(p1); g.hash.add(p2);
  assert(!g.cellFree(p1, 11.5, 10.5), 'occupied cell must be rejected');
  assert(g.cellFree(p1, 9.5, 10.5), 'empty adjacent cell must be accepted');
  assert(!g.cellFree(p1, -0.5, 10.5), 'out-of-bounds cell must be rejected');
});
registerTest('Battle Grid: knockback shoves by exactly 1 whole validated cell (attacker replaces the victim\'s old cell)', () => {
  const g = new BattleGrid();
  const c = new FakeConn('a'); g.connect(c); c.emit({ t: 'join', name: 'A' });
  const p = [...g.players.values()][0];
  p.x = 10.5; p.y = 10.5; p.protUntil = 0;
  g.knock(p, 1, 0, true);
  assert(p.act && p.act.kind === 'hop', 'knockback must move via the validated hop path, not a free slide');
  assertEq(r2(p.act.tx), 11.5, 'knockback should land exactly 1 whole cell east');
  assertEq(r2(p.act.ty), 10.5, 'knockback should not drift off-axis');
});
registerTest('Battle Grid: knockback hop reaches the client (squash/stretch arc data)', () => {
  const g = new BattleGrid();
  const c = new FakeConn('a'); g.connect(c); c.emit({ t: 'join', name: 'A' });
  const p = [...g.players.values()][0];
  p.x = 10.5; p.y = 10.5; p.protUntil = 0; p.stunImmune = 0;
  g.knock(p, 1, 0, true);
  const packed = g.packPlayer(p);
  assert(packed.hk === 1, 'battlegrid snapshot must include hop-arc flag (client renders squash/stretch, not a teleport)');
  assert(packed.hsx !== undefined && packed.htx !== undefined, 'battlegrid snapshot must include hop start/target for arc interpolation');
});
registerTest('Battle Grid: orbs fully removed (no spawner, empty snapshot field)', () => {
  const g = new BattleGrid();
  assertEq(g.orbs, null, 'Battle Grid must not run an orb spawner');
});
registerTest('Battle Grid: standing still claims a square; standing on your own claimed square trickle-regens you', () => {
  const g = new BattleGrid();
  const c = new FakeConn('a'); g.connect(c); c.emit({ t: 'join', name: 'A' });
  const p = [...g.players.values()][0];
  p.x = 20.5; p.y = 20.5; p.act = null; p.charge = null;
  const key = Math.floor(p.x) + ',' + Math.floor(p.y);
  p.holdKey = key; p.holdSince = g.now - 1500; // simulate already having stood here for 1.5s
  g.claimTick(p, 0.05);
  const cell = g.territory.get(key);
  assert(cell && cell.side === p.side, "square must become claimed for the player's side after holding it");
  g.setType(p, 'q'); p.hp = 50; p.shield = 0; // queen has shield capacity, so this exercises both trickles
  g.claimTick(p, 1);
  assert(p.hp > 50, 'standing on your own claimed square should trickle-heal HP');
  assert(p.shield > 0, 'standing on your own claimed square should trickle-regen shield');
});
registerTest('Battle Grid: claimed squares reach the client in the snapshot as [gx,gy,side] triples', () => {
  const g = new BattleGrid();
  const c = new FakeConn('a'); g.connect(c); c.emit({ t: 'join', name: 'A' });
  const p = [...g.players.values()][0];
  p.x = 20.5; p.y = 20.5;
  g.territory.set('20,20', { side: p.side });
  g.snapshot(p);
  const s = c.last('s');
  assert(Array.isArray(s.tc) && s.tc.length === 3, 'snapshot must include the claimed square within view');
  assertEq(s.tc[0], 20, 'tc gx'); assertEq(s.tc[1], 20, 'tc gy');
  assertEq(s.tc[2], p.side === 'w' ? 1 : 2, "tc side code must match the claiming player's side");
});
registerTest('PWP: select/unselect toggle and held-piece movement lock', () => {
  const g = new Pieces();
  const c = new FakeConn('a'); g.connect(c); c.emit({ t: 'join', name: 'A' });
  const p = [...g.players.values()][0];
  p.elo = 999;
  assertEq(p.sel, null, 'starts with nothing held');
  c.emit({ t: 'sel', k: 'n' });
  assertEq(p.sel, 'n', 'selecting a piece should hold it');
  const x0 = p.x, y0 = p.y;
  p.in = { dx: 1, dy: 0 };
  g.tick();
  assertEq(p.x, x0, 'movement must be locked while holding a piece (x)');
  assertEq(p.y, y0, 'movement must be locked while holding a piece (y)');
  c.emit({ t: 'sel', k: 'n' });
  assertEq(p.sel, null, 'selecting the already-held piece again should put it away');
});


const RANK = { q: 0, r: 0, n: 1, b: 1, p: 2 };
class Kings extends Game {
  constructor() { super('kings', KOTK); this.pair = new Map(); this.pairGc = 0; this.puddles = []; this.nextPuddleId = 1; this.spawnPuddles(); this.clearPondOrbs(); this.shrine = { x: KOTK.world / 2, y: KOTK.world / 2, r: 6, owner: 0, control: 0 }; }
  // Neutral "control the center" capture point: whichever King has more army presence inside the shrine's
  // radius slowly claims it; a fully-captured shrine grants its owner a small passive ELO trickle. Ties
  // freeze progress (a real tug-of-war), and nobody nearby just holds the current state - no new input.
  updateShrine(dt) {
    const s = this.shrine, counts = new Map();
    for (const p of this.players.values()) {
      if (!p.alive || p.leaving) continue;
      let n = Math.hypot(p.x - s.x, p.y - s.y) < s.r ? 1 : 0;
      for (const u of p.army) if (!u.dead && Math.hypot(u.x - s.x, u.y - s.y) < s.r) n++;
      if (n > 0) counts.set(p.id, n);
    }
    let top = 0, topN = 0, tie = false;
    for (const [id, n] of counts) { if (n > topN) { topN = n; top = id; tie = false; } else if (n === topN) tie = true; }
    if (top && !tie) {
      if (s.owner === top) s.control = Math.min(100, s.control + dt * 12);
      else { s.control -= dt * 18; if (s.control <= 0) { s.owner = top; s.control = 0; } }
    }
    const owner = s.owner ? this.players.get(s.owner) : null;
    if (owner && owner.alive && s.control >= 100) {
      owner.elo += 4 * dt;
      // Claimed Shine heals only the owner's buildings inside the smaller healing ring.
      for (const b of owner.blds) {
        if (!b || b.dead) continue;
        if (Math.hypot(b.x - s.x, b.y - s.y) <= KOTK.shine.healR + b.r) b.hp = Math.min(b.maxHp, b.hp + KOTK.shine.healPerSec * dt);
      }
      this.updateQueenEvolution(owner);
    } else {
      for (const p of this.players.values()) {
        if (p.queenPawnId) { const q = this.units.get(p.queenPawnId); if (q) q.queenChargeAt = 0; p.queenPawnId = 0; }
      }
    }
  }
  updateQueenEvolution(owner) {
    const s = this.shrine, n = this.now;
    if (owner.queenNextAt > n) return;
    const inside = u => !u.dead && u.type === 'p' && !u.garrison && Math.hypot(u.x - s.x, u.y - s.y) <= KOTK.shine.healR + u.r;
    const candidates = owner.army.filter(inside);
    for (const u of owner.army) {
      if (u.dead || u.type !== 'p' || u.garrison) continue;
      if (inside(u)) { if (!u.queenChargeAt) u.queenChargeAt = n; } else u.queenChargeAt = 0;
    }
    if (owner.queenPawnId) {
      const active = this.units.get(owner.queenPawnId);
      if (!active || !inside(active)) { if (active) active.queenChargeAt = 0; owner.queenPawnId = 0; }
    }
    if (!owner.queenPawnId) {
      const fresh = owner.army.filter(inside).sort((a,b) => (a.queenChargeAt || n) - (b.queenChargeAt || n) || a.id - b.id)[0];
      if (fresh) owner.queenPawnId = fresh.id;
    }
    const active = owner.queenPawnId ? this.units.get(owner.queenPawnId) : null;
    if (!active || !inside(active)) return;
    const age = n - (active.queenChargeAt || n);
    if (age >= KOTK.shine.queenSec * 1000) {
      const st = BAL.pieces.q; active.type = 'q'; active.maxHp = st.hp; active.hp = st.hp; active.maxShield = st.shield; active.shield = st.shield; active.queenChargeAt = 0;
      owner.queenPawnId = 0; owner.queenNextAt = n + KOTK.shine.queenSec * 1000;
      this.fx.push(['queen', active.x, active.y, active.id, 0, 'q']);
      return;
    }
    // `queenChargeAt` itself is sent to clients so the active pawn can visibly shake from 15s onward.
  }
  pondGenCapacity(q) {
    const spacing = KOTK.puddles.generatorSpacing * KOTK.generator.radius;
    return Math.max(1, Math.floor((2 * Math.PI * q.r) / spacing));
  }
  generatorSlots(q) {
    const cap = this.pondGenCapacity(q), out = [], d = q.r + KOTK.generator.radius;
    for (let i = 0; i < cap; i++) {
      const a = -Math.PI / 2 + (Math.PI * 2 * i) / cap;
      out.push({ x: q.x + Math.cos(a) * d, y: q.y + Math.sin(a) * d, i });
    }
    return out;
  }
  spawnPuddles() {
    const K = KOTK.puddles, W = KOTK.world;
    for (let tries = 0; tries < 1200 && this.puddles.length < K.count; tries++) {
      const r = rnd(K.radiusMin, K.radiusMax);
      const x = rnd(r + 6, W - r - 6), y = rnd(r + 6, W - r - 6);
      let ok = true;
      for (const q of this.puddles) if (Math.hypot(x - q.x, y - q.y) < K.minGap + r * .35 + q.r * .35) { ok = false; break; }
      if (ok) {
        const q = { id: this.nextPuddleId++, x, y, r, genIds: [], ent: 'puddle', dead: false };
        this.puddles.push(q);
        this.hash.add(q);
      }
    }
  }
  clearPondOrbs() {
    if (!this.orbs || !this.puddles) return;
    for (const o of this.orbs.s) {
      if (!o.en || !o.on) continue;
      if (this.puddles.some(q => Math.hypot(q.x - o.x, q.y - o.y) < q.r + .8)) {
        o.on = false; o.at = this.now + 1000;
      }
    }
  }
  generatorCount(p) { return p.blds.filter(b => b.type === 'G' && !b.dead).length; }
  generatorCapacity() { return this.puddles.reduce((n, q) => n + this.pondGenCapacity(q), 0); }
  freeGeneratorSlot(q, x, y) {
    const occupied = q.genIds || [], slots = this.generatorSlots(q);
    let best = null, bd = 1e9;
    for (const slot of slots) {
      if (occupied.some(id => { const b = this.units.get(id); return b && !b.dead && Math.hypot(b.x - slot.x, b.y - slot.y) < KOTK.generator.radius * 1.55; })) continue;
      const d = Math.hypot(slot.x - x, slot.y - y);
      if (d < bd) { bd = d; best = slot; }
    }
    return best;
  }
  nearestFreePuddle(x, y, maxDist) {
    let best = null, bd = maxDist == null ? 7 : maxDist;
    for (const q of this.puddles) {
      if (!this.freeGeneratorSlot(q, x, y)) continue;
      const d = Math.hypot(q.x - x, q.y - y);
      if (d < bd) { bd = d; best = q; }
    }
    return best;
  }
  generatorPos(q, x, y) { return this.freeGeneratorSlot(q, x, y); }
  initPlayer(p) {
    const s = this.spawnPos(); p.x = s.x; p.y = s.y; p.elo = 0; p.alive = true; p.type = 'k';
    const st = BAL.pieces.k; p.maxHp = st.hp; p.hp = st.hp; p.maxShield = st.shield; p.shield = st.shield; p.protUntil = this.now + BAL.spawnProtectMs;
    Object.assign(p, { army: [], blds: [], aim: { x: p.x, y: p.y }, aimTarget: { x: p.x, y: p.y }, moving: false, fx: 0, fy: -1, groups: 1, splitAt: 0, splitAng: 0, boostUntil: 0, dirty: false, cull: false, exposed: true, anch: [{ x: p.x, y: p.y }], queenPawnId: 0, queenNextAt: 0 });
  }
  cap(p) { let add = 0; for (const b of p.blds) if (b.type === 'H' && !b.dead) add += KOTK.houseCap + (b.lvl || 0) * KOTK.houseCapPerLvl; return KOTK.baseCap + add; }
  houseCount(p) { let c = 0; for (const b of p.blds) if (b.type === 'H' && !b.dead) c++; return c; }
  genCount(p) { let c = 0; for (const b of p.blds) if (b.type === 'G' && !b.dead) c++; return c; }
  towerCount(p) { let c = 0; for (const b of p.blds) if (b.type === 'W' && !b.dead) c++; return c; }
  // Exponential ramps computed from config so the endpoints always land exactly on the numbers we tuned.
  housePrice(n) { const H = KOTK.house; return Math.round(H.base * Math.pow(H.maxCost / H.base, clamp(n, 0, H.cap - 1) / (H.cap - 1))); }
  upgradePrice(lvl) { const U = KOTK.upgrade; return Math.round(U.base * Math.pow(U.maxCost / U.base, clamp(lvl, 0, U.maxLvl - 1) / (U.maxLvl - 1))); }
  towerSlotPos(b, idx) {
    const g = KOTK.tower.grid, cell = (b.r * 2) / g, col = idx % g, row = Math.floor(idx / g);
    const x0 = b.x - b.r + cell / 2, y0 = b.y - b.r + cell / 2;
    return { x: x0 + col * cell, y: y0 + row * cell };
  }
  meState(p) {
    const o = super.meState(p); if (!p.army) return o;
    const cap = this.cap(p); o.cap = cap; o.cnt = p.army.length; o.over = p.army.length > cap ? 1 : 0; o.grp = p.groups;
    o.hcount = this.houseCount(p); o.tcount = this.towerCount(p); o.gcount = this.genCount(p); o.gcap = this.generatorCapacity(); o.hcost = this.housePrice(o.hcount);
    return o;
  }
  onMsg(p, m) {
    if (!p.alive || p.leaving) return;
    if (m.t === 'aim') { const x = +m.x, y = +m.y; if (isFinite(x) && isFinite(y)) p.aimTarget = { x: clamp(x, 0, KOTK.world), y: clamp(y, 0, KOTK.world) }; }
    else if (m.t === 'buy') this.buy(p, m.k);
    else if (m.t === 'place') this.place(p, m.k, m.x, m.y, m.qid);
    else if (m.t === 'split') this.split(p);
    else if (m.t === 'upgrade') this.upgrade(p, m.id);
    else if (m.t === 'garrison') this.garrison(p, m.id);
  }
  garrison(p, towerId) {
    const b = this.units.get(towerId);
    if (!b || b.dead || b.ent !== 'bld' || b.type !== 'W' || b.owner !== p.id) return;
    // Find the latest bought troop that is not already garrisoned
    let latest = null, latestIdx = -1;
    for (let i = p.army.length - 1; i >= 0; i--) {
      const u = p.army[i];
      if (!u.dead && !u.garrison) { latest = u; latestIdx = i; break; }
    }
    if (!latest) return;
    // Find an empty slot in the tower
    const K = KOTK;
    for (let i = 0; i < K.tower.slots; i++) {
      if (!b.slots[i]) {
        b.slots[i] = latest.id;
        latest.garrison = b.id;
        latest.slotIdx = i;
        return;
      }
    }
  }
  buy(p, k) {
    if (typeof k !== 'string' || k.length !== 1 || !'pnbr'.includes(k)) return; // Queens are earned at the Shrine, never bought directly.
    if (p.elo < KOTK.cost[k] || p.army.length >= this.cap(p)) return;  // capacity is enforced on purchase
    p.elo -= KOTK.cost[k]; p.protUntil = 0;
    const a = rnd(0, 6.28), st = BAL.pieces[k]; const counts = new Array(p.groups).fill(0); for (const u of p.army) counts[u.g]++;
    let g = 0; for (let i = 1; i < p.groups; i++) if (counts[i] < counts[g]) g = i;
    const u = { id: this.nextId++, ent: 'piece', owner: p.id, type: k, x: p.x + Math.cos(a) * 1.2, y: p.y + Math.sin(a) * 1.2, r: .5, hp: st.hp, maxHp: st.hp, shield: st.shield, maxShield: st.shield, dead: false, g, sx: 0, sy: 0, cdUntil: 0, scanAt: this.now + rnd(0, 250), tgt: null, act: null, air: false, lastDmgAt: 0, prevDmgAt: 0, lastDmgBy: 0, lastMoveAt: 0 };
    p.army.push(u); this.units.set(u.id, u); p.dirty = true;
  }
  place(p, k, x, y, qid) {
    const K = KOTK, kind = k === 'house' ? 'H' : k === 'gen' ? 'G' : k === 'tower' ? 'W' : null; if (!kind) return;
    x = +x; y = +y; if (!isFinite(x) || !isFinite(y)) return;
    // The King's Shrine is a strict no-build zone: nothing may be placed inside its capture radius.
    const inShrine = (px, py, rr) => Math.hypot(px - this.shrine.x, py - this.shrine.y) < this.shrine.r + rr;

    if (kind === 'G') {
      const requestedId = Number.isFinite(+qid) ? +qid : 0;
      const q = requestedId ? this.puddles.find(v => v.id === requestedId) : this.nearestFreePuddle(x, y, 8);
      const r = K.generator.radius, W = K.world;
      if (!q || this.genCount(p) >= this.generatorCapacity()) return;
      const pos = this.generatorPos(q, x, y);
      if (!pos || Math.hypot(pos.x - x, pos.y - y) > .7) return;
      if (inShrine(pos.x, pos.y, r)) return;
      if (p.elo < K.generator.cost || pos.x < r + 1 || pos.x > W - r - 1 || pos.y < r + 1 || pos.y > W - r - 1) return;
      let bad = false;
      this.hash.query(pos.x, pos.y, r + 4, e => {
        if (bad || e === q || e.ent === 'puddle' || e.dead) return;
        if (e.ent === 'bld' && Math.hypot(e.x - pos.x, e.y - pos.y) < r + e.r + .18) bad = true;
      });
      if (bad) return;
      p.elo -= K.generator.cost; p.protUntil = 0;
      const b = { id: this.nextId++, ent: 'bld', owner: p.id, type: 'G', x: pos.x, y: pos.y, r, hp: K.genHp, maxHp: K.genHp, shield: 0, maxShield: 0, dead: false, lvl: 0, puddleId: q.id, minePhase: 0, nextMineAt: this.now + K.generator.cycleMs, lastDmgAt: 0, prevDmgAt: 0, lastDmgBy: 0, lastMoveAt: 0 };
      if (!q.genIds) q.genIds = []; q.genIds.push(b.id);
      this.units.set(b.id, b); this.hash.add(b); p.blds.push(b);
      this.fx.push(['genplace', b.x, b.y, q.x, q.y, 0]);
      this.send(p, { t: 'genPlaced', id: b.id });
      return;
    }

    const r = kind === 'H' ? K.houseR : K.tower.r, W = K.world;
    if (inShrine(x, y, r)) return;
    let cost;
    if (kind === 'H') { const c = this.houseCount(p); if (c >= K.house.cap) return; cost = this.housePrice(c); }
    else { if (this.towerCount(p) >= K.tower.cap) return; cost = K.tower.cost; }
    if (p.elo < cost || x < r + 1 || y < r + 1 || x > W - r - 1 || y > W - r - 1) return;
    let bad = false; 
    this.hash.query(x, y, r + 4, e => { if (e.ent === 'bld' && !e.dead && Math.hypot(e.x - x, e.y - y) < r + e.r + .3) bad = true; });
    if (bad) return;
    // Prevent placing on top of puddles
    for (const q of this.puddles) { if (Math.hypot(q.x - x, q.y - y) < r + q.r + .3) bad = true; }
    if (bad) return;
    p.elo -= cost; p.protUntil = 0;
    const hp = kind === 'H' ? K.houseHp : K.tower.hp;
    const b = { id: this.nextId++, ent: 'bld', owner: p.id, type: kind, x, y, r, hp, maxHp: hp, shield: 0, maxShield: 0, dead: false, lvl: 0, lastDmgAt: 0, prevDmgAt: 0, lastDmgBy: 0, lastMoveAt: 0 };
    if (kind === 'W') b.slots = new Array(K.tower.slots).fill(null);
    this.units.set(b.id, b); this.hash.add(b); p.blds.push(b);
  }
  // Left-click on your own House/Generator: pay to raise its level (capacity or generation rate goes up, texture changes).
  upgrade(p, id) {
    const b = this.units.get(id); if (!b || b.dead || b.ent !== 'bld' || b.owner !== p.id || (b.type !== 'H' && b.type !== 'G')) return;
    const lvl = b.lvl || 0; let cost, maxLvl;
    if (b.type === 'G') {
      maxLvl = KOTK.generator.upgradeCosts.length; if (lvl >= maxLvl) return; cost = KOTK.generator.upgradeCosts[lvl];
    } else {
      maxLvl = KOTK.upgrade.maxLvl; if (lvl >= maxLvl) return; cost = this.upgradePrice(lvl);
    }
    if (p.elo < cost) { this.send(p, { t:'upgradeDenied', reason:'Not enough ELO' }); return; }
    p.elo -= cost; b.lvl = lvl + 1; p.protUntil = 0;
    this.fx.push(['genup', b.x, b.y, b.lvl, cost, b.type === 'G' ? 0 : 1]);
    this.send(p, { t: 'upgraded', id: b.id, lvl: b.lvl, cost, type: b.type });
  }
  // Left-click on your own Tower: garrison your most recently bought (still unassigned) troop into the next free slot.
  garrison(p, id) {
    const b = this.units.get(id); if (!b || b.dead || b.ent !== 'bld' || b.owner !== p.id || b.type !== 'W') return;
    let slotIdx = -1; for (let i = 0; i < b.slots.length; i++) if (!b.slots[i]) { slotIdx = i; break; }
    if (slotIdx < 0) return;                                    // tower full
    let u = null; for (let i = p.army.length - 1; i >= 0; i--) { const c = p.army[i]; if (!c.dead && !c.garrison) { u = c; break; } }
    if (!u) return;                                              // nothing free to post
    b.slots[slotIdx] = u.id; u.garrison = b.id; u.slotIdx = slotIdx; u.tgt = null; u.act = null;
  }
  split(p) {
    const g2 = p.groups * 2;
    if (p.army.length < g2 * 2) return;                       // never create impossible groups
    p.groups = g2; p.splitAt = this.now; p.splitAng = Math.atan2(p.fy, p.fx); p.boostUntil = this.now + KOTK.boostMs; p.protUntil = 0;
    const arr = p.army.slice().sort((a, b) => RANK[a.type] - RANK[b.type] || a.id - b.id);
    arr.forEach((u, i) => { u.g = i % g2; }); p.dirty = true;
  }
  formation(p) { // organized rings: inner Rook/Queen, middle Knight/Bishop, outer Pawns
    p.dirty = false;
    for (let g = 0; g < p.groups; g++) {
      const L = p.army.filter(u => u.g === g && !u.dead).sort((a, b) => a.id - b.id);
      const cats = [L.filter(u => RANK[u.type] === 0), L.filter(u => RANK[u.type] === 1), L.filter(u => RANK[u.type] === 2)];
      let rad = g === 0 ? 1.75 : 1.2, ring = 0;
      for (const cat of cats) {
        let i = 0;
        while (i < cat.length) {
          const cap = Math.max(1, Math.floor(2 * Math.PI * rad / 1.12)), n = Math.min(cap, cat.length - i), off = ring * .7;
          for (let k = 0; k < n; k++) { const a = off + 2 * Math.PI * k / n, u = cat[i + k]; u.sx = Math.cos(a) * rad; u.sy = Math.sin(a) * rad; }
          i += n; rad += 1.12; ring++;
        }
        if (cat.length) rad += .25;
      }
    }
  }
  onDamaged(t, att, dealt, hl, meta) {
    if (!att) return;
    if (t.ent === 'player') {
      if (att === t) return;
      const key = att.id * 100000 + t.id; let e = this.pair.get(key); if (!e) this.pair.set(key, e = { t: 0, acc: 0, hl: 0 });
      e.acc += dealt; e.hl += hl;
      if (this.now - e.t >= BAL.analysis.pairMs || t.hp <= 0) { this.an.hit(att, t, this.hitInfo(t, e.acc, e.hl, {}, meta.atype || 'q')); e.acc = e.hl = 0; e.t = this.now; }
      return;
    }
    const vic = this.players.get(t.owner); if (!vic || vic === att) return;
    if (t.ent === 'bld') { if (t.hp <= 0) this.an.bldKill(att, vic, t.type); return; }
    if (t.hp <= 0) this.an.pieceHit(att, vic, t.type, true);
    else if (dealt / (t.maxHp + t.maxShield) >= .3) this.an.pieceHit(att, vic, t.type, false);
  }
  onKilled(t, att) {
    if (t.ent === 'player') return this.killPlayer(t, att);
    t.dead = true; t.act = null; if (t.type === 'G' && t.puddleId) { const q = this.puddles.find(q => q.id === t.puddleId); if (q && q.genIds) q.genIds = q.genIds.filter(id => id !== t.id); } this.fx.push(['pop', t.x, t.y, 0, 0, t.type]);
    if (t.ent === 'piece' && t.garrison) { const b = this.units.get(t.garrison); if (b && b.slots) b.slots[t.slotIdx] = null; }
    const o = this.players.get(t.owner); if (o && o.army) o.cull = o.dirty = true;
  }
  onDeath(v,k) {
    const receiver=k&&k!==v&&k.ent==='player'&&k.alive&&!k.leaving?k:null,transferred=[];
    for(const u of this.units.values()){
      if(u.owner!==v.id||u.dead)continue;
      if(u.ent==='piece'&&receiver&&u.st!=='despawn'){
        if(u.garrison){const b=this.units.get(u.garrison);if(b&&b.slots)b.slots[u.slotIdx]=null;}
        u.owner=receiver.id;u.garrison=null;u.slotIdx=null;u.transferTo=receiver.id;u.transferStarted=this.now;u.tgt=null;u.act=null;u.air=false;u.ghost=false;u.st='placed';u.g=0;
        receiver.army.push(u);transferred.push(u);this.fx.push(['transfer',u.x,u.y,receiver.x,receiver.y,u.type]);
      }else{u.st='despawn';u.ds=this.now;u.ghost=true;u.act=null;u.air=false;}
    }
    v.army=[];v.blds=[];v.groups=1;if(receiver&&transferred.length)receiver.dirty=true;
  }
  onLeave(p) { for (const u of this.units.values()) if (u.owner === p.id) { u.ghost = true; u.rs = true; u.act = null; u.air = false; } }
  onRemove(p) { for (const u of this.units.values()) if (u.owner === p.id) u.dead = true; }
  walkSolid(m, e) { return this.isSolid(e) && (e.ent === 'player' || e.ent === 'bld' || e.ent === 'puddle'); } // Kings cannot walk through structures, other Kings, or ponds
  updateGenerators(dt) {
    const K = KOTK.generator, n = this.now;
    for (const b of this.units.values()) {
      if (b.ent !== 'bld' || b.type !== 'G' || b.dead) continue;
      const owner = this.players.get(b.owner);
      if (!owner || !owner.alive || owner.leaving) continue;
      if (b.nextMineAt == null) b.nextMineAt = n + K.cycleMs * .72;
      const elapsed = K.cycleMs - (b.nextMineAt - n);
      let phase = (elapsed / K.cycleMs) % 1; if (phase < 0) phase += 1;
      b.minePhase = phase;
      while (n >= b.nextMineAt) {
        const gain = K.eloPerHit[Math.min(b.lvl || 0, K.eloPerHit.length - 1)];
        owner.elo += gain;
        this.fx.push(['genhit', b.x - b.r * .72, b.y, gain, b.lvl || 0, b.puddleId || 0]);
        b.nextMineAt += K.cycleMs;
      }
    }
  }
  update(dt) {
    const n = this.now, K = KOTK;
    for (const p of this.players.values()) {
      if (!p.alive || p.leaving) continue;
      this.regen(p, dt);
      const ox = p.x, oy = p.y, boost = n < p.boostUntil;
      // Smooth the raw aim signal from the client toward aimTarget instead of snapping to it every tick -
      // that softens the direction-control feedback loop (camera follows the King, aim follows the camera)
      // which is what was causing the King to jitter/hunt instead of gliding smoothly toward the cursor.
      if (!p.aim) p.aim = { x: p.x, y: p.y };
      const aimK = 1 - Math.exp(-dt * 10);
      p.aim.x += (p.aimTarget.x - p.aim.x) * aimK; p.aim.y += (p.aimTarget.y - p.aim.y) * aimK;
      let vx = p.aim.x - p.x, vy = p.aim.y - p.y, d = Math.hypot(vx, vy);
      if (boost) { vx = p.fx; vy = p.fy; d = 1; }
      // Hysteresis dead-zone: start moving only past .35, but don't stop again until under .15 - stops the
      // King from flickering start/stop when the cursor sits right at the old fixed .25 threshold.
      if (!boost) { if (p.moving) { if (d < .15) p.moving = false; } else if (d > .35) p.moving = true; }
      if (boost || p.moving) { const sp = boost ? K.speed * K.boostMul : Math.min(K.speed, d * 6); this.walk(p, vx / d * sp * dt, vy / d * sp * dt); if (!boost) { p.fx = vx / d; p.fy = vy / d; } }
      const mv = Math.hypot(p.x - ox, p.y - oy); if (mv > 1e-3) { p.lastMoveAt = n; p.trav += mv; if (mv > .05) p.protUntil = 0; }
      const got = this.orbs.take(p); if (got) p.elo += got;
      if (p.cull) { p.army = p.army.filter(u => !u.dead); p.blds = p.blds.filter(b => !b.dead); p.cull = false; }
      let prot = 0; for (const u of p.army) if (Math.hypot(u.x - p.x, u.y - p.y) < 3.2) prot++;
      p.exposed = prot <= 1;
      if (p.groups > 1 && n - p.splitAt > K.regroupMs) { p.groups = 1; for (const u of p.army) u.g = 0; p.dirty = true; }
      if (p.dirty) this.formation(p);
      p.anch[0] = { x: p.x, y: p.y };
      for (let g = 1; g < p.groups; g++) {
        const a = p.splitAng + Math.PI / 2 + 2 * Math.PI * (g - 1) / (p.groups - 1);
        p.anch[g] = { x: clamp(p.x + Math.cos(a) * K.spreadR, 3, K.world - 3), y: clamp(p.y + Math.sin(a) * K.spreadR, 3, K.world - 3) };
      }
      this.an.tick(p);
    }
    this.updateGenerators(dt);
    this.updateShrine(dt);
    for (const u of this.units.values()) if (u.ent === 'piece' && !u.dead) this.unitAI(u, dt);
    for (const b of this.units.values()) if (b.ent === 'bld' && b.st === 'despawn' && !b.dead && n - b.ds > DESPAWN_MS) b.dead = true;
    this.separate();
    if (n - this.pairGc > 30000) { this.pairGc = n; for (const [k, e] of this.pair) if (n - e.t > 30000) this.pair.delete(k); }
  }
  unitAI(u, dt) {
    const p = this.players.get(u.owner), n = this.now, K = KOTK;
    if (!p) { u.dead = true; return; }
    if (u.st === 'despawn') { if (n - u.ds > DESPAWN_MS) u.dead = true; return; }
    if (u.ghost) return;
    if (!p.alive) { u.dead = true; return; }
    if (u.act) { this.unitJump(u); return; }
    if (u.transferTo) {
      const target=this.players.get(u.transferTo);
      if(!target||!target.alive||target.leaving){u.transferTo=null;}
      else { this.moveTo(u,target.x,target.y,dt,1.35); if(Math.hypot(u.x-target.x,u.y-target.y)<1.15){u.transferTo=null;u.g=0;u.sx=rnd(-1.2,1.2);u.sy=rnd(-1.2,1.2);u.tgt=null;p.dirty=true;this.fx.push(['takeover',u.x,u.y,target.x,target.y,u.type]);} return; }
    }
    if (K.regenArmy) this.regen(u, dt);
    // Troops can collect ELO from floor orbs
    const got = this.orbs.takeUnit(u); if (got) p.elo += got;
    if (u.garrison) {
      const b = this.units.get(u.garrison);
      if (b && !b.dead) { this.towerUnitAI(u, b, dt, p); return; }
      u.garrison = null; u.slotIdx = null;                       // tower is gone: troop is freed and rejoins the roaming army
    }
    if (n >= u.scanAt) { u.scanAt = n + 250 + Math.random() * 100; u.tgt = this.pickTarget(u); }
    let tg = u.tgt;
    if (tg && (tg.dead || tg.hp <= 0 || tg.ghost || tg.st === 'despawn' || (tg.ent === 'player' && (!tg.alive || tg.leaving)))) tg = u.tgt = null;
    const an = p.anch[u.g] || p.anch[0];
    if (tg && Math.hypot(u.x - an.x, u.y - an.y) > K.leash) tg = u.tgt = null;
    if (tg) this.engage(u, tg, dt, p); else this.follow(u, dt, an);
  }
  // A garrisoned troop guards its slot on the tower's 4x4 grid: it sorties out to hit whatever comes in range,
  // then walks back and stands its post. It never joins the King's roaming formation while the tower stands.
  towerUnitAI(u, b, dt, p) {
    const n = this.now, K = KOTK, slot = this.towerSlotPos(b, u.slotIdx);
    if (n >= u.scanAt) { u.scanAt = n + 250 + Math.random() * 100; u.tgt = this.pickTarget(u); }
    let tg = u.tgt;
    if (tg && (tg.dead || tg.hp <= 0 || tg.ghost || tg.st === 'despawn' || (tg.ent === 'player' && (!tg.alive || tg.leaving)))) tg = u.tgt = null;
    if (tg && Math.hypot(tg.x - slot.x, tg.y - slot.y) > K.tower.range) tg = u.tgt = null;
    if (tg) this.engage(u, tg, dt, p); else this.moveTo(u, slot.x, slot.y, dt, K.tower.sortieMul);
  }
  pickTarget(u) { // nearest enemy piece/building/King; spawn protection is the only King target lock
    let best = null, bd = 1e9;
    this.hash.query(u.x, u.y, KOTK.aggro, e => {
      if (e.owner === u.owner || e.dead || e.ghost || e.air || e.st === 'despawn' || e.ent === 'puddle') return;
      let d = Math.hypot(e.x - u.x, e.y - u.y); if (d > KOTK.aggro) return;
      if (e.ent === 'player') {
        // Troops should attack the enemy King when they reach it. `exposed` is a
        // gameplay/formation state, not a requirement for troop-vs-King combat.
        if (!e.alive || e.leaving || e.protUntil > this.now) return;
      } else if (e.ent === 'bld') d *= 1.25;
      else return;
      if (d < bd) { bd = d; best = e; }
    });
    return best;
  }
  moveTo(u, x, y, dt, mul) {
    const dx = x - u.x, dy = y - u.y, d = Math.hypot(dx, dy); if (d < .05) return;
    const s = Math.min(d, KOTK.unitSpeed * (mul || 1) * dt); u.x += dx / d * s; u.y += dy / d * s; u.lastMoveAt = this.now;
  }
  follow(u, dt, an) { const x = an.x + u.sx, y = an.y + u.sy, d = Math.hypot(x - u.x, y - u.y); this.moveTo(u, x, y, dt, 1 + Math.min(1, d / 5) * .6); }
  // best line alignment for bishop/rook/queen: returns {ok,ux,uy}
  aligned(t, dx, dy) {
    const dirs = t === 'b' ? [[1, 1], [1, -1], [-1, 1], [-1, -1]] : t === 'r' ? [[1, 0], [-1, 0], [0, 1], [0, -1]] : [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
    for (const d of dirs) { const l = Math.hypot(d[0], d[1]), ux = d[0] / l, uy = d[1] / l; if (dx * ux + dy * uy > 0 && Math.abs(dx * uy - dy * ux) < .55) return true; }
    return false;
  }
  alignPoint(t, u, tg) {
    const dirs = t === 'b' ? [[1, 1], [1, -1], [-1, 1], [-1, -1]] : t === 'r' ? [[1, 0], [-1, 0], [0, 1], [0, -1]] : [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
    const D = Math.min(KOTK.range[t] - .5, 4.2); let best = null, bd = 1e9;
    for (const d of dirs) { const l = Math.hypot(d[0], d[1]), x = tg.x - d[0] / l * D, y = tg.y - d[1] / l * D, dd = Math.hypot(x - u.x, y - u.y); if (dd < bd) { bd = dd; best = { x, y }; } }
    return best;
  }
  engage(u, tg, dt, p) {
    const t = u.type, K = KOTK, n = this.now, dx = tg.x - u.x, dy = tg.y - u.y, d = Math.hypot(dx, dy) || 1e-3, reach = u.r + tg.r;
    if (t === 'p') { if (d <= reach + .35) { if (n >= u.cdUntil) this.strike(u, tg, p); } else this.moveTo(u, tg.x, tg.y, dt, 1.1); return; }
    if (t === 'n') { if (d <= K.range.n) { if (n >= u.cdUntil) this.startUnitJump(u, tg); } else this.moveTo(u, tg.x, tg.y, dt, 1.1); return; }
    if (d <= K.range[t] && this.aligned(t, dx, dy)) { if (n >= u.cdUntil) this.line(u, tg, p); return; }
    const pt = this.alignPoint(t, u, tg); this.moveTo(u, pt.x, pt.y, dt, 1.1);
  }
  strike(u, tg, p) { u.cdUntil = this.now + KOTK.cd.p * 1000; this.fx.push(['hit', u.x, u.y, tg.x, tg.y, 'p']); this.damage(tg, BAL.pieces.p.dmg, p, { atype: 'p' }); }
  line(u, tg, p) {
    const K = KOTK, t = u.type, dx = tg.x - u.x, dy = tg.y - u.y, d = Math.hypot(dx, dy) || 1e-3, ux = dx / d, uy = dy / d, ex = tg.x + ux * .5, ey = tg.y + uy * .5, w = K.lineW[t] / 2, dmg = BAL.pieces[t].dmg;
    u.cdUntil = this.now + K.cd[t] * 1000; this.fx.push(['line', u.x, u.y, ex, ey, t]);
    this.hash.query((u.x + ex) / 2, (u.y + ey) / 2, d / 2 + 3, e => {
      if (e.owner === u.owner || e.dead || e.ghost || e.air || e.st === 'despawn') return;
      if (e.ent === 'player' && (e !== tg || !e.alive)) return; // kings are only hit when they are the chosen (exposed) target
      if (distSeg(e.x, e.y, u.x, u.y, ex, ey) <= w + e.r) this.damage(e, dmg, p, { atype: t });
    });
  }
  startUnitJump(u, tg) {
    const d = Math.hypot(tg.x - u.x, tg.y - u.y) || 1, off = u.r + tg.r + .15, tx = tg.x - (tg.x - u.x) / d * off, ty = tg.y - (tg.y - u.y) / d * off;
    u.act = { kind: 'jump', sx: u.x, sy: u.y, tx, ty, t0: this.now, dur: 450, tid: tg.id }; u.air = true; u.cdUntil = this.now + KOTK.cd.n * 1000;
    this.fx.push(['jump', u.x, u.y, tx, ty, 'n']);
  }
  unitJump(u) {
    const a = u.act, k = Math.min(1, (this.now - a.t0) / a.dur);
    u.x = a.sx + (a.tx - a.sx) * k; u.y = a.sy + (a.ty - a.sy) * k;
    if (k < 1) return;
    u.act = null; u.air = false; const p = this.players.get(u.owner); if (!p) return;
    this.hash.query(u.x, u.y, 3, e => {
      if (e.owner === u.owner || e.dead || e.ghost || e.air || e.st === 'despawn') return;
      if (e.ent === 'player' && e.id !== a.tid) return;
      if (Math.hypot(e.x - u.x, e.y - u.y) < 1.4 + (e.ent === 'bld' ? e.r : 0)) this.damage(e, BAL.pieces.n.dmg, p, { atype: 'n' });
    });
    this.fx.push(['stomp', u.x, u.y, 0, 0, 'n']);
  }
  separate() { // soft body-blocking so pieces never stack; buildings/kings push units fully out
    const W = KOTK.world;
    for (const u of this.units.values()) {
      if (u.ent !== 'piece' || u.dead || u.air || u.ghost || u.st === 'despawn') continue;
      this.hash.query(u.x, u.y, 4.5, e => {
        if (e === u || e.dead || e.ghost || e.air || e.st === 'despawn') return;
        if (e.ent === 'player' && !e.alive) return;
        if (u.garrison && e.id === u.garrison) return;            // don't shove a garrisoned troop off its own tower
        let dx = u.x - e.x, dy = u.y - e.y, d = Math.hypot(dx, dy); const rr = u.r + e.r + (e.ent === 'piece' ? .06 : 0);
        if (d >= rr) return;
        if (d < 1e-3) { dx = Math.random() - .5; dy = Math.random() - .5; d = Math.hypot(dx, dy) + 1e-3; }
        const o = (rr - d) * (e.ent === 'piece' ? .5 : 1); u.x += dx / d * o; u.y += dy / d * o;
      });
      u.x = clamp(u.x, u.r, W - u.r); u.y = clamp(u.y, u.r, W - u.r);
    }
  }
}
registerTest('Kings: center shrine capture requires uncontested presence and grants an ELO trickle once fully captured', () => {
  const g = new Kings();
  const c = new FakeConn('a'); g.connect(c); c.emit({ t: 'join', name: 'A' });
  const p = [...g.players.values()][0], s = g.shrine;
  p.x = s.x; p.y = s.y;
  for (let i = 0; i < 20; i++) g.updateShrine(0.5); // 10s of uncontested solo presence
  assertEq(s.owner, p.id, 'sole nearby King should eventually own the shrine');
  assertEq(s.control, 100, 'control should cap at 100');
  const eloBefore = p.elo;
  g.updateShrine(1);
  assert(p.elo > eloBefore, 'a fully-captured shrine should trickle ELO to its owner');
});
registerTest('Kings: shrine capture freezes when presence is contested (tied)', () => {
  const g = new Kings();
  const c1 = new FakeConn('a'), c2 = new FakeConn('b'); g.connect(c1); g.connect(c2);
  c1.emit({ t: 'join', name: 'A' }); c2.emit({ t: 'join', name: 'B' });
  const [p1, p2] = [...g.players.values()], s = g.shrine;
  p1.x = s.x; p1.y = s.y; p2.x = s.x + 1; p2.y = s.y;
  g.updateShrine(1);
  assertEq(s.owner, 0, 'tied presence must not hand over the shrine');
});
registerTest('Kings: shrine state reaches the client in the snapshot as [x,y,r,owner,control]', () => {
  const g = new Kings();
  const c = new FakeConn('a'); g.connect(c); c.emit({ t: 'join', name: 'A' });
  const p = [...g.players.values()][0];
  g.shrine.owner = p.id; g.shrine.control = 42;
  g.snapshot(p);
  const s = c.last('s');
  assert(Array.isArray(s.sh) && s.sh.length === 6, 'snapshot must include shrine state for Kings');
  assertEq(s.sh[3], p.id, 'shrine owner must reach the client');
  assertEq(s.sh[4], 42, 'shrine control must reach the client');
});

registerTest('Kings: Queens are not directly purchasable', () => {
  const g = new Kings(); const c = new FakeConn('a'); g.connect(c); c.emit({t:'join',name:'A'});
  const p = [...g.players.values()][0]; p.elo = 999999;
  g.buy(p, 'q');
  assertEq(p.army.length, 0, 'Queen purchase must be rejected');
});
registerTest('Kings: claimed Shine heals friendly buildings and only one pawn evolves each 30s', () => {
  const g = new Kings(); const c = new FakeConn('a'); g.connect(c); c.emit({t:'join',name:'A'});
  const p = [...g.players.values()][0], s = g.shrine;
  s.owner = p.id; s.control = 100;
  const b = { id: 990, ent:'bld', owner:p.id, type:'H', x:s.x, y:s.y, r:KOTK.houseR, hp:100, maxHp:600, dead:false };
  p.blds.push(b); g.units.set(b.id,b);
  const enemy = { id:991, ent:'bld', owner:999, type:'H', x:s.x, y:s.y, r:KOTK.houseR, hp:100, maxHp:600, dead:false };
  const enemyP = { id:999, blds:[enemy], army:[], alive:true }; g.players.set(enemyP.id, enemyP); g.units.set(enemy.id,enemy);
  g.updateShrine(1);
  assert(b.hp > 100, 'claimed Shine should heal a friendly building inside the healing ring');
  assertEq(enemy.hp, 100, 'claimed Shine must not heal an enemy building');
  const makePawn = id => ({id, ent:'piece', owner:p.id, type:'p', x:s.x, y:s.y, r:.5, hp:100, maxHp:100, shield:0, maxShield:0, dead:false, g:0, garrison:0});
  const a1=makePawn(992), a2=makePawn(993); p.army.push(a1,a2); g.units.set(a1.id,a1); g.units.set(a2.id,a2);
  a1.queenChargeAt=g.now-30000; a2.queenChargeAt=g.now-30000; p.queenPawnId=a1.id;
  g.updateQueenEvolution(p);
  assertEq(a1.type,'q','the active pawn should become a Queen after 30 seconds');
  assertEq(a2.type,'p','only one pawn should evolve per 30 second cycle');
  g.now += 30000; g.updateQueenEvolution(p);
  assertEq(a2.type,'q','the next pawn should be able to evolve on the next 30 second cycle');
});

/* ============================== PHASE: cross-mode "most kills" crown + Kings Shrine no-build zone ============================== */
registerTest('Most-kills crown: leader is broadcast as tk, and ties keep the previous leader', () => {
  const g = new BattleGrid();
  const c1 = new FakeConn('a'), c2 = new FakeConn('b'); g.connect(c1); g.connect(c2);
  c1.emit({ t: 'join', name: 'A' }); c2.emit({ t: 'join', name: 'B' });
  const [p1, p2] = [...g.players.values()];
  assertEq(g.topKiller, undefined, 'nobody has a kill yet');
  p1.kills = 2; p2.kills = 1; g.leaderboard();
  assertEq(g.topKiller, p1.id, 'player with more kills should be the crown holder');
  p2.kills = 2; g.leaderboard();                          // tie: p1 already held it, must not flip to p2
  assertEq(g.topKiller, p1.id, 'a tie must not steal the crown from whoever already holds it');
  p2.kills = 3; g.leaderboard();
  assertEq(g.topKiller, p2.id, 'strictly overtaking the kill count must move the crown');
  g.snapshot(p1);
  assertEq(c1.last('s').tk, p2.id, "snapshot must broadcast the current crown holder as 'tk'");
});
registerTest('Kings: the Shrine is a strict no-build zone for houses, generators and towers', () => {
  const g = new Kings();
  const c = new FakeConn('a'); g.connect(c); c.emit({ t: 'join', name: 'A' });
  const p = [...g.players.values()][0]; p.elo = 999999;
  const sx = g.shrine.x, sy = g.shrine.y, before = p.blds.length;
  g.place(p, 'house', sx, sy);
  assertEq(p.blds.length, before, 'a house must not be placeable inside the Shrine radius');
  g.place(p, 'tower', sx + 1, sy);
  assertEq(p.blds.length, before, 'a tower must not be placeable inside the Shrine radius');
  const q = g.puddles.find(q => Math.hypot(q.x - sx, q.y - sy) < g.shrine.r + 3);
  if (q) { g.place(p, 'gen', q.x, q.y, q.id); assertEq(p.blds.length, before, 'a generator must not be placeable inside the Shrine radius'); }
  g.place(p, 'house', sx + g.shrine.r + KOTK.houseR + 2, sy);
  assert(p.blds.length > before, 'a house just outside the Shrine radius should still be placeable');
});

/* ============================== CLIENT (runs in the browser; injected via clientMain.toString()) ============================== */
function clientMain() {
  'use strict';
  const CFG = window.__CFG, MODE = CFG.mode, G = CFG.g, P = CFG.pieces, KV = CFG.kv;
  const $ = id => document.getElementById(id);
  const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
  const cvs = $('game'), ctx = cvs.getContext('2d'), bgc = $('bg'), bgx = bgc.getContext('2d'), mm = $('mm'), mmx = mm.getContext('2d');
  let W = 0, H = 0, DPR = 1;
  const lsGet = (k, d) => { try { return localStorage.getItem(k) || d; } catch (e) { return d; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (e) { } };
  const opp = c => c === 'w' ? 'b' : 'w';
  const WORLD = G.world;
  const S = {
    ws: null, id: 0, side: lsGet('cio_side', 'w'), playing: false, dead: false, deadAt: 0, deathX: 0, deathY: 0, ents: new Map(), units: new Map(), orbs: [], view: { x: WORLD / 2, y: WORLD / 2, id: 0 },
    cam: { x: WORLD / 2, y: WORLD / 2, s: 40, vt: 14 }, camInit: false, introZoom: null, me: {}, lb: [], topKiller: 0, rk: 1, badges: new Map(), fx: [], puddles: [], tick: 0, t: 0, last: 0, k: {}, space: false, mouse: { x: 0, y: 0, down: false },
    chg: null, sel: null, place: null, selectedBld: 0, upgradeArmed: false, upgradeFastUntil: 0, upgradeFastId: 0, lastIn: '', lastInT: 0, lastAim: 0, aimX: 0, aimY: 0, chatOpen: false, specShown: false, ended: false, shake: 0, bubbles: new Map(), orbSeen: new Map(), terr: []
  };
  /* ---------- themes (cosmetic, client-side only) ---------- */
  const THEMES = [['Green / White', '#769656', '#eeeed2'], ['Gold / White', '#d0a12a', '#f7f1e1'], ['Blue / White', '#4a7ab8', '#e9eff8'], ['Red / White', '#b84a4a', '#f7eaea'], ['Purple / White', '#8a5fb5', '#f0e9f6'],
    ['Brown / Cream', '#a9764f', '#f0d9b5'], ['Dark Green / Cream', '#3f6b4a', '#efe9d0'], ['Black / Gray', '#2f2f2f', '#9b9b9b'], ['Blue / Gray', '#5b7a99', '#cbd0d8'], ['Pink / White', '#e58fb0', '#fbeaf1']];
  const hex = h => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
  let themeIdx = clamp(parseInt(lsGet('cio_theme', '0')) || 0, 0, THEMES.length - 1);
  const tc = { d: hex(THEMES[themeIdx][1]), l: hex(THEMES[themeIdx][2]) }, tt = { d: tc.d.slice(), l: tc.l.slice() };
  const col = a => 'rgb(' + (a[0] | 0) + ',' + (a[1] | 0) + ',' + (a[2] | 0) + ')';
  function setTheme(i) { themeIdx = i; lsSet('cio_theme', String(i)); tt.d = hex(THEMES[i][1]); tt.l = hex(THEMES[i][2]); document.querySelectorAll('.th').forEach((b, j) => b.classList.toggle('on', j === i)); }
  function themeStep(dt) { const k = 1 - Math.exp(-dt * 6); for (const n of ['d', 'l']) for (let i = 0; i < 3; i++) tc[n][i] += (tt[n][i] - tc[n][i]) * k; }

  /* ---------- assets: the supplied PNGs only ---------- */
  const IMG = {}, TAG = {}, warned = {}; let MAN = null;
  const loadImg = url => new Promise(res => { const i = new Image(); i.onload = () => res(i); i.onerror = () => res(null); i.src = url; });
  async function loadAssets() {
    try { MAN = await (await fetch('/assets/manifest.json')).json(); } catch (e) { MAN = { pieces: {}, tags: {} }; }
    const jobs = [];
    for (const k in MAN.pieces) if (k[0] !== '_') jobs.push(loadImg(MAN.pieces[k]).then(i => { IMG[k] = i; }));
    for (const k in MAN.tags) if (k[0] !== '_') jobs.push(loadImg(MAN.tags[k]).then(i => { TAG[k] = i; }));
    await Promise.all(jobs);
  }
  const GL = { wk: '\u2654', wq: '\u2655', wr: '\u2656', wb: '\u2657', wn: '\u2658', wp: '\u2659', bk: '\u265A', bq: '\u265B', br: '\u265C', bb: '\u265D', bn: '\u265E', bp: '\u265F' };
  const colorOf = owner => owner === S.id ? S.side : opp(S.side);   // per-client perspective: me = my choice, everyone else = the other colour

  /* ---------- menu ---------- */
  function buildMenu() {
    $('modeTitle').textContent = CFG.title;
    $('name').value = lsGet('cio_name', '');
    const kr = $('kings');
    for (const c of ['w', 'b']) {
      const b = document.createElement('button'); b.className = 'kb'; b.dataset.c = c;
      const im = document.createElement('img'); if (MAN.pieces[c + 'k']) im.src = MAN.pieces[c + 'k']; else im.alt = GL[c + 'k'];
      const sp = document.createElement('span'); sp.textContent = c === 'w' ? 'White King' : 'Black King';
      b.append(im, sp); b.onclick = () => { S.side = c; lsSet('cio_side', c); kr.querySelectorAll('.kb').forEach(x => x.classList.toggle('on', x.dataset.c === c)); };
      if (c === S.side) b.classList.add('on'); kr.appendChild(b);
    }
    const tr = $('themes');
    THEMES.forEach((t, i) => {
      const b = document.createElement('button'); b.className = 'th'; b.title = t[0];
      b.innerHTML = '<i style="background:' + t[2] + '"></i><i style="background:' + t[1] + '"></i><i style="background:' + t[1] + '"></i><i style="background:' + t[2] + '"></i>';
      b.onclick = () => setTheme(i); if (i === themeIdx) b.classList.add('on'); tr.appendChild(b);
    });
    const nv = $('nav');
    for (const n of CFG.nav) {
      const here = n[0] === MODE, soon = !!n[4];
      const b = document.createElement('button'); b.className = 'gcard' + (here ? ' cur' : '') + (soon ? ' soon' : ''); b.title = n[1];
      const mini = '<div class="mini">' + '<i></i>'.repeat(9) + '</div>';
      const pc = MAN.pieces['b' + n[3]] ? '<img class="pc" src="' + MAN.pieces['b' + n[3]] + '">' : '<span class="pc">' + GL['b' + n[3]] + '</span>';
      b.innerHTML = mini + pc + '<b>' + n[1] + '</b>' + (here ? '<em>You are here</em>' : soon ? '<em>Soon</em>' : '');
      b.onclick = () => { if (here) return; if (soon) { toast(n[1] + ' is coming soon'); return; } location.href = n[2]; };
      nv.appendChild(b);
    }
    $('play').onclick = play; $('name').addEventListener('keydown', e => { if (e.key === 'Enter') play(); });
  }
  function play() {
    if (S.ws) return; lsSet('cio_name', $('name').value); $('play').textContent = 'Connecting...';
    // Fade out background and menu card
    const fade = $('fade');
    fade.classList.add('fading');
    setTimeout(() => {
      $('menu').style.display = 'none';
      const ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws'); S.ws = ws;
      ws.onopen = () => ws.send(JSON.stringify({ t: 'join', name: $('name').value, side: S.side }));
      ws.onmessage = e => { try { onMsg(JSON.parse(e.data)); } catch (er) { console.error(er); } };
      ws.onclose = () => { if (S.playing) showEnd('Disconnected from server'); else { S.ws = null; $('play').textContent = 'Play'; } };
      // Fade in
      setTimeout(() => { fade.classList.remove('fading'); }, 100);
    }, 300);
  }
  const send = o => { if (S.ws && S.ws.readyState === 1) S.ws.send(JSON.stringify(o)); };
  function menuBg(dt) {
    const sz = 150; S.bgOff = ((S.bgOff || 0) + 20 * dt) % (sz * 2);
    bgx.setTransform(DPR, 0, 0, DPR, 0, 0); bgx.fillStyle = col(tc.l); bgx.fillRect(0, 0, W, H); bgx.fillStyle = col(tc.d);
    for (let i = -2; i < W / sz + 3; i++) for (let j = -3; j < H / sz + 3; j++) if (((i + j) & 1) === 1) bgx.fillRect(i * sz - S.bgOff, j * sz + S.bgOff, sz, sz);
  }

  /* ---------- networking ---------- */
  function onMsg(m) {
    switch (m.t) {
      case 'welcome': S.id = m.id; S.playing = true; document.body.classList.add('playing'); buildBar(); break;
      case 's': onSnap(m); break;
      case 'badge': addBadge(m); break;
      case 'chat': addChat(m.n, m.m); break;
      case 'kill': toast('Defeated ' + m.n + '  +' + m.g + ' ELO'); break;
      case 'promoted': toast('Promoted to ' + P[m.k].name); break;
      case 'genPlaced': toast('Generator placed beside Elo puddle'); break;
      case 'genUpgraded': toast('Generator upgraded to ' + G.generator.names[m.lvl]); break;
      case 'upgraded': S.selectedBld = m.id; S.upgradeArmed = false; S.upgradeFastId = m.id; S.upgradeFastUntil = S.t + 3; toast('Building upgraded'); break;
      case 'upgradeDenied': toast(m.reason || 'Cannot upgrade'); break;
      case 'dead': onDead(m); break;
      case 'shake': S.shake = 0.5; break;
    }
  }
  function onSnap(m) {
    S.tick++; S.me = m.me; S.lb = m.lb; S.topKiller = m.tk || 0; S.rk = m.rk; S.view = m.v;
    S.puddles = (m.pd || []).map(q => {
      if (!Array.isArray(q)) return null;
      const id = Number(q[0]), x = Number(q[1]), y = Number(q[2]), r = Number(q[3]), used = Number(q[4]), cap = Number(q[5]);
      if (![id, x, y, r].every(Number.isFinite) || r <= 0) return null;
      return [id, x, y, r, Number.isFinite(used) ? Math.max(0, used) : 0, Number.isFinite(cap) ? Math.max(1, cap) : 1];
    }).filter(Boolean);
    if (!S.camInit) {
      S.cam.x = m.v.x; S.cam.y = m.v.y; S.camInit = true;
      if (MODE === 'kings') {
        // spawn-in zoom transition: start pulled way back, then ease smoothly into normal play FOV
        const targetVt = targetVT();
        S.introZoom = { t0: S.t, dur: 1.15, vt0: targetVt * 2.6 };
        S.cam.vt = S.introZoom.vt0; S.cam.s = H / S.cam.vt;
      }
    }
    for (const e of m.e) {
      let o = S.ents.get(e.i);
      if (!o) { o = { id: e.i, rx: e.x, ry: e.y, vx: 0, vy: 0, h: e.h, j: 0, rj: 0, jVel: 0, hop: null, dx: 0, dy: 0, tdx: 0, tdy: 0, tilt: 0, tiltTarget: 0, kDist: 0, kSp: 0, kDirX: 0, kDirY: 0 }; S.ents.set(e.i, o); }
      if (e.h < o.h || e.s < o.s) { o.flash = S.t; o.dmgAt = S.t; } if (e.rs && !o.rsAt) o.rsAt = S.t;
      o.tx = e.x; o.ty = e.y; o.name = e.n; o.k = e.k; o.h = e.h; o.s = e.s; o.pr = e.p; o.st = e.st; o.rs = e.rs; o.hk = !!e.hk;
      if (o.hk && e.j > 0 && e.hsx !== undefined) {
        const serverJ = clamp(e.j, 0, 1), dur = e.hdur || 350;
        const sameHop = o.hop && Math.abs(o.hop.tx - e.htx) < .01 && Math.abs(o.hop.ty - e.hty) < .01;
        if (!sameHop) {
          o.hop = { sx: e.hsx, sy: e.hsy, tx: e.htx, ty: e.hty, dur, startAt: S.t - serverJ * dur / 1000 };
        } else {
          const localQ = clamp((S.t - o.hop.startAt) / (o.hop.dur / 1000), 0, 1);
          if (Math.abs(localQ - serverJ) > .15) o.hop.startAt = S.t - serverJ * dur / 1000;
        }
        o.j = serverJ;
      } else {
        if (o.hop) { o.rx = e.x; o.ry = e.y; o.hop = null; }
        o.j = o.rj = 0;
      }
      // Smooth facing direction interpolation - only for Battle Grid
      if (MODE === 'battlegrid' && e.dx !== undefined) { o.tdx = e.dx; o.tdy = e.dy; }
      o.dx = e.dx || 0; o.dy = e.dy || 0; o.fall = e.f || 0; o.fallDx = e.fx || 0; o.fallDy = e.fy || 0; o.seen = S.tick;
    }
    for (const [id, o] of S.ents) if (o.seen !== S.tick) S.ents.delete(id);
    for (const a of m.u) {
      // Defensive guard for old/stale snapshots: malformed entities without a
      // piece/building type are not renderable units.
      if (!a || a.length < 2 || a[1] == null) continue;
      let o = S.units.get(a[0]);
      if (!o) { o = { id: a[0], rx: a[3], ry: a[4], vx: 0, vy: 0, h: a[5], j: 0, rj: 0, jVel: 0 }; S.units.set(a[0], o); }
      if (a[5] < o.h) o.flash = S.t;
      o.k = a[1]; o.ow = a[2]; o.tx = a[3]; o.ty = a[4]; o.h = a[5]; o.s = a[6]; o.fl = a[7]; o.gr = a[9] || 0; o.ga = a[10] || 0; o.puddleId = a[11] || 0; o.tr = a[12] || 0; o.evo = a[13] || 0;
      if (o.k === 'H' || o.k === 'G' || o.k === 'W') o.lvl = a[8]; else setJ(o, a[8] || 0);
      o.seen = S.tick;
      if ((a[7] & 1) && !o.rsAt) o.rsAt = S.t; if ((a[7] & 2) && !o.dsAt) o.dsAt = S.t;
    }
    for (const [id, o] of S.units) {
      if (o.seen === S.tick) { o.missedAt = 0; continue; }
      // Kings sends the player's own army preferentially, but a dropped WebSocket
      // snapshot should not make troops visibly vanish for one frame. Keep the
      // last authoritative position briefly, then remove them if they truly stop
      // appearing (dead/despawned units are still removed normally).
      if (MODE === 'kings' && o.ow === S.id && o.k !== 'H' && o.k !== 'G' && o.k !== 'W') {
        if (!o.missedAt) o.missedAt = S.t;
        if (S.t - o.missedAt < 0.75) continue;
      }
      S.units.delete(id);
    }
    S.orbs = m.o || [];
    S.terr = m.tc || [];
    S.shrine = m.sh || null;
    { // record the real first-seen time per orb id so the fade-in plays exactly once, right when it spawns
      const seen = new Set();
      for (let i = 0; i < S.orbs.length; i += 3) { const oid = S.orbs[i]; seen.add(oid); if (!S.orbSeen.has(oid)) S.orbSeen.set(oid, S.t); }
      for (const oid of S.orbSeen.keys()) if (!seen.has(oid)) S.orbSeen.delete(oid);
    }
    for (const f of m.fx) S.fx.push({ k: f[0], x1: f[1], y1: f[2], x2: f[3], y2: f[4], ty: f[5], t0: S.t });
    if (S.fx.length > 80) S.fx.splice(0, S.fx.length - 80);
    updateHud();
  }
  function onDead(m) {
    S.dead = true; S.deadAt = S.t; S.deathX = m.x; S.deathY = m.y; S.chg = null; document.body.classList.add('dead');
    setTimeout(() => { S.specShown = true; $('spec').classList.add('show'); }, 2000);
  }
  function showEnd(txt) { S.ended = true; $('spec').classList.add('show'); $('specText').textContent = txt; }

  /* ---------- analysis badges (supplied PNGs, attached to the player's head, top-right) ---------- */
  function addBadge(m) {
    let a = S.badges.get(m.pid); if (!a) S.badges.set(m.pid, a = []);
    while (a.length >= 6) a.shift();                       // oldest removed when the cap is hit
    a.push({ key: m.key, dmg: m.dmg, t0: S.t, ox: (Math.random() - .5) * 14 + a.length * 3, oy: -a.length * 5 + (Math.random() - .5) * 6, rot: (Math.random() - .5) * .5 });
    if (m.msg) { const ent = S.ents.get(m.pid); if (ent) addChat(ent.name, m.msg); }   // contextual "!"/"?" feedback text
  }
  const ease = t => 1 - Math.pow(1 - clamp(t, 0, 1), 3);
  const TAGCOL = { brilliant: '#1baca6', great_find: '#5c8bb0', best: '#95bb4a', excellent: '#95bb4a', good: '#96af8b', book: '#a88865',
    inaccuracy: '#f7c631', mistake: '#ffa459', blunder: '#fa412d', correct: '#95bb4a', incorrect: '#fa412d', forced: '#96af8b',
    critical: '#e58f2a', sharp: '#e58f2a', alternative: '#749bbf', take_back: '#b58863', free_piece: '#26c2a3', missed_win: '#ee6b55',
    fast_win: '#5c8bb0', threat: '#d36f4a', mate: '#7c3aed', checkmate_white: '#7c3aed', checkmate_black: '#7c3aed', winner: '#f0b323',
    draw_white: '#8a8a8a', draw_black: '#8a8a8a', resign_white: '#e8e8e8', resign_black: '#3a3a3a',
    unnamed_clock_white: '#e8e8e8', unnamed_clock_black: '#3a3a3a' };
  const EMOJI_FONT = '"Segoe UI Emoji","Apple Color Emoji","Noto Color Emoji",sans-serif';
  // placeholder badge: coloured coin + emoji, drawn at the current transform origin
  function emojiTag(key, sz) {
    ctx.beginPath(); ctx.arc(0, 0, sz * .5, 0, 6.3);
    ctx.fillStyle = TAGCOL[key] || '#6b6b6b'; ctx.fill();
    ctx.lineWidth = Math.max(1.5, sz * .07); ctx.strokeStyle = 'rgba(0,0,0,.5)'; ctx.stroke();
    ctx.font = (sz * .56) + 'px ' + EMOJI_FONT; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(CFG.tagEmoji[key] || '?', 0, sz * .02); ctx.textBaseline = 'alphabetic';
  }
  const tagImg = key => (CFG.usePng && TAG[key]) || null;
  function drawBadges(pid, hx, hy, base) {
    const a = S.badges.get(pid); if (!a) return;
    for (let i = a.length - 1; i >= 0; i--) {
      const b = a[i], age = S.t - b.t0, life = b.dmg ? 1.5 : 1.7;
      if (age > life) { a.splice(i, 1); continue; }
      let sc, rot = 0;
      if (b.dmg) { // energetic: small -> big -> tiny overshoot -> settle, with a twist
        sc = age < .12 ? .25 + ease(age / .12) * 1.15 : age < .26 ? 1.4 - ease((age - .12) / .14) * .45 : age < .4 ? .95 + ease((age - .26) / .14) * .05 : 1;
        rot = b.rot * (1 - ease(age / .4));
      } else sc = age < .2 ? .45 + ease(age / .2) * .55 : 1;
      const fade = age > life - .45 ? 1 - (age - (life - .45)) / .45 : 1, rise = ease(age / life) * base * .35;
      const img = tagImg(b.key), sz = base * sc;
      ctx.save(); ctx.globalAlpha = clamp(fade, 0, 1); ctx.translate(hx + b.ox * base / 40, hy + b.oy * base / 40 - rise); ctx.rotate(rot);
      if (img) ctx.drawImage(img, -sz / 2, -sz / 2, sz, sz); else emojiTag(b.key, sz);
      ctx.restore();
    }
  }
  const headKind = () => 0;

  /* ---------- camera / layout ---------- */
  function resize() {
    W = innerWidth; H = innerHeight; DPR = Math.min(2, window.devicePixelRatio || 1);
    for (const c of [cvs, bgc]) { c.width = Math.floor(W * DPR); c.height = Math.floor(H * DPR); c.style.width = W + 'px'; c.style.height = H + 'px'; }
    mm.width = 120 * DPR; mm.height = 120 * DPR;
  }
  addEventListener('resize', resize);
  const w2sx = x => (x - S.cam.x) * S.cam.s + W / 2, w2sy = y => (y - S.cam.y) * S.cam.s + H / 2;

  function stepEnt(o, dt, rate) {
    const px=o.rx,py=o.ry;
    if (o.hop) {
      const q = clamp((S.t - o.hop.startAt) / (o.hop.dur / 1000), 0, 1);
      const travel = q < .5 ? 2*q*q : 1 - Math.pow(-2*q + 2, 2) / 2;
      o.rx = o.hop.sx + (o.hop.tx - o.hop.sx) * travel;
      o.ry = o.hop.sy + (o.hop.ty - o.hop.sy) * travel;
      o.rj = q;
      if (q >= .999 && o.j <= 0) { o.rx = o.hop.tx; o.ry = o.hop.ty; o.rj = 0; o.hop = null; }
    } else {
      if(Math.abs(o.tx-o.rx)>8||Math.abs(o.ty-o.ry)>8){o.rx=o.tx;o.ry=o.ty;}
      else { const throwing = MODE === 'pieces' && (o.fl & 4); const d = Math.hypot(o.tx - o.rx, o.ty - o.ry); if (throwing && d > .65) { const k = 1-Math.exp(-dt*52); o.rx += (o.tx-o.rx)*k; o.ry += (o.ty-o.ry)*k; } else { const k=1-Math.exp(-dt*(throwing ? 36 : rate));o.rx+=(o.tx-o.rx)*k;o.ry+=(o.ty-o.ry)*k; if(throwing && d<.08){o.rx=o.tx;o.ry=o.ty;} } }
    }
    const safeDt=Math.max(dt,.001),k2=1-Math.exp(-safeDt*16);
    o.vx+=((o.rx-px)/safeDt-o.vx)*k2;o.vy+=((o.ry-py)/safeDt-o.vy)*k2;
    if(MODE==='battlegrid'&&o.tdx!==undefined){
      const aimRate=15;
      o.dx+=(o.tdx-o.dx)*(1-Math.exp(-dt*aimRate));
      o.dy+=(o.tdy-o.dy)*(1-Math.exp(-dt*aimRate));
      o.tiltTarget=clamp(o.dx*.20-o.dy*.10,-.28,.28);
      o.tilt+=(o.tiltTarget-o.tilt)*(1-Math.exp(-dt*11));
    }
    stepJ(o,dt);
  }
  // Jump/hop progress (0..1) only arrives at network-tick rate, which is far slower than 60fps and looks like a
  // staircase if drawn raw. setJ() records the rate of change between the last two samples; stepJ() then advances
  // the rendered value every frame at that rate and gently reconciles it against the latest sample, so the arc is
  // buttery-smooth at render rate instead of snapping once per network tick.
  function setJ(o, rawJ) {
    const now = S.t, prev = o.j || 0;
    if (rawJ <= 0) {
      o.j = 0; o.jVel = 0; o.jRxAt = now;
      if (o.rj === undefined || o.rj < .08) o.rj = 0;
      return;
    }
    if (o.jRxAt === undefined || rawJ < prev - .45) { o.rj = rawJ; o.jVel = 0; }
    else {
      const dtNet = Math.max(.016, now - o.jRxAt);
      o.jVel = clamp((rawJ - prev) / dtNet, -8, 8);
    }
    o.j = rawJ; o.jRxAt = now;
  }
  function stepJ(o, dt) {
    if (o.rj === undefined) o.rj = o.j || 0;
    if (o.j <= 0 && o.rj <= .015) { o.rj = 0; return; }
    // Predict forward between snapshots, then softly reconcile toward the authoritative progress.
    o.rj += (o.jVel || 0) * dt;
    const correction = o.j - o.rj;
    o.rj += correction * Math.min(1, dt * 18);
    o.rj = clamp(o.rj, 0, 1);
    if (o.j <= 0 && o.rj < .035) o.rj = 0;
  }
  function targetVT() {
    if (MODE === 'battlegrid') { const e = S.ents.get(S.view.id || S.id); const base = G.fov[e ? e.k : 'p'] || 8; const pk = S.me.pk || 0; return base + G.fovCap * pk / (pk + G.fovK); }
    if (MODE === 'pieces') return G.fov;
    const pk = S.me.pk || 0; return G.fovBase + G.fovCap * pk / (pk + G.fovK);
  }
  function update(dt) {
    for (const o of S.ents.values()) stepEnt(o, dt, 26);
    for (const o of S.units.values()) stepEnt(o, dt, 22);
    if(MODE==='kings'){S.aimX=S.cam.x+(S.mouse.x-W/2)/S.cam.s;S.aimY=S.cam.y+(S.mouse.y-H/2)/S.cam.s;}
    const me = S.ents.get(S.id), c = S.cam;
    if (S.introZoom) {
      const q = clamp((S.t - S.introZoom.t0) / S.introZoom.dur, 0, 1), e = 1 - Math.pow(1 - q, 3); // easeOutCubic
      c.vt = S.introZoom.vt0 + (targetVT() - S.introZoom.vt0) * e;
      if (q >= 1) S.introZoom = null;
    } else c.vt += (targetVT() - c.vt) * (1 - Math.exp(-dt * 3));
    c.s = H / c.vt;
    if (me && !S.dead) { c.x = me.rx; c.y = me.ry; }
    else { const k = 1 - Math.exp(-dt * (S.dead && S.t - S.deadAt < 2 ? 30 : 3.2)); c.x += (S.view.x - c.x) * k; c.y += (S.view.y - c.y) * k; }
    // Apply smooth shake effect using sine wave
    if (S.shake > 0) {
      S.shake -= dt * 8;
      if (S.shake > 0) {
        const shakeIntensity = Math.min(S.shake, 1) * 2;
        const shakePhase = S.t * 25;
        c.x += Math.sin(shakePhase) * shakeIntensity * 0.5;
        c.y += Math.cos(shakePhase * 1.3) * shakeIntensity * 0.5;
      } else {
        S.shake = 0;
      }
    }
    inputStep();
    for (let i = S.fx.length - 1; i >= 0; i--) if (S.t - S.fx[i].t0 > 1) S.fx.splice(i, 1);
  }

  /* ---------- drawing ---------- */
  let terrainPat = null;
  function makeTerrain() {
    const c = document.createElement('canvas'); c.width = c.height = 256; const x = c.getContext('2d');
    for (let i = 0; i < 46; i++) { x.fillStyle = Math.random() < .5 ? 'rgba(255,255,255,.07)' : 'rgba(0,0,0,.06)'; const px = Math.random() * 256, py = Math.random() * 256, r = 14 + Math.random() * 40;
      for (const ox of [-256, 0, 256]) for (const oy of [-256, 0, 256]) { x.beginPath(); x.arc(px + ox, py + oy, r, 0, 6.3); x.fill(); } }
    terrainPat = ctx.createPattern(c, 'repeat');
  }
  function drawBoard() {
    const c = S.cam, s = c.s;
    if (MODE === 'kings') {
      ctx.fillStyle = col(tc.d); ctx.fillRect(0, 0, W, H);
      if (!terrainPat) makeTerrain();
      const k = s * 20 / 256, tx = W / 2 - c.x * s, ty = H / 2 - c.y * s;
      ctx.save(); ctx.translate(tx, ty); ctx.scale(k, k); ctx.fillStyle = terrainPat; ctx.fillRect(-tx / k, -ty / k, W / k, H / k); ctx.restore();
    } else {
      ctx.fillStyle = col(tc.l); ctx.fillRect(0, 0, W, H); ctx.fillStyle = col(tc.d);
      const x0 = Math.floor(c.x - W / 2 / s), x1 = Math.ceil(c.x + W / 2 / s), y0 = Math.floor(c.y - H / 2 / s), y1 = Math.ceil(c.y + H / 2 / s);
      for (let j = y0; j < y1; j++) for (let i = x0; i < x1; i++) if (((i + j) & 1) === 1) { const px = Math.round(w2sx(i)), py = Math.round(w2sy(j)); ctx.fillRect(px, py, Math.round(w2sx(i + 1)) - px, Math.round(w2sy(j + 1)) - py); }
      if (MODE === 'battlegrid' && S.terr && S.terr.length) {
        for (let i = 0; i < S.terr.length; i += 3) {
          const gx = S.terr[i], gy = S.terr[i + 1], side = S.terr[i + 2] === 1 ? 'w' : 'b';
          const px = Math.round(w2sx(gx)), py = Math.round(w2sy(gy)), pw = Math.round(w2sx(gx + 1)) - px, ph = Math.round(w2sy(gy + 1)) - py;
          ctx.fillStyle = side === S.side ? 'rgba(70,160,255,.28)' : 'rgba(255,80,70,.28)';
          ctx.fillRect(px, py, pw, ph);
        }
      }
    }
    // playable-world boundary: ~50% black over everything outside the world (board keeps rendering beyond it)
    const bx0 = w2sx(0), by0 = w2sy(0), bx1 = w2sx(WORLD), by1 = w2sy(WORLD);
    ctx.fillStyle = 'rgba(0,0,0,.5)'; ctx.beginPath(); ctx.rect(0, 0, W, H); ctx.rect(bx0, by0, bx1 - bx0, by1 - by0); ctx.fill('evenodd');
    ctx.strokeStyle = 'rgba(0,0,0,.55)'; ctx.lineWidth = 2; ctx.strokeRect(bx0, by0, bx1 - bx0, by1 - by0);
  }
  function drawOrbs() {
    const s = S.cam.s, o = S.orbs;
    if (!o || !o.length) return;
    for (let i = 0; i < o.length; i += 3) {
      const x = w2sx(o[i + 1]), y = w2sy(o[i + 2]); if (x < -30 || y < -30 || x > W + 30 || y > H + 30) continue;
      const r = s * (.26 + Math.sin(S.t * 3 + o[i]) * .02);
      // Fade in exactly once, right when the orb actually spawned (tracked in S.orbSeen) - not on a repeating timer.
      const spawnedAt = S.orbSeen.has(o[i]) ? S.orbSeen.get(o[i]) : S.t;
      const age = S.t - spawnedAt;
      const alpha = age < 0.5 ? clamp(age / 0.5, 0, 1) : 1;
      ctx.save(); ctx.globalAlpha = alpha;
      ctx.fillStyle = 'rgba(0,0,0,.18)'; ctx.beginPath(); ctx.ellipse(x, y + r * .8, r * .9, r * .35, 0, 0, 6.3); ctx.fill();
      ctx.fillStyle = '#f5c400'; ctx.strokeStyle = '#a87c00'; ctx.lineWidth = Math.max(1.5, s * .05); ctx.beginPath(); ctx.arc(x, y, r, 0, 6.3); ctx.fill(); ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,.55)'; ctx.beginPath(); ctx.arc(x - r * .3, y - r * .3, r * .32, 0, 6.3); ctx.fill();
      ctx.restore();
    }
  }
  function sprite(type, color, x, y, size, o) {
    o = o || {}; const img = IMG[color + type];
    ctx.save(); ctx.globalAlpha = o.alpha == null ? 1 : o.alpha; ctx.translate(x, y + size * .38 - (o.lift || 0)); if (o.rot) ctx.rotate(o.rot); ctx.scale(o.sx || 1, o.sy || 1);
    if (img) ctx.drawImage(img, -size / 2, -size * .88, size, size);
    else { if (!warned[color + type]) { warned[color + type] = 1; console.warn('missing piece image', color + type); } ctx.font = size * .9 + 'px serif'; ctx.textAlign = 'center'; ctx.fillStyle = color === 'w' ? '#fff' : '#111'; ctx.strokeStyle = '#000'; ctx.lineWidth = 2; ctx.strokeText(GL[color + type], 0, -size * .1); ctx.fillText(GL[color + type], 0, -size * .1); }
    ctx.restore();
  }
  function shadow(x, y, size, lift, a) {
    const k = 1 - Math.min(.6, (lift || 0) / size); ctx.fillStyle = 'rgba(0,0,0,' + (.32 * (a == null ? 1 : a) * k) + ')'; ctx.beginPath(); ctx.ellipse(x, y + size * .42, size * .35 * k, size * .14 * k, 0, 0, 6.3); ctx.fill();
  }
  function bar(cx, y, w, hp, mx, sh, msh, alpha, scale = 1, sizeOffset = 0, fadeTime = 0) {
    const h = Math.max(5 * scale, Math.min(9 * scale, S.cam.s * .14 * scale)), x = cx - w / 2; ctx.save(); ctx.globalAlpha = alpha;
    // Only show bar if player has been damaged (fadeTime is set)
    if (!fadeTime) { ctx.restore(); return; }
    // Fade out when not damaged for 20 seconds
    let barAlpha = 1;
    const age = S.t - fadeTime;
    if (age > 20) barAlpha = 0;
    else if (age > 19) barAlpha = 1 - (age - 19);
    ctx.globalAlpha = alpha * barAlpha;
    // Lower the bars so they don't cover the player
    const yOffset = y + sizeOffset;
    if (msh > 0) { ctx.fillStyle = 'rgba(0,0,0,.25)'; ctx.fillRect(x, yOffset - h * .8, w, h * .55); ctx.fillStyle = '#6fc3ff'; ctx.fillRect(x, yOffset - h * .8, w * clamp(sh / msh, 0, 1), h * .55); ctx.strokeStyle = '#123'; ctx.lineWidth = 1.5; ctx.strokeRect(x, yOffset - h * .8, w, h * .55); }
    const f = clamp(hp / mx, 0, 1); ctx.fillStyle = 'rgba(0,0,0,.3)'; ctx.fillRect(x, yOffset, w, h);
    ctx.fillStyle = f > .55 ? '#5fd35f' : f > .28 ? '#f0c33c' : '#e2493f'; ctx.fillRect(x, yOffset, w * f, h);
    ctx.strokeStyle = '#111'; ctx.lineWidth = 2; ctx.strokeRect(x, yOffset, w, h);   // outline stays visible at 0 HP
    ctx.restore();
  }
  function label(txt, x, y, px) { ctx.font = '700 ' + px + 'px "Segoe UI",Roboto,sans-serif'; ctx.textAlign = 'center'; ctx.lineWidth = 4; ctx.strokeStyle = 'rgba(0,0,0,.65)'; ctx.lineJoin = 'round'; ctx.strokeText(txt, x, y); ctx.fillStyle = '#fff'; ctx.fillText(txt, x, y); }
  // moving right tilts right, forward tilts forward (foreshortens), backward tilts back; squash/stretch + bob from speed
  function motion(o, size) {
    if (MODE === 'kings') {
      // King hopping removed: every unit (King + army) now shares one smooth, clock-driven up/down
      // bounce every 0.3s, independent of movement - a synchronized "alive" pulse, not a walk-cycle.
      const cyc = .3, ph = (S.t % cyc) / cyc, hop = Math.pow(Math.sin(ph * Math.PI), .8);
      const land = ph > .82 ? Math.sin(((ph - .82) / .18) * Math.PI) : 0;            // brief soft-landing squash
      let sx = 1 + hop * .05 - land * .05, sy = 1 - hop * .04 + land * .07;
      if (o.flash && S.t - o.flash < .18) { const q = 1 - (S.t - o.flash) / .18; sx += q * .12; sy -= q * .1; }
      return { rot: 0, sx, sy, lift: hop * size * .075 };
    }
    const sp = Math.hypot(o.vx, o.vy), ns = clamp(sp / 6, 0, 1);
    const pieceTilt = MODE === 'battlegrid' ? (o.tilt || 0) : 0;
    const rot = clamp(o.vx / 6, -1, 1) * .2 + pieceTilt;
    const lean = clamp(o.vy / 6, -1, 1);
    const bobHz = 11, bobAmt = .05;
    const bob = (0.5 + 0.5 * Math.sin(S.t * bobHz + o.id * .73)) * ns * size * bobAmt;
    let sx = 1 + ns * .03 - Math.abs(lean) * .02, sy = 1 - ns * .03 + lean * .06;
    if (o.flash && S.t - o.flash < .18) { const q = 1 - (S.t - o.flash) / .18; sx += q * .12; sy -= q * .1; }
    return { rot, sx, sy, lift: bob };
  }
  function drawPlayer(o) {
    const s = S.cam.s, uiScale = MODE === 'kings' ? 2 : 1, size = s * (MODE === 'battlegrid' ? 0.85 : 0.82) * uiScale, x = w2sx(o.rx), y = w2sy(o.ry);
    if (x < -size || y < -size || x > W + size || y > H + size) return;
    const color = colorOf(o.id); let alpha = 1;
    if (o.pr) alpha = (Math.floor(S.t * 7) % 2) ? .18 : 1;                                   // spawn protection flashes
    let rsK = 0; if (o.rs && o.rsAt) { rsK = clamp((S.t - o.rsAt - 1.0) / 1.5, 0, 1); alpha *= 1 - rsK; }
    const j = MODE === 'battlegrid' ? 0 : (o.rj || 0), m = motion(o, size), arc = j ? Math.pow(Math.sin(j * Math.PI), .92) : 0, land = o.hk && j > .84 ? Math.sin(((j - .84) / .16) * Math.PI) : 0;
    let lift = m.lift + arc * s * (o.hk ? .46 : 1.1), sc = 1 + arc * (o.hk ? .05 : .18);
    if (o.hk) { m.sy *= 1 + arc * .16 - land * .13; m.sx *= 1 - arc * .10 + land * .10; }   // smooth lift + soft landing squash
    shadow(x, y, size, lift, alpha);
    let sx = x, sy = y, fallRot = 0, fallLift = 0;
    if (o.fall > 0 && o.fall < 1) { const fq = ease(o.fall), wob = Math.sin(fq * Math.PI * 2) * .08 * (1 - fq); fallRot = (o.fallDx || 1) * 1.05 * fq + wob; sx += (o.fallDx || 0) * size * .08 * fq; sy += (o.fallDy || 0) * size * .05 * fq; fallLift = Math.sin(fq * Math.PI) * size * .08; }
    if (o.flash && S.t - o.flash < .15) sx += Math.sin(S.t * 90) * 3;
    sprite(o.k, color, sx, sy, size * sc, { alpha, rot: m.rot + fallRot, sx: m.sx * (1 - .1 * (o.fall || 0)), sy: m.sy * (1 + .14 * (o.fall || 0)), lift: lift + fallLift });
    const hx = x + size * .28, hy = y - size * .40 - lift;
    if (o.rs) { const rk = 'resign_' + (color === 'w' ? 'white' : 'black'), im = tagImg(rk), rz = size * .62, ry = y - size * .40 - lift - rz * .05;
      ctx.save(); ctx.globalAlpha = alpha; if (im) ctx.drawImage(im, x - rz / 2, ry - rz / 2, rz, rz); else { ctx.translate(x, ry); emojiTag(rk, rz); } ctx.restore(); }
    const nameSz = Math.max(11, s * .27 * uiScale), nameY = y - size * .62 - lift - 8;
    label(o.name || '', x, nameY, nameSz);
    if (S.topKiller && o.id === S.topKiller) {                     // most-kills crown: pawn icon crossed by a red line
      ctx.font = '700 ' + nameSz + 'px "Segoe UI",Roboto,sans-serif';
      const tw = ctx.measureText(o.name || '').width, cz = nameSz * .9, cx = x - tw / 2 - cz * .62;
      ctx.save(); ctx.translate(cx, nameY - nameSz * .05);
      sprite('p', color, 0, 0, cz, { alpha: 1 });
      ctx.strokeStyle = '#ff3b30'; ctx.lineWidth = Math.max(2, cz * .16); ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(-cz * .38, -cz * .38); ctx.lineTo(cz * .38, cz * .38); ctx.stroke();
      ctx.restore();
    }
    bar(x, y + size * .52, size * .8, o.h, 100, o.s, P[o.k].shield, alpha, uiScale, size * 0.35, o.dmgAt || 0);
    if (o.sl) {                                                    // small "currently holding" piece beside the King
      const hz = size * .5, bx = x + size * .42, by = y - size * .18 - lift + Math.sin(S.t * 3.4 + o.id) * 2;
      ctx.save(); ctx.globalAlpha = alpha * .9; ctx.fillStyle = 'rgba(0,0,0,.3)'; ctx.beginPath(); ctx.arc(bx, by, hz * .5, 0, 6.3); ctx.fill(); ctx.restore();
      sprite(o.sl, color, bx, by - hz * .28, hz, { alpha });
    }
    o._hx = hx; o._hy = hy;
  }
  function drawBadgesAll() {
    const badgeScale = MODE === 'kings' ? 2 : 1, size = S.cam.s * 1.2, base = clamp(S.cam.s * .55 * badgeScale, 26 * badgeScale, 58 * badgeScale);
    for (const o of S.ents.values()) if (o._hx !== undefined) drawBadges(o.id, o._hx, o._hy, base);
  }
  function drawChatBubbles() {
    const s = S.cam.s;
    for (const [name, bubbles] of S.bubbles) {
      const player = [...S.ents.values()].find(e => e.name === name);
      if (!player) continue;
      const x = w2sx(player.rx), y = w2sy(player.ry);
      const size = s * (MODE === 'kings' ? 1.7 : 0.85);
      const headY = y - size * .85; // Higher above head
      
      for (let i = bubbles.length - 1; i >= 0; i--) {
        const b = bubbles[i];
        const age = S.t - b.t0;
        if (age > 4) { bubbles.splice(i, 1); continue; }
        
        const fade = age > 3 ? 1 - (age - 3) : 1;
        ctx.font = 'bold ' + (MODE === 'kings' ? 30 : 15) + 'px "Segoe UI", sans-serif';
        const bubbleW = Math.min(180, ctx.measureText(b.text).width + 28);
        const bubbleH = MODE === 'kings' ? 64 : 32;
        const bubbleX = x - bubbleW / 2;
        const bubbleY = headY - bubbleH - 10 - (bubbles.length - 1 - i) * (bubbleH + 5);
        
        ctx.save();
        ctx.globalAlpha = fade;
        ctx.fillStyle = 'rgba(0, 0, 0, 0.75)';
        ctx.beginPath();
        ctx.roundRect(bubbleX, bubbleY, bubbleW, bubbleH, 10);
        ctx.fill();
        
        ctx.fillStyle = '#fff';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(b.text, x, bubbleY + bubbleH / 2);
        ctx.restore();
      }
    }
    // Position chat input below the player when open
    if (S.chatOpen) {
      const me = S.ents.get(S.id);
      if (me) {
        const x = w2sx(me.rx), y = w2sy(me.ry);
        const size = s * 0.85;
        const inputBox = $('chatin');
        if (inputBox) {
          const iw = MODE === 'kings' ? 360 : 300;
          inputBox.style.left = (x - iw / 2) + 'px';
          inputBox.style.top = (y + size * 0.6) + 'px';
          inputBox.style.width = (MODE === 'kings' ? 360 : 300) + 'px';
        }
      }
    }
  }
  function drawPieceUnit(o) { // pieces-with-pieces placed/flying pieces and kings army
    const s = S.cam.s, isK = MODE === 'kings', pieceScale = isK ? ({p:.72,n:.84,b:.94,r:1.08,q:1.30}[o.k] || .84) : 1, size = s * (isK ? 0.75 : (MODE === 'pieces' ? 0.82 : 0.75)) * pieceScale, x = w2sx(o.rx), y = w2sy(o.ry);
    if (x < -size || y < -size || x > W + size || y > H + size) return;
    const color = colorOf(o.ow); let alpha = 1, rot = 0, sc = 1, sx = x;
    if (o.fl & 1 && o.rsAt) alpha = 1 - clamp((S.t - o.rsAt - 1.0) / 1.5, 0, 1);
    if (o.fl & 2 && o.dsAt) { const q = clamp((S.t - o.dsAt) / .38, 0, 1); sx += Math.sin(S.t * 70) * 3 * (1 - q); rot = Math.sin(S.t * 40) * .25 * (1 - q); sc = 1 - Math.pow(q, 2) * .9; alpha *= 1 - Math.pow(q, 1.6); }
    const m = motion(o, size); const j = o.rj || 0;
    const jumpArc = j ? Math.pow(Math.sin(j * Math.PI), .92) : 0;
    const landing = j > .84 ? Math.sin(((j - .84) / .16) * Math.PI) : 0;
    const air = jumpArc * s * (o.hk ? .46 : 1.12);
    if (o.hk) { m.sy *= 1 + jumpArc * .14 - landing * .12; m.sx *= 1 - jumpArc * .08 + landing * .10; }
    shadow(x, y, size, air, alpha);
    if(isK&&(o.fl&16)&&o.tr){const tg=S.ents.get(o.tr);if(tg){ctx.save();ctx.strokeStyle='rgba(255,220,120,.42)';ctx.lineWidth=Math.max(1.5,s*.035);ctx.setLineDash([s*.16,s*.12]);ctx.beginPath();ctx.moveTo(x,y);ctx.lineTo(w2sx(tg.rx),w2sy(tg.ry));ctx.stroke();ctx.setLineDash([]);ctx.restore();}ctx.save();ctx.strokeStyle='rgba(255,220,120,.72)';ctx.lineWidth=Math.max(2,s*.05);ctx.beginPath();ctx.arc(x,y,size*.52,0,6.3);ctx.stroke();ctx.restore();}
    let evoShake = 0, evoRot = 0;
    if (isK && o.evo >= .5 && o.evo < 1) { const ep = clamp((o.evo - .5) / .5, 0, 1), inten = .7 * ep; evoShake = Math.sin(S.t * 45 + o.id) * size * .045 * inten; evoRot = Math.sin(S.t * 62 + o.id * .7) * .16 * inten; }
    sprite(o.k, color, sx + evoShake, y, size * sc, { alpha, rot: rot + m.rot + evoRot, sx: m.sx, sy: m.sy, lift: air + m.lift });
    if (isK && o.evo >= .5 && o.evo < 1) { const ep = clamp((o.evo - .5) / .5, 0, 1), glow = .15 + ep * .35; ctx.save(); ctx.globalAlpha = glow; ctx.strokeStyle = '#f3d67a'; ctx.lineWidth = Math.max(2, size * .05); ctx.beginPath(); ctx.arc(x, y - air, size * (.62 + ep * .08), 0, 6.3); ctx.stroke(); ctx.restore(); }
    if (isK && P[o.k] && o.h < P[o.k].hp) bar(x, y + size * .5, size * .7, o.h, 100, o.s, P[o.k].shield, alpha);
  }
  const bldRadius = k => k==='H'?CFG.g.houseR:k==='G'?(MODE==='kings'?G.generator.radius:CFG.g.genR):CFG.g.tower.r;
  const bldMaxHp = k => k==='H'?CFG.g.houseHp:k==='G'?CFG.g.genHp:CFG.g.tower.hp;
  function puddleShape(ctx2, r, seed, scaleX, scaleY) {
    const pts = 14, start = (seed * 0.73) % (Math.PI * 2);
    ctx2.beginPath();
    for (let i = 0; i <= pts; i++) {
      const a = start + (i % pts) * Math.PI * 2 / pts;
      const wob = 1 + Math.sin(seed * 1.71 + i * 1.93) * .085 + Math.sin(seed * 2.37 + i * .71) * .045;
      const rr = r * wob;
      const px = Math.cos(a) * rr * scaleX, py = Math.sin(a) * rr * scaleY;
      if (!i) ctx2.moveTo(px, py); else ctx2.lineTo(px, py);
    }
    ctx2.closePath();
  }
  function drawShrine() {
    if (MODE !== 'kings' || !S.shrine) return;
    const [sx, sy, r, owner, ctrl, healR] = S.shrine, s = S.cam.s, x = w2sx(sx), y = w2sy(sy), rad = r * s, hr = (healR || G.shine?.healR || r + 2) * s;
    if (x < -rad * 2 || y < -rad * 2 || x > W + rad * 2 || y > H + rad * 2) return;
    const color = owner ? (owner === S.id ? S.side : opp(S.side)) : null;
    ctx.save();
    ctx.fillStyle = color ? (color === 'w' ? 'rgba(255,255,255,.14)' : 'rgba(0,0,0,.20)') : 'rgba(200,180,255,.10)';
    ctx.beginPath(); ctx.arc(x, y, rad, 0, 6.3); ctx.fill();
    ctx.strokeStyle = color ? (color === S.side ? 'rgba(70,160,255,.85)' : 'rgba(255,80,70,.85)') : 'rgba(200,180,255,.6)';
    ctx.lineWidth = Math.max(2, rad * .05); ctx.setLineDash([rad * .18, rad * .12]);
    ctx.beginPath(); ctx.arc(x, y, rad, 0, 6.3); ctx.stroke(); ctx.setLineDash([]);
    if (owner) { // capture progress ring + smaller claimed healing/evolution ring
      ctx.strokeStyle = color === S.side ? '#4aa0ff' : '#ff5046'; ctx.lineWidth = Math.max(3, rad * .08);
      ctx.beginPath(); ctx.arc(x, y, rad * .82, -Math.PI / 2, -Math.PI / 2 + (ctrl / 100) * 6.283); ctx.stroke();
      ctx.strokeStyle = color === S.side ? 'rgba(70,160,255,.55)' : 'rgba(255,80,70,.55)';
      ctx.lineWidth = Math.max(2, hr * .035); ctx.setLineDash([hr * .08, hr * .08]); ctx.beginPath(); ctx.arc(x, y, hr, 0, 6.3); ctx.stroke(); ctx.setLineDash([]);
    }
    sprite('k', color || 'w', x, y, rad * 1.15, { alpha: color ? 1 : .55 });
    ctx.restore();
  }
  function drawPuddles(){
    if(MODE!=='kings')return;
    const s=S.cam.s;
    for(const q of S.puddles){
      if(!Array.isArray(q) || q.length < 4) continue;
      const qid=Number(q[0]), qx=Number(q[1]), qy=Number(q[2]), qr=Number(q[3]);
      if(!Number.isFinite(qid)||!Number.isFinite(qx)||!Number.isFinite(qy)||!Number.isFinite(qr)||qr<=0) continue;
      const x=w2sx(qx), y=w2sy(qy), r=qr*s;
      if(x<-r*2||y<-r*2||x>W+r*2||y>H+r*2)continue;
      const seed=qid;
      ctx.save();
      ctx.translate(x,y);
      const rot=Math.sin(seed*1.7)*.035; ctx.rotate(rot);
      // soft ground depression / shoreline
      ctx.fillStyle='rgba(35,50,25,.22)';
      puddleShape(ctx, r*1.08, seed, 1.12, .90);
      ctx.fill();
      ctx.fillStyle='rgba(20,50,65,.16)'; puddleShape(ctx,r*1.035,seed,1.05,.84); ctx.fill();
      // shallow shore
      ctx.fillStyle='#b9aa72'; puddleShape(ctx,r*1.015,seed,1.02,.82); ctx.fill();
      // water body: cool natural blue, not purple UI-looking circles
      ctx.fillStyle='#4c8b9d'; puddleShape(ctx,r*.96,seed,1.02,.80); ctx.fill();
      ctx.strokeStyle='rgba(30,70,78,.62)'; ctx.lineWidth=Math.max(2,s*.045); puddleShape(ctx,r*.96,seed,1.02,.80); ctx.stroke();
      // subtle depth gradient made from layered organic shapes
      ctx.fillStyle='rgba(25,67,88,.20)'; puddleShape(ctx,r*.72,seed+7,1.0,.78); ctx.fill();
      ctx.fillStyle='rgba(190,225,218,.18)'; puddleShape(ctx,r*.40,seed+13,.95,.65); ctx.fill();
      // restrained water glints
      const t=S.t*1.2+seed;
      ctx.save(); ctx.globalAlpha=.55; ctx.strokeStyle='rgba(225,246,240,.38)'; ctx.lineWidth=Math.max(1.2,s*.025);
      for(let i=0;i<2;i++){const ax=Math.cos(t+i*2.8)*r*.28, ay=Math.sin(t*1.1+i*1.9)*r*.20; ctx.beginPath(); ctx.moveTo(ax-r*.18,ay); ctx.quadraticCurveTo(ax,ay-r*.035,ax+r*.18,ay); ctx.stroke();}
      ctx.restore();
      ctx.restore();
    }
  }
  function drawGridGenerator(o){if(MODE!=='kings')return;const s=S.cam.s,x=w2sx(o.rx),y=w2sy(o.ry),r=G.generator.radius*s,lvl=clamp(o.lvl||0,0,4),color=colorOf(o.ow),pal=[['#efe7f7','#d7c4eb','#6d4a8a'],['#e8d6ff','#b890df','#6e43a1'],['#dcc6ff','#9a6bd1','#61319b'],['#cfb0ff','#7e47c4','#54208b'],['#c49aff','#6b2fc2','#461079']][lvl];ctx.save();if(S.selectedBld===o.id){ctx.fillStyle='rgba(185,125,255,.48)';ctx.beginPath();ctx.arc(x,y,r*1.35,0,6.3);ctx.fill();}const a=r*1.9,x0=x-a/2,y0=y-a/2,c=a/4;ctx.fillStyle=pal[0];ctx.strokeStyle=pal[2];ctx.lineWidth=Math.max(2,r*.08);ctx.beginPath();ctx.roundRect(x0,y0,a,a,r*.14);ctx.fill();ctx.stroke();for(let i=0;i<4;i++)for(let j=0;j<4;j++){ctx.fillStyle=(i+j)&1?pal[1]:pal[0];ctx.fillRect(x0+i*c+.5,y0+j*c+.5,c-1,c-1);}ctx.strokeStyle='rgba(50,20,70,.45)';ctx.lineWidth=Math.max(1,r*.035);for(let i=1;i<4;i++){ctx.beginPath();ctx.moveTo(x0+i*c,y0);ctx.lineTo(x0+i*c,y0+a);ctx.stroke();ctx.beginPath();ctx.moveTo(x0,y0+i*c);ctx.lineTo(x0+a,y0+i*c);ctx.stroke();}const ph=o.ga||0;const pieceType=['p','n','b','r','q'][lvl]||'p';let rot=0,px=x-r*.58,py=y+r*.48,sx=1,sy=1;if(ph<.28){const t=ph/.28;rot=-.24*t*t;px+=r*.16*t;}else if(ph<.62){const t=(ph-.28)/.34,e=t*t*(3-2*t);rot=-.24+.44*e;px-=r*.1*e;}else if(ph<.76){const t=(ph-.62)/.14,e=1-(1-t)*(1-t);rot=.2*(1-e);px-=r*.13*e;sx=1+.08*e;sy=1-.1*e;}else{const t=(ph-.76)/.24,e=1-Math.pow(1-t,3);rot=-.01+.05*(1-e);sx=1.08-.08*e;sy=.9+.1*e;}ctx.fillStyle='rgba(0,0,0,.22)';ctx.beginPath();ctx.ellipse(x-r*.3,y+r*.65,r*.46,r*.14,0,0,6.3);ctx.fill();sprite(pieceType,color,px,py,r*1.45,{rot,sx,sy});if(ph>=.58&&ph<.78){const iq=(ph-.58)/.20;ctx.strokeStyle='rgba(215,165,255,'+(1-iq)*.75+')';ctx.lineWidth=Math.max(1.5,r*.05);ctx.beginPath();ctx.arc(x-r*.8,y,r*(.55+iq*.25),0,6.3);ctx.stroke();}ctx.restore();}
  function drawBuilding(o){if(MODE==='kings'&&o.k==='G'){drawGridGenerator(o);return;}
    const s = S.cam.s, x = w2sx(o.rx), y = w2sy(o.ry), r = bldRadius(o.k) * s, color = colorOf(o.ow); let alpha = 1;
    if (x < -r * 2 || y < -r * 2 || x > W + r * 2 || y > H + r * 2) return;
    if (o.fl & 1 && o.rsAt) alpha = 1 - clamp((S.t - o.rsAt - 1.0) / 1.5, 0, 1);
    if (o.fl & 2 && o.dsAt) alpha *= 1 - clamp((S.t - o.dsAt) / .38, 0, 1);
    // Enhanced hover effect for all buildings
    if (S.selectedBld === o.id) { 
      ctx.save(); 
      const hoverPhase = S.t * 8;
      const hoverIntensity = .35 + Math.sin(hoverPhase) * .12;
      ctx.globalAlpha = alpha * hoverIntensity; 
      ctx.fillStyle = '#fff'; 
      ctx.beginPath(); 
      ctx.arc(x, y, r * 1.25, 0, 6.3); 
      ctx.fill(); 
      ctx.restore(); 
    }
    ctx.save(); ctx.globalAlpha = alpha; drawBldShape(o.k, x, y, r, color, false, o.lvl); ctx.restore();
    const mx = bldMaxHp(o.k); if (o.h < mx) bar(x, y + r + 6, r * 1.4, o.h, mx, 0, 0, alpha);
  }
  // Tier trim colour per upgrade level: plain -> bronze -> silver -> gold -> gem. Same shape, different finish -
  // that's the "different texture per upgrade" without needing any new art assets.
  const TIER = [{ trim: null, gem: '#7a7a7a' }, { trim: '#a9764f', gem: '#a9764f' }, { trim: '#c7c7c7', gem: '#c7c7c7' },
    { trim: '#f2c94c', gem: '#f2c94c' }, { trim: '#6ee7f0', gem: '#3ad0e0' }];
  const tierOf = lvl => TIER[lvl >= 10 ? 4 : lvl >= 7 ? 3 : lvl >= 4 ? 2 : lvl >= 1 ? 1 : 0];
  function drawBldShape(k, x, y, r, color, ghost, lvl) {
    const fg = color === 'w' ? '#f4f4f4' : '#262626', ol = color === 'w' ? '#333' : '#e8e8e8', tier = tierOf(lvl || 0);
    ctx.lineWidth = Math.max(2, r * .07);
    if (k === 'H') { // chess-board house: checkered floor with a rook-tower keep; trim colour reflects upgrade level
      const a = r * 1.9, x0 = x - a / 2, y0 = y - a / 2, c = a / 4;
      ctx.save(); ctx.beginPath(); ctx.roundRect(x0, y0, a, a, r * .18); ctx.clip();
      for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) { ctx.fillStyle = (i + j) & 1 ? col(tc.d) : col(tc.l); ctx.fillRect(x0 + i * c, y0 + j * c, c + .5, c + .5); }
      ctx.restore(); ctx.strokeStyle = tier.trim || ol; ctx.lineWidth = tier.trim ? Math.max(2.5, r * .09) : ctx.lineWidth; ctx.beginPath(); ctx.roundRect(x0, y0, a, a, r * .18); ctx.stroke();
      const tw = r * .8, th = r * .95, tx = x - tw / 2, ty = y - th * .62;
      ctx.fillStyle = fg; ctx.strokeStyle = tier.trim || ol; ctx.fillRect(tx, ty, tw, th); ctx.strokeRect(tx, ty, tw, th);
      const m = tw / 5; for (let i = 0; i < 3; i++) { ctx.fillRect(tx + i * 2 * m, ty - m * 1.1, m, m * 1.1); ctx.strokeRect(tx + i * 2 * m, ty - m * 1.1, m, m * 1.1); }
      ctx.fillStyle = tier.trim || ol; ctx.fillRect(x - m * .6, y + th * .05, m * 1.2, th * .33);
      if (lvl >= 1) { ctx.fillStyle = tier.gem; ctx.beginPath(); ctx.arc(x, ty - m * 1.6, Math.max(1.5, r * .1), 0, 6.3); ctx.fill(); ctx.strokeStyle = ol; ctx.lineWidth = 1; ctx.stroke(); }
      if (lvl) { ctx.font = '700 ' + Math.max(9, r * .38) + 'px "Segoe UI",sans-serif'; ctx.textAlign = 'center'; ctx.fillStyle = tier.gem; ctx.strokeStyle = 'rgba(0,0,0,.7)'; ctx.lineWidth = 2.5; ctx.strokeText(lvl, x, y + a / 2 + r * .32); ctx.fillText(lvl, x, y + a / 2 + r * .32); }
    } else if (k === 'W') { // tower: a 4x4 chess-grid keep with clear foreground platform depth
      ctx.fillStyle='rgba(0,0,0,.18)'; ctx.beginPath(); ctx.ellipse(x, y+r*.62, r*1.02, r*.25, 0, 0, 6.3); ctx.fill();
      const a = r * 1.9, x0 = x - a / 2, y0 = y - a / 2, g = (G.tower && G.tower.grid) || 4, c = a / g;
      ctx.save(); ctx.beginPath(); ctx.roundRect(x0, y0, a, a, r * .1); ctx.clip();
      for (let i = 0; i < g; i++) for (let j = 0; j < g; j++) { ctx.fillStyle = (i + j) & 1 ? col(tt.d) : col(tt.l); ctx.fillRect(x0 + i * c, y0 + j * c, c + .5, c + .5); }
      ctx.restore(); ctx.strokeStyle = ol; ctx.lineWidth = Math.max(2, r * .06); ctx.beginPath(); ctx.roundRect(x0, y0, a, a, r * .1); ctx.stroke();
      ctx.strokeStyle = fg; ctx.lineWidth = Math.max(1, r * .035);
      for (let i = 1; i < g; i++) { ctx.beginPath(); ctx.moveTo(x0 + i * c, y0); ctx.lineTo(x0 + i * c, y0 + a); ctx.stroke(); ctx.beginPath(); ctx.moveTo(x0, y0 + i * c); ctx.lineTo(x0 + a, y0 + i * c); ctx.stroke(); }
      ctx.fillStyle = fg; const m = a / (g * 2.2);
      for (let i = 0; i < g; i++) { ctx.fillRect(x0 + i * c + c / 2 - m / 2, y0 - m * .9, m, m * .9); ctx.fillRect(x0 + i * c + c / 2 - m / 2, y0 + a - m * .1, m, m * .9); }
      ctx.strokeStyle='rgba(255,255,255,.22)'; ctx.lineWidth=Math.max(1,r*.035); ctx.strokeRect(x0+c*.15,y0+c*.15,a-c*.3,a-c*.3);
    } else { // generator
      ctx.fillStyle = '#f2c94c'; ctx.strokeStyle = tier.trim || '#6b4e00'; ctx.beginPath(); for (let i = 0; i < 6; i++) { const a = i * Math.PI / 3 + Math.PI / 6; ctx.lineTo(x + Math.cos(a) * r, y + Math.sin(a) * r); } ctx.closePath(); ctx.fill(); ctx.stroke();
      ctx.fillStyle = fg; ctx.strokeStyle = tier.trim || ol; ctx.beginPath(); ctx.moveTo(x + r * .12, y - r * .6); ctx.lineTo(x - r * .38, y + r * .08); ctx.lineTo(x - r * .02, y + r * .08); ctx.lineTo(x - r * .14, y + r * .6); ctx.lineTo(x + r * .4, y - r * .1); ctx.lineTo(x + r * .04, y - r * .1); ctx.closePath(); ctx.fill(); ctx.stroke();
      if (lvl) { ctx.font = '700 ' + Math.max(9, r * .34) + 'px "Segoe UI",sans-serif'; ctx.textAlign = 'center'; ctx.fillStyle = tier.gem; ctx.strokeStyle = 'rgba(0,0,0,.7)'; ctx.lineWidth = 2.5; ctx.strokeText(lvl, x, y + r + r * .38); ctx.fillText(lvl, x, y + r + r * .38); }
    }
  }
  function drawFx() {
    for (const f of S.fx) {
      const a = S.t - f.t0;
      if (f.k === 'dash' || f.k === 'line' || f.k === 'hit') {
        const life = f.k === 'dash' ? .32 : .22; if (a > life) continue; const q = 1 - a / life;
        ctx.strokeStyle = 'rgba(255,255,255,' + (.55 * q) + ')'; ctx.lineWidth = S.cam.s * (f.k === 'line' ? (f.ty === 'r' ? .32 : .2) : .18) * q + 1; ctx.lineCap = 'round';
        ctx.beginPath(); ctx.moveTo(w2sx(f.x1), w2sy(f.y1)); ctx.lineTo(w2sx(f.x2), w2sy(f.y2)); ctx.stroke();
      } else if (f.k === 'stomp' || f.k === 'pop') {
        if (a > .4) continue; const q = a / .4; ctx.strokeStyle = 'rgba(255,255,255,' + (.6 * (1 - q)) + ')'; ctx.lineWidth = 3;
        ctx.beginPath(); ctx.arc(w2sx(f.x1), w2sy(f.y1), S.cam.s * (.3 + q * (f.k === 'stomp' ? 1.2 : .8)), 0, 6.3); ctx.stroke();
      } else if (f.k === 'dust') {
        if (a > .3) continue; const q = a / .3, cs = S.cam.s, hard = f.x2 ? 1.7 : 1;
        ctx.strokeStyle = 'rgba(255,255,255,' + (.32 * (1 - q) * hard) + ')'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.ellipse(w2sx(f.x1), w2sy(f.y1) + cs * .26, cs * (.16 + q * .4) * hard, cs * (.06 + q * .15) * hard, 0, 0, 6.3); ctx.stroke();
      } else if(f.k==='genhit'){if(a>.9)continue;const q=clamp(a/.9,0,1),cs=S.cam.s,x=w2sx(f.x1),y=w2sy(f.y1),rawGain=Number(f.x2),gain=Number.isFinite(rawGain)?rawGain:0,alpha=q<.18?q/.18:1-(q-.18)/.72;ctx.save();ctx.textAlign='center';ctx.font='900 '+Math.max(18,cs*.58)+'px "Segoe UI",Roboto,sans-serif';ctx.lineWidth=5;ctx.strokeStyle='rgba(40,10,60,'+(.82*Math.max(0,alpha))+')';ctx.strokeText('+'+gain+' Elo',x+cs*.35,y-cs*(.65+q*.65));ctx.fillStyle='rgba(224,188,255,'+Math.max(0,alpha)+')';ctx.fillText('+'+gain+' Elo',x+cs*.35,y-cs*(.65+q*.65));ctx.strokeStyle='rgba(190,120,255,'+(.8*(1-q))+')';ctx.lineWidth=Math.max(2,cs*.07);ctx.beginPath();ctx.arc(x,y,cs*(.25+q*1.05),0,6.3);ctx.stroke();for(let i=0;i<7;i++){const ang=i*.9+gain*.7,rr=cs*(.45+q*.8),px=x+Math.cos(ang)*rr,py=y+Math.sin(ang)*rr-cs*q*.15;ctx.fillStyle='rgba(215,165,255,'+(.8*(1-q))+')';ctx.beginPath();ctx.arc(px,py,Math.max(1.5,cs*.045),0,6.3);ctx.fill();}ctx.restore();
      } else if(f.k==='genup'){if(a>.8)continue;const q=clamp(a/.8,0,1),x=w2sx(f.x1),y=w2sy(f.y1),cs=S.cam.s;ctx.save();ctx.strokeStyle='rgba(219,181,255,'+(.85*(1-q))+')';ctx.lineWidth=Math.max(2,cs*.06);ctx.beginPath();ctx.arc(x,y,cs*(.5+q*1.2),0,6.3);ctx.stroke();for(let i=0;i<10;i++){const ang=i*.63,rr=cs*(.35+q*.8),px=x+Math.cos(ang)*rr,py=y+Math.sin(ang)*rr;ctx.fillStyle='rgba(214,169,255,'+(.85*(1-q))+')';ctx.beginPath();ctx.arc(px,py,Math.max(1.2,cs*.04),0,6.3);ctx.fill();}ctx.restore();
      } else if(f.k==='genplace'){if(a>.45)continue;const q=1-a/.45,x=w2sx(f.x1),y=w2sy(f.y1),cs=S.cam.s;ctx.save();ctx.strokeStyle='rgba(200,150,255,'+(.6*q)+')';ctx.lineWidth=Math.max(2,cs*.05);ctx.beginPath();ctx.arc(x,y,cs*(.5+(1-q)*.5),0,6.3);ctx.stroke();ctx.restore();
      } else if(f.k==='transfer'){if(a>.9)continue;const q=1-a/.9,cs=S.cam.s;ctx.save();ctx.strokeStyle='rgba(255,220,120,'+(.55*q)+')';ctx.lineWidth=Math.max(2,cs*.06);ctx.setLineDash([cs*.15,cs*.12]);ctx.beginPath();ctx.moveTo(w2sx(f.x1),w2sy(f.y1));ctx.lineTo(w2sx(f.x2),w2sy(f.y2));ctx.stroke();ctx.setLineDash([]);ctx.restore();
      } else if(f.k==='takeover'){if(a>.55)continue;const q=1-a/.55,x=w2sx(f.x1),y=w2sy(f.y1),cs=S.cam.s;ctx.save();ctx.strokeStyle='rgba(255,218,100,'+(.8*q)+')';ctx.lineWidth=Math.max(2,cs*.07);ctx.beginPath();ctx.arc(x,y,cs*(.25+(1-q)*.8),0,6.3);ctx.stroke();ctx.restore();
      } else if(f.k==='piecehit'){if(a>.35)continue;const q=1-a/.35,cs=S.cam.s;ctx.save();ctx.strokeStyle='rgba(255,235,150,'+(0.75*q)+')';ctx.lineWidth=Math.max(2,cs*.055);ctx.beginPath();ctx.arc(w2sx(f.x2),w2sy(f.y2),cs*(.25+(.7*q)),0,6.3);ctx.stroke();ctx.restore();
      } else if(f.k==='capture'){if(a>.5)continue;const q=1-a/.5,cs=S.cam.s,x=w2sx(f.x1),y=w2sy(f.y1);ctx.save();ctx.globalAlpha=1-q;ctx.strokeStyle='rgba(255,215,95,.9)';ctx.lineWidth=Math.max(2,cs*.07);ctx.beginPath();ctx.arc(x,y,cs*(.25+q*1.0),0,6.3);ctx.stroke();ctx.globalAlpha=.65*(1-q);ctx.fillStyle='#ffe37a';for(let i=0;i<8;i++){const ang=i*.785+f.ty*.3,rr=cs*(.35+q*.65);ctx.beginPath();ctx.arc(x+Math.cos(ang)*rr,y+Math.sin(ang)*rr,Math.max(1.5,cs*.035),0,6.3);ctx.fill();}ctx.restore();
      } else if(f.k==='queen'){if(a>.9)continue;const q=a/.9,cs=S.cam.s,x=w2sx(f.x1),y=w2sy(f.y1),fade=1-Math.pow(q,1.4);ctx.save();ctx.globalAlpha=fade;ctx.strokeStyle='rgba(255,225,120,.9)';ctx.lineWidth=Math.max(2,cs*.06);ctx.beginPath();ctx.arc(x,y,cs*(.35+q*1.2),0,6.3);ctx.stroke();for(let i=0;i<12;i++){const ang=i*.524+q*2,rr=cs*(.45+q*.85);ctx.fillStyle='rgba(255,230,130,'+(fade*.75)+')';ctx.beginPath();ctx.arc(x+Math.cos(ang)*rr,y+Math.sin(ang)*rr,Math.max(1.5,cs*.035),0,6.3);ctx.fill();}ctx.restore();
      } else if (f.k === 'die') {
        if (a > .7) continue; const q = a / .7, mine = Math.hypot(f.x1 - S.deathX, f.y1 - S.deathY) < .05 && S.dead, size = S.cam.s * 1.25 * (1 - q * .6);
        sprite(f.ty, mine ? S.side : opp(S.side), w2sx(f.x1), w2sy(f.y1), size, { alpha: 1 - q, rot: q * .8 });
      }
    }
    ctx.lineCap = 'butt';
  }
  /* charge / aim preview (local only - never sent to the server, so enemies cannot see it) */
  const dirOk = (t, dx, dy) => { if (!dx && !dy) return false; const d = dx && dy; return t === 'b' ? !!d : t === 'r' ? !d : true; };
  function curDir() { const k = S.k; return [(k.d ? 1 : 0) - (k.a ? 1 : 0), (k.s ? 1 : 0) - (k.w ? 1 : 0)]; }
  function previewCells(type, dx, dy, dur, cx, cy) {
    const out = [];
    if (type === 'n') {
      const v = KV[dx + ',' + dy]; if (!v) return out; const mj = Math.abs(v[0]) === 2;
      out.push(mj ? [Math.sign(v[0]), 0] : [0, Math.sign(v[1])], mj ? [2 * Math.sign(v[0]), 0] : [0, 2 * Math.sign(v[1])], v);
      return out.map(c => [cx + c[0], cy + c[1]]);
    }
    let n = 1;
    if (type === 'p') n = (MODE === 'pieces' && dur >= 400) ? 2 : 1; else n = clamp(Math.ceil(dur / (G.chargeSecPerGrid * 1000)), 1, G.maxCharge);
    for (let k = 1; k <= n; k++) { const x = cx + dx * k, y = cy + dy * k; if (x < .5 || y < .5 || x > WORLD - .5 || y > WORLD - .5) break; out.push([x, y]); }
    return out;
  }
  function drawPreview() {
    const me = S.ents.get(S.id); if (!me || S.dead || MODE === 'kings') return;
    let dx, dy, type, dur = 0;
    if (S.chg) { dx = S.chg.dx; dy = S.chg.dy; dur = performance.now() - S.chg.t0; type = MODE === 'battlegrid' ? me.k : S.sel; }
    else if (MODE === 'pieces' && S.sel) { [dx, dy] = curDir(); type = S.sel; }
    else return;
    if (!dirOk(type, dx, dy)) return;
    const cells = previewCells(type, dx, dy, dur, Math.floor(me.tx) + .5, Math.floor(me.ty) + .5); if (!cells.length) return;
    const s = S.cam.s; ctx.save();
    cells.forEach((c, i) => {
      const x = w2sx(c[0]), y = w2sy(c[1]), last = i === cells.length - 1;
      ctx.fillStyle = '#000'; ctx.strokeStyle = 'rgba(255,255,255,.55)'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(x, y, s * (last ? .16 : .11), 0, 6.3); ctx.fill(); ctx.stroke();
      if (last) { ctx.strokeStyle = 'rgba(0,0,0,.7)'; ctx.lineWidth = 3; ctx.strokeRect(x - s / 2 + 3, y - s / 2 + 3, s - 6, s - 6); if (MODE === 'pieces') sprite(type, S.side, x, y, s * 1.1, { alpha: .5 }); }
    });
    ctx.restore();
  }
  const placeKind=()=>S.place==='house'?'H':S.place==='gen'?'G':'W';
  const placeRadius=()=>S.place==='house'?G.houseR:S.place==='gen'?G.generator.radius:G.tower.r;
  const placeCost=()=>S.place==='house'?(S.me.hcost||G.house.base):S.place==='gen'?G.generator.cost:G.tower.cost;
  function pondGenCapacity(q){ const r=Number(q&&q[3]); if(!Number.isFinite(r)||r<=0)return 1; const spacing=Math.max(.1,Number(G.puddles.generatorSpacing)||2.2); const gr=Math.max(.1,Number(G.generator.radius)||1.45); return Math.max(1,Math.floor((2*Math.PI*r)/(spacing*gr))); }
  function generatorSlots(q){
    const cap=q[5]||pondGenCapacity(q), out=[], d=q[3]+G.generator.radius;
    for(let i=0;i<cap;i++){const a=-Math.PI/2+(Math.PI*2*i)/cap;out.push({x:q[1]+Math.cos(a)*d,y:q[2]+Math.sin(a)*d});}
    return out;
  }
  function freePuddleSlot(wx,wy,maxDist=8){
    if(MODE!=='kings')return null; let best=null,bd=maxDist;
    for(const q of S.puddles){
      for(const slot of generatorSlots(q)){
        const occupied=[...S.units.values()].some(o=>o.k==='G'&&o.puddleId===q[0]&&Math.hypot(o.tx-slot.x,o.ty-slot.y)<G.generator.radius*1.55);
        if(occupied)continue;
        const d=Math.hypot(slot.x-wx,slot.y-wy);
        if(d<bd){bd=d;best={x:slot.x,y:slot.y,q,qid:q[0]};}
      }
    }
    return best;
  }
  function snappedGenPreview(){return freePuddleSlot(S.aimX,S.aimY);}
  function drawPlacement(){
    if(!S.place)return;
    const s=S.cam.s;
    if(MODE==='kings'&&S.place==='gen'){
      const g=snappedGenPreview();if(!g)return;
      const ok=placeOk(g.x,g.y,G.generator.radius);
      drawGridGenerator({id:-1,rx:g.x,ry:g.y,ow:S.id,lvl:0,ga:.02});
      ctx.save();ctx.strokeStyle=ok?'rgba(80,230,140,.95)':'rgba(235,60,60,.95)';ctx.lineWidth=3;ctx.setLineDash([8,6]);ctx.beginPath();ctx.arc(w2sx(g.x),w2sy(g.y),(G.generator.radius+.1)*s,0,6.3);ctx.stroke();ctx.setLineDash([]);ctx.restore();
      return;
    }
    const wx=S.aimX,wy=S.aimY,r=placeRadius(),ok=placeOk(wx,wy,r);
    ctx.save();ctx.globalAlpha=.55;drawBldShape(placeKind(),w2sx(wx),w2sy(wy),r*s,S.side,true,0);ctx.restore();
    ctx.strokeStyle=ok?'rgba(60,220,90,.95)':'rgba(235,60,60,.95)';ctx.lineWidth=3;ctx.setLineDash([8,6]);ctx.beginPath();ctx.arc(w2sx(wx),w2sy(wy),(r+.1)*s,0,6.3);ctx.stroke();ctx.setLineDash([]);
  }
  function placeOk(x,y,r){
    if(MODE==='kings'&&S.place==='gen'){
      const preview=freePuddleSlot(x,y,.8);
      if(!preview||(S.me.elo||0)<G.generator.cost)return false;
    }
    if(MODE==='kings'&&S.shrine){const [shx,shy,shr]=S.shrine; if(Math.hypot(x-shx,y-shy)<shr+r)return false;}
    if(x<r+1||y<r+1||x>WORLD-r-1||y>WORLD-r-1)return false;
    for(const o of S.units.values())if((o.k==='H'||o.k==='W')&&Math.hypot(o.tx-x,o.ty-y)<r+bldRadius(o.k)+.3)return false;
    if(MODE==='kings'&&S.place==='gen'){for(const o of S.units.values())if(o.k==='G'&&Math.hypot(o.tx-x,o.ty-y)<r+bldRadius(o.k)+.18)return false;}
    if(S.place==='house'&&(S.me.hcount||0)>=G.house.cap)return false;
    if(S.place==='tower'&&(S.me.tcount||0)>=G.tower.cap)return false;
    if(S.place==='gen'&&(S.me.gcount||0)>=(S.me.gcap||G.puddles.count))return false;
    // Prevent placing on top of puddles
    if(S.place!=='gen'){for(const q of S.puddles){if(Math.hypot(q[1]-x,q[2]-y)<r+q[3]+.3)return false;}}
    return(S.me.elo||0)>=placeCost();
  }
  function findMyBldAt(wx, wy) {
    let best = null, bd = 1e9;
    for (const o of S.units.values()) {
      if(MODE==='battlegrid'){if(o.k!=='G'||o.ow!==S.id)continue;}else if((o.k!=='H'&&o.k!=='G'&&o.k!=='W')||o.ow!==S.id)continue;
      const r = bldRadius(o.k), d = Math.hypot(o.tx - wx, o.ty - wy);
      if (d < r && d < bd) { bd = d; best = o; }
    }
    return best;
  }
  function draw(){
    ctx.setTransform(DPR,0,0,DPR,0,0); ctx.fillStyle=col(tc.l); ctx.fillRect(0,0,W,H);
    drawBoard(); if(MODE==='kings')drawPuddles(); if(MODE==='kings')drawShrine(); drawOrbs(); drawPreview();
    const base=[];
    for(const o of S.ents.values()) base.push([o.ry,0,o]);
    for(const o of S.units.values()){
      if(o.k==='H'||o.k==='G'||o.k==='W') base.push([o.ry,2,o]);
      else if(!o.gr) base.push([o.ry,1,o]);
    }
    base.sort((a,b)=>a[0]-b[0]||a[1]-b[1]);
    for(const it of base){
      if(it[1]===0) drawPlayer(it[2]);
      else if(it[1]===1) drawPieceUnit(it[2]);
      else drawBuilding(it[2]);
    }
    // Garrisoned troops are rendered in a dedicated foreground pass so the tower platform is always behind them.
    if(MODE==='kings'){
      const posted=[...S.units.values()].filter(o=>o.k!=='H'&&o.k!=='G'&&o.k!=='W'&&o.gr);
      posted.sort((a,b)=>a.ry-b.ry);
      for(const o of posted) drawPieceUnit(o);
    }
    drawFx(); drawPlacement(); drawBadgesAll(); drawChatBubbles(); drawMini(); drawTouchUI();
  }
  function drawTouchUI() {
    if (touch.left) {
      const t = touch.left, dx = t.x - t.x0, dy = t.y - t.y0, dist = Math.hypot(dx, dy), cap = 60, mag = clamp(dist / cap, 0, 1);
      ctx.save(); ctx.globalAlpha = .55;
      ctx.strokeStyle = 'rgba(255,255,255,.75)'; ctx.lineWidth = 3; ctx.fillStyle = 'rgba(0,0,0,.22)';
      ctx.beginPath(); ctx.arc(t.x0, t.y0, cap, 0, 6.3); ctx.fill(); ctx.stroke();
      const nx = dist > 1 ? dx / dist : 0, ny = dist > 1 ? dy / dist : 0;
      ctx.globalAlpha = .85; ctx.fillStyle = '#fff';
      ctx.beginPath(); ctx.arc(t.x0 + nx * mag * cap, t.y0 + ny * mag * cap, 22, 0, 6.3); ctx.fill();
      ctx.restore();
    }
    if (touch.right && MODE !== 'kings') {
      const t = touch.right, chg = S.chg ? clamp((performance.now() - S.chg.t0) / (G.chargeSecPerGrid ? G.chargeSecPerGrid * 1000 * G.maxCharge : 1600), 0, 1) : 0;
      ctx.save(); ctx.globalAlpha = .6;
      ctx.strokeStyle = 'rgba(255,255,255,.75)'; ctx.lineWidth = 4; ctx.fillStyle = 'rgba(255,90,60,.20)';
      ctx.beginPath(); ctx.arc(t.x, t.y, 44, 0, 6.3); ctx.fill(); ctx.stroke();
      if (chg > 0) { ctx.strokeStyle = '#ffce4a'; ctx.lineWidth = 6; ctx.beginPath(); ctx.arc(t.x, t.y, 44, -Math.PI / 2, -Math.PI / 2 + chg * 6.28); ctx.stroke(); }
      ctx.restore();
    }
  }
  function drawMini() {
    mmx.setTransform(DPR, 0, 0, DPR, 0, 0); mmx.clearRect(0, 0, 120, 120);
    mmx.fillStyle = 'rgba(0,0,0,.38)'; mmx.fillRect(0, 0, 120, 120); mmx.strokeStyle = 'rgba(255,255,255,.7)'; mmx.lineWidth = 2; mmx.strokeRect(1, 1, 118, 118);
    const me = S.ents.get(S.id); if (!me || S.dead) return;
    const x = 4 + me.rx / WORLD * 112, y = 4 + me.ry / WORLD * 112, p = 1 + Math.sin(S.t * 5) * .15;
    mmx.fillStyle = S.side === 'w' ? '#fff' : '#111'; mmx.strokeStyle = S.side === 'w' ? '#111' : '#fff'; mmx.lineWidth = 2; mmx.beginPath(); mmx.arc(x, y, 4.5 * p, 0, 6.3); mmx.fill(); mmx.stroke();
  }

  /* ---------- HUD ---------- */
  const fmt = n => Math.floor(n || 0).toLocaleString('en-US');
  let lbAt = 0, promoSig = '', barBuilt = false;
  function toast(t) { const el = $('toast'); el.textContent = t; el.classList.add('show'); clearTimeout(toast.h); toast.h = setTimeout(() => el.classList.remove('show'), 2600); }
  function addChat(n, m) {
    // Add text bubble to player
    let bubbles = S.bubbles.get(n);
    if (!bubbles) { S.bubbles.set(n, bubbles = []); }
    bubbles.push({ text: m, t0: S.t, id: Math.random() });
    if (bubbles.length > 3) bubbles.shift();
  }
  function openChat() { S.chatOpen = true; S.k = {}; S.space = false; $('chatin').style.display = 'block'; $('chatin').value = ''; $('chatin').focus(); }
  function closeChat() { S.chatOpen = false; $('chatin').style.display = 'none'; $('chatin').blur(); }
  function toggleChat() {
    if (!S.chatOpen) { openChat(); return; }
    const v = $('chatin').value.trim(); if (v) send({ t: 'chat', m: v }); closeChat();
  }
  const pimg = t => MAN.pieces[S.side + t] || '';
  function slotHtml(t, key, cost) { return '<img src="' + pimg(t) + '" alt="' + P[t].name[0] + '"><em>' + key + '</em><b>' + cost + '</b><u></u>'; }
  function buildBar() {
    const bar = $('bar'); bar.innerHTML = ''; barBuilt = true;
    if (MODE === 'battlegrid') { bar.innerHTML = '<div id="promo"></div>'; return; }
    const mk = (cls, html, fn, id) => { const d = document.createElement('div'); d.className = cls; d.innerHTML = html; d.onclick = fn; if (id) d.id = id; bar.appendChild(d); return d; };
    (MODE === 'kings' ? 'pnbr' : 'pnbrq').split('').forEach((t, i) => {
      if (MODE === 'pieces') mk('slot' + (t === S.sel ? ' on' : ''), slotHtml(t, i + 1, G.cost[t]), () => hotkey(i + 1), 'sl_' + t);
      else mk('slot', slotHtml(t, i + 1, G.cost[t]), () => hotkey(i + 1), 'sl_' + t);
    });
    if (MODE === 'kings') {
      mk('slot bld', '<div class="ic ic-house"><svg viewBox="0 0 40 40"><rect x="5" y="5" width="30" height="30" rx="3" fill="#eeeed2" stroke="#333" stroke-width="2"/><rect x="7" y="7" width="13" height="13" fill="#769656"/><rect x="20" y="7" width="13" height="13" fill="#eeeed2"/><rect x="7" y="20" width="13" height="13" fill="#eeeed2"/><rect x="20" y="20" width="13" height="13" fill="#769656"/></svg></div><em>6</em><b id="hp_house"></b><small>House</small><u></u>', () => hotkey(6), 'sl_house');
      mk('slot bld', '<div class="ic ic-gen"><svg viewBox="0 0 40 40"><rect x="8" y="18" width="24" height="4" fill="#fff" stroke="#333" stroke-width="2"/><rect x="18" y="6" width="4" height="12" fill="#fff" stroke="#333" stroke-width="2"/><polygon points="10,22 6,34 12,34" fill="#fff" stroke="#333" stroke-width="2"/><polygon points="30,22 34,34 28,34" fill="#fff" stroke="#333" stroke-width="2"/></svg></div><em>7</em><b>' + G.generator.cost + '</b><small>Generator</small><u></u>', () => hotkey(7), 'sl_gen');
      mk('slot bld', '<div class="ic ic-tower"><svg viewBox="0 0 40 40"><g stroke="#333" stroke-width="1"><rect x="2" y="7" width="11" height="9" fill="#eeeed2"/><rect x="14.5" y="7" width="11" height="9" fill="#769656"/><rect x="27" y="7" width="11" height="9" fill="#eeeed2"/><rect x="1" y="17" width="9" height="9" fill="#769656"/><rect x="10" y="17" width="9" height="9" fill="#eeeed2"/><rect x="19" y="17" width="9" height="9" fill="#769656"/><rect x="28" y="17" width="9" height="9" fill="#eeeed2"/><rect x="7" y="27" width="26" height="7" fill="#d4d4d4"/></g></svg></div><em>8</em><b>' + G.tower.cost + '</b><small>Tower</small><u></u>', () => hotkey(8), 'sl_tower');
      mk('cap', '', null, 'capbox');
    }
  }
  function hotkey(n) {
    if (S.dead || S.chatOpen) return;
    if (MODE === 'battlegrid') { const o = S.promoOpts && S.promoOpts[n - 1]; if (o) send({ t: 'promo', to: o }); return; }
    if (MODE === 'pieces') {
      if (n < 1 || n > 5) return;
      const k = 'pnbrq'[n - 1]; S.sel = S.sel === k ? null : k; S.chg = null; send({ t: 'sel', k });
      document.querySelectorAll('.slot').forEach(sl => sl.classList.toggle('on', !!S.sel && sl.id === 'sl_' + S.sel));
      return;
    }
    if (MODE === 'kings' && n >= 1 && n <= 4) send({ t: 'buy', k: 'pnbr'[n - 1] });
    else if (MODE === 'pieces' && n >= 1 && n <= 5) { const k = 'pnbrq'[n - 1]; S.sel = S.sel === k ? null : k; S.chg = null; send({ t: 'sel', k }); document.querySelectorAll('.slot').forEach(sl => sl.classList.toggle('on', !!S.sel && sl.id === 'sl_' + S.sel)); }
    else if (n === 6) S.place = S.place === 'house' ? null : 'house';
    else if (n === 7) S.place = S.place === 'gen' ? null : 'gen';
    else if (n === 8) S.place = S.place === 'tower' ? null : 'tower';
  }
  function updateHud() {
    const me = S.me, t = performance.now();
    $('stats').textContent = 'ELO ' + fmt(me.elo);
    const killEl = $('killValue'); if (killEl) killEl.textContent = fmt(me.kills);
    $('specText').innerHTML = 'Elo: ' + fmt(me.elo) + '<br>Leaderboard: #' + S.rk + '<br>Kills: ' + fmt(me.kills);
    if (t - lbAt > 400) {
      lbAt = t; const box = $('lbrows'); box.innerHTML = '';
      for (let i = 0; i < S.lb.length; i++) { const r = S.lb[i], d = document.createElement('div'); if (r[0] === S.id) d.className = 'me'; d.innerHTML = '<i>' + (i + 1) + '</i><span></span><b>' + fmt(r[2]) + '</b>'; d.children[1].textContent = r[1]; box.appendChild(d); }
    }
    if (!barBuilt || S.dead) return;
    if (MODE === 'battlegrid') {
      const ty = me.k, opts = ty === 'p' ? ['n', 'b'] : (ty === 'n' || ty === 'b') ? ['r'] : ty === 'r' ? ['q'] : [], ok = opts.filter(o => me.elo >= G.promote[o]), sig = ok.join('');
      if (sig !== promoSig) {
        promoSig = sig; S.promoOpts = ok; const box = $('promo'); box.innerHTML = '';
        if (ok.length) { const l = document.createElement('div'); l.className = 'pl'; l.textContent = 'Promote'; box.appendChild(l); ok.forEach((o, i) => { const b = document.createElement('div'); b.className = 'slot'; b.innerHTML = '<img src="' + pimg(o) + '"><em>' + (i + 1) + '</em><b>' + P[o].name + '</b>'; b.onclick = () => send({ t: 'promo', to: o }); box.appendChild(b); }); }
      }
            return;
    }
    for (const k of 'pnbrq') {
      const el = $('sl_' + k); if (!el) continue; const c = G.cost[k]; el.classList.toggle('off', me.elo < c || (MODE === 'kings' && me.cnt >= me.cap));
      if (MODE === 'pieces') { const cd = (me.cd && me.cd[k]) || 0, u = el.querySelector('u'); u.style.height = clamp(cd / (G.cd[k] * 1000), 0, 1) * 100 + '%'; }
    }
    if (MODE === 'kings') {
      const hcost = me.hcost || G.house.base, hFull = (me.hcount || 0) >= G.house.cap, tFull = (me.tcount || 0) >= G.tower.cap;
      $('hp_house').textContent = hFull ? 'MAX' : fmt(hcost);
      $('sl_house').classList.toggle('off', hFull || me.elo < hcost); $('sl_gen').classList.toggle('off', me.elo < G.generator.cost || (me.gcount || 0) >= (me.gcap || G.puddles.count));
      $('sl_tower').classList.toggle('off', tFull || me.elo < G.tower.cost);
      $('sl_house').classList.toggle('on', S.place === 'house'); $('sl_gen').classList.toggle('on', S.place === 'gen'); $('sl_tower').classList.toggle('on', S.place === 'tower');
      $('capbox').innerHTML = 'Army <b class="' + (me.over ? 'ov' : '') + '">' + (me.cnt || 0) + ' / ' + (me.cap || 0) + '</b><small>SPACE split</small>' +
        '<small>Houses ' + (me.hcount || 0) + '/' + G.house.cap + ' &middot; Generators ' + (me.gcount || 0) + '/' + (me.gcap || 0) + ' &middot; Towers ' + (me.tcount || 0) + '/' + G.tower.cap + '</small>';
    }
  }
  // Click-driven building upgrade panel. It never follows the cursor, so FOV/resize/hover cannot make it disappear.
  let tooltipSig='';
  function bldUpgradeCost(o){
    const lvl=o.lvl||0;
    if(o.k==='G') return lvl>=G.generator.upgradeCosts.length ? null : G.generator.upgradeCosts[lvl];
    return lvl>=G.upgrade.maxLvl ? null : Math.round(G.upgrade.base*Math.pow(G.upgrade.maxCost/G.upgrade.base,clamp(lvl,0,G.upgrade.maxLvl-1)/(G.upgrade.maxLvl-1)));
  }
  function renderBldPanel(){
    const tip=$('bldtip');if(!tip)return;
    if(MODE!=='kings'||!S.selectedBld){S.selectedBld=0;S.upgradeArmed=false;tip.classList.remove('show');tooltipSig='';return;}
    const o=S.units.get(S.selectedBld);
    if(!o||o.ow!==S.id||(o.k!=='H'&&o.k!=='G')||o.fl&2){S.selectedBld=0;S.upgradeArmed=false;tip.classList.remove('show');tooltipSig='';return;}
    const lvl=o.lvl||0,cost=bldUpgradeCost(o),maxed=cost==null;
    const fast=S.upgradeFastId===o.id&&S.t<S.upgradeFastUntil;
    let html='';
    if(o.k==='G'){const name=(G.generator.names||[])[Math.min(lvl,4)]||'Generator';const gain=(G.generator.eloPerHit||[])[Math.min(lvl,4)]||0;html='<b>Generator · '+name+'</b><small>+'+gain+' ELO per HIT</small>';}
    else html='<b>House · Level '+lvl+'/'+G.upgrade.maxLvl+'</b><small>+'+G.houseCapPerLvl+' capacity</small>';
    if(maxed) html+='<small>MAX LEVEL</small>';
    else if(fast) html+='<small>Cost: '+fmt(cost)+' ELO</small><button id=upgradeBld>UPGRADE AGAIN</button>';
    else html+='<small>Do you want to upgrade?</small><small>Cost: '+fmt(cost)+' ELO</small><button id=upgradeBld>CONFIRM UPGRADE</button>';
    const sig=o.id+'|'+lvl+'|'+(fast?1:0)+'|'+(S.upgradeArmed?1:0)+'|'+(S.t);
    if(sig!==tooltipSig){tip.innerHTML=html;tooltipSig=sig;const btn=$('upgradeBld');if(btn)btn.onclick=e=>{e.stopPropagation();clickBuilding(o);};}
    const sx=w2sx(o.tx),sy=w2sy(o.ty), pw=Math.round(clamp(bldRadius(o.k)*S.cam.s*1.9,150,250));
    tip.style.width=pw+'px';
    tip.style.left=clamp(sx, pw/2+8, W-pw/2-8)+'px';
    tip.style.top=clamp(sy-bldRadius(o.k)*S.cam.s-55, 60, H-70)+'px';
    tip.classList.add('show');
  }
  function clickBuilding(o){
    if(!o||o.ow!==S.id||(o.k!=='H'&&o.k!=='G'))return;
    if(S.selectedBld!==o.id){
      S.selectedBld=o.id; S.upgradeArmed=true; tooltipSig=''; renderBldPanel();
      return;
    }
    if(bldUpgradeCost(o)==null)return;
    // First click selects the building and asks for confirmation; the next click buys.
    // After a successful purchase, clicks on the same building within 3 seconds buy again.
    send({t:'upgrade',id:o.id});
    S.upgradeArmed=false; tooltipSig=''; renderBldPanel();
  }
  /* ---------- input ---------- */
  let buyRepeatKey = null, buyRepeatTimer = 0;
  function stopBuyRepeat() { if (buyRepeatTimer) { clearInterval(buyRepeatTimer); buyRepeatTimer = 0; } buyRepeatKey = null; }
  function startBuyRepeat(n) {
    if (MODE !== 'kings' || n < 1 || n > 5) return;
    stopBuyRepeat(); buyRepeatKey = n; hotkey(n);
    buyRepeatTimer = setInterval(() => {
      if (S.chatOpen || S.dead || !S.playing || buyRepeatKey !== n) { stopBuyRepeat(); return; }
      hotkey(n);
    }, 120);
  }
  function canCharge(type, me) {
    if (me && me.st) return false;
    if (MODE === 'battlegrid') return (S.me.cd || 0) < 50;
    return (S.me.elo || 0) >= G.cost[type] && ((S.me.cd && S.me.cd[type]) || 0) < 50;
  }
  function inputStep() {
    if (!S.playing || S.dead) return;
    const now = performance.now(), me = S.ents.get(S.id);
    if (MODE === 'kings') {
      if (touch.left) {                                          // mobile: left-side joystick drives a direction, not a cursor point
        const bx = me ? me.rx : S.cam.x, by = me ? me.ry : S.cam.y;
        S.aimX = bx + (S.joy ? S.joy.x : 0) * 25; S.aimY = by + (S.joy ? S.joy.y : 0) * 25;
      } else {
        S.aimX = S.cam.x + (S.mouse.x - W / 2) / S.cam.s; S.aimY = S.cam.y + (S.mouse.y - H / 2) / S.cam.s;
      }
      if (now - S.lastAim > 50) { S.lastAim = now; send({ t: 'aim', x: S.aimX, y: S.aimY }); }
      return;
    }
    // Battle Grid: WASD aiming + space/click to move
    if (MODE === 'battlegrid') {
      const [dx, dy] = S.chatOpen ? [0, 0] : curDir();
      const str=dx+','+dy;
      if(str!==S.lastIn){S.lastIn=str;S.lastInT=now;send({t:'in',dx,dy});}
      const holding = (S.space || S.mouse.down) && !S.chatOpen; if (!holding) S.block = false;
      const type = me ? me.k : 'p';
      if (S.chg && me && me.st) { S.chg = null; S.block = true; }
      if (!S.chg) { if (holding && !S.block && dirOk(type, dx, dy) && canCharge(type, me)) { S.chg = { dx, dy, t0: now }; send({ t: 'chg', dx, dy }); } }
      else if (!holding) { send({ t: 'rel' }); S.chg = null; }
      return;
    }
    // Pieces with Pieces: keep WASD movement
    const [dx, dy] = S.chatOpen ? [0, 0] : curDir(), str = dx + ',' + dy;
    if (str !== S.lastIn || (now - S.lastInT > 400 && (dx || dy))) { S.lastIn = str; S.lastInT = now; send({ t: 'in', dx, dy }); }
    const holding = (S.space || S.mouse.down) && !S.chatOpen; if (!holding) S.block = false;
    const type = S.sel;
    if (!type) { S.chg = null; return; }                       // holding nothing: no aiming, no attack
    if (S.chg && me && me.st) { S.chg = null; S.block = true; }
    if (!S.chg) { if (holding && !S.block && dirOk(type, dx, dy) && canCharge(type, me)) { S.chg = { dx, dy, t0: now }; send({ t: 'chg', dx, dy }); } }   // direction is committed at charge start
    else if (!holding) { send({ t: 'rel' }); S.chg = null; }
  }
  addEventListener('keydown', e => {
    if (e.key === 'Enter') { if (S.playing && !S.ended) { toggleChat(); e.preventDefault(); } return; }
    if (S.chatOpen) { if (e.key === 'Escape') closeChat(); return; }
    if (!S.playing || S.dead) return;
    const k = e.key.toLowerCase();
    // WASD for aiming in Battle Grid and movement in Pieces with Pieces
    if (k.length === 1 && 'wasd'.includes(k)) { S.k[k] = true; e.preventDefault(); }
    else if (e.key === ' ') { e.preventDefault(); if (!e.repeat) { S.space = true; if (MODE === 'kings') send({ t: 'split' }); } }
    else if (e.key >= '1' && e.key <= '9') {
      const n = +e.key;
      if (MODE === 'kings' && n >= 1 && n <= 4) { if (!e.repeat && buyRepeatKey !== n) startBuyRepeat(n); }
      else if (!e.repeat) hotkey(n);
    }
    else if (e.key === 'Escape') S.place = null;
  });
  addEventListener('keyup', e => { const k = e.key.toLowerCase(); if (k.length === 1 && 'wasd'.includes(k)) S.k[k] = false; if (e.key === ' ') S.space = false; if (e.key >= '1' && e.key <= '5' && MODE === 'kings' && buyRepeatKey === +e.key) stopBuyRepeat(); });
  addEventListener('blur', () => { stopBuyRepeat(); S.k = {}; S.space = false; S.mouse.down = false; });
  addEventListener('mousemove', e => { S.mouse.x = e.clientX; S.mouse.y = e.clientY; });
  cvs.addEventListener('mousedown', e => {
    if (!S.playing || S.dead) return;
    if (e.button === 2) { S.place = null; return; }
    if (e.button !== 0) return;
    if (MODE === 'kings') {
      if (S.place) {
        if (S.place === 'gen') {
          const g = snappedGenPreview();
          if (g && placeOk(g.x, g.y, G.generator.radius)) { send({ t: 'place', k: 'gen', x: g.x, y: g.y, qid: g.qid }); S.place = null; }
        } else {
          const r = S.place === 'house' ? G.houseR : G.tower.r;
          if (placeOk(S.aimX, S.aimY, r)) { send({ t: 'place', k: S.place, x: S.aimX, y: S.aimY }); S.place = null; }
        }
      } else {
        const b = findMyBldAt(S.aimX, S.aimY);
        if (b && b.k === 'W') send({ t: 'garrison', id: b.id});
        else if (b && (b.k === 'H' || b.k === 'G')) clickBuilding(b);
        else if (S.selectedBld) { S.selectedBld=0; S.upgradeArmed=false; tooltipSig=''; renderBldPanel(); }
      }
      return;
    }
    S.mouse.down = true;
  });
  addEventListener('mouseup', e => { if (e.button === 0) S.mouse.down = false; });
  cvs.addEventListener('contextmenu', e => e.preventDefault());

  /* ---------- mobile / touch controls ----------
     Battle Grid & Pieces with Pieces: drag the LEFT half of the screen to aim (drives the same S.k WASD
     booleans as the keyboard), hold anywhere on the RIGHT half to charge (drives S.mouse.down, same as
     holding the mouse button on desktop).
     Battle of the Kings: drag the LEFT half like a joystick to move, tap the RIGHT half to split. */
  const touch = { left: null, right: null };
  const touchZone = x => x < W / 2 ? 'left' : 'right';
  function applyLeftTouch() {
    const t = touch.left;
    if (!t) { S.k.w = S.k.a = S.k.s = S.k.d = false; S.joy = null; return; }
    const dx = t.x - t.x0, dy = t.y - t.y0, dist = Math.hypot(dx, dy), dead = 10, cap = 60;
    if (dist < dead) { S.k.w = S.k.a = S.k.s = S.k.d = false; S.joy = { x: 0, y: 0 }; return; }
    const nx = dx / dist, ny = dy / dist, mag = clamp(dist / cap, 0, 1);
    S.joy = { x: nx * mag, y: ny * mag };
    S.k.d = nx > .35; S.k.a = nx < -.35; S.k.s = ny > .35; S.k.w = ny < -.35;
  }
  function onTouchStart(e) {
    if (!S.playing || S.dead || S.chatOpen) return;
    for (const t of e.changedTouches) {
      const zone = touchZone(t.clientX);
      if (zone === 'left') { if (!touch.left) touch.left = { id: t.identifier, x0: t.clientX, y0: t.clientY, x: t.clientX, y: t.clientY }; }
      else if (!touch.right) {
        touch.right = { id: t.identifier, x0: t.clientX, y0: t.clientY, x: t.clientX, y: t.clientY };
        if (MODE !== 'kings') S.mouse.down = true;
      }
    }
    applyLeftTouch();
    e.preventDefault();
  }
  function onTouchMove(e) {
    for (const t of e.changedTouches) {
      if (touch.left && t.identifier === touch.left.id) { touch.left.x = t.clientX; touch.left.y = t.clientY; }
      if (touch.right && t.identifier === touch.right.id) { touch.right.x = t.clientX; touch.right.y = t.clientY; }
    }
    applyLeftTouch();
    e.preventDefault();
  }
  function onTouchEnd(e) {
    for (const t of e.changedTouches) {
      if (touch.left && t.identifier === touch.left.id) {
        const lx=touch.left.x0,ly=touch.left.y0, moved=Math.hypot(t.clientX-lx,t.clientY-ly);
        if(MODE==='kings'&&moved<12&&!S.place){const wx=S.cam.x+(t.clientX-W/2)/S.cam.s,wy=S.cam.y+(t.clientY-H/2)/S.cam.s;const b=findMyBldAt(wx,wy);if(b&&(b.k==='H'||b.k==='G'))clickBuilding(b);}
        touch.left = null;
      }
      if (touch.right && t.identifier === touch.right.id) {
        const rx=touch.right.x0, ry=touch.right.y0, moved=Math.hypot(t.clientX-rx,t.clientY-ry);
        if (MODE === 'kings') {
          if (moved < 12 && !S.place) {
            const wx=S.cam.x+(t.clientX-W/2)/S.cam.s, wy=S.cam.y+(t.clientY-H/2)/S.cam.s;
            const b=findMyBldAt(wx,wy);
            if (b&&(b.k==='H'||b.k==='G')) clickBuilding(b); else send({t:'split'});
          } else if (moved >= 12) send({t:'split'});
        } else S.mouse.down = false;
        touch.right = null;
      }
    }
    applyLeftTouch();
    e.preventDefault();
  }
  cvs.addEventListener('touchstart', onTouchStart, { passive: false });
  cvs.addEventListener('touchmove', onTouchMove, { passive: false });
  cvs.addEventListener('touchend', onTouchEnd, { passive: false });
  cvs.addEventListener('touchcancel', onTouchEnd, { passive: false });
  $('back').onclick = () => { 
  document.body.style.transition = 'opacity 0.3s ease-in-out';
  document.body.style.opacity = document.getElementById('cioTitleIntro') ? '1' : '0';
  setTimeout(() => { location.href = '/'; }, 300);
};

  /* ---------- main loop ---------- */
  function frame(ts) {
    requestAnimationFrame(frame);
    const dt = Math.min(.05, ((ts - S.last) / 1000) || .016); S.last = ts; S.t += dt; themeStep(dt);
    if (!S.playing) { menuBg(dt); return; }
    update(dt); draw();
  }
  resize();
  loadAssets().then(() => { buildMenu(); document.body.style.opacity = '1'; $('menu').classList.add('show'); requestAnimationFrame(frame); });
}


/* ============================== TITLE CAPTURE INTRO ============================== */
function titleIntroAnimation() {
  if (document.getElementById('cioTitleCapture')) return;
  const logo = document.querySelector('#menu .logo');
  if (!logo) return;
  const style=document.createElement('style');
  style.dataset.cioLogoIntro='1';
  style.textContent=`
    #menu .logo{position:relative;overflow:visible;isolation:isolate}
    #menu .cio-logo-title{position:relative;z-index:3;display:inline-block}
    #menu .cioTitleCapture{position:absolute;inset:0;z-index:1;pointer-events:none}
    #menu .cio-piece-slot{position:absolute;left:calc(50% + 135px);top:50%;width:108px;height:108px;transform:translate(-50%,-50%);pointer-events:none;z-index:1;filter:drop-shadow(0 8px 7px rgba(0,0,0,.30))}
    #menu .cio-piece-slot img{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;will-change:opacity,transform;user-select:none}
    #menu .cio-piece-slot .layer2{opacity:0}
    #menu .cio-impact{position:absolute;left:calc(50% + 142px);top:50%;width:14px;height:14px;border-radius:50%;background:#fff;opacity:0;z-index:8;pointer-events:none}
  `;
  document.head.appendChild(style);
  const original=logo.innerHTML;
  const titleText=document.createElement('span'); titleText.className='cio-logo-title'; titleText.innerHTML=original;
  logo.innerHTML=''; logo.appendChild(titleText);
  const victimType=['p','n','b','r','q'][Math.floor(Math.random()*5)];
  let attackerType=['p','n','b','r','q'][Math.floor(Math.random()*5)];
  if(attackerType===victimType) attackerType=['p','n','b','r','q'][(['p','n','b','r','q'].indexOf(attackerType)+1)%5];
  const EMO={p:'♟',n:'♞',b:'♝',r:'♜',q:'♛'};
  const side=()=>{try{return localStorage.getItem('cio_side')==='b'?'b':'w'}catch(e){return'w'}};
  const opposite=c=>c==='b'?'w':'b';
  let manifest={pieces:{}}, activeSide=side(), alive=true, finished=false;
  const root=document.createElement('span'); root.id='cioTitleCapture';
  function makePiece(type){
    const slot=document.createElement('span'); slot.className='cio-piece-slot';
    const a=document.createElement('img'), b=document.createElement('img'), ea=document.createElement('span');
    a.className='layer1'; b.className='layer2';
    Object.assign(ea.style,{position:'absolute',inset:'0',display:'flex',alignItems:'center',justifyContent:'center',fontSize:'52px',lineHeight:'1',opacity:'1'});
    slot.append(a,b,ea); slot.dataset.type=type;
    return {slot,a,b,emoji:ea};
  }
  const victim=makePiece(victimType), attacker=makePiece(attackerType);
  victim.slot.style.opacity='1'; attacker.slot.style.opacity='0';
  root.append(victim.slot,attacker.slot); logo.appendChild(root);
  const impact=document.createElement('span'); impact.className='cio-impact'; logo.appendChild(impact);
  const assets=()=>((window.__MENU_PIECES && Object.keys(window.__MENU_PIECES).length) ? window.__MENU_PIECES : ((window.__SC_ASSETS && window.__SC_ASSETS.pieces) ? window.__SC_ASSETS.pieces : manifest.pieces));
  function setPiece(piece,color,fade){
    const src=assets()[color+piece.slot.dataset.type]||'';
    piece.emoji.textContent='';
    piece.emoji.style.opacity='0';
    if(!src){piece.a.removeAttribute('src');piece.b.removeAttribute('src');piece.a.style.opacity='0';piece.b.style.opacity='0';return;}
    if(!fade || !piece.a.getAttribute('src')){piece.a.src=src;piece.a.style.opacity='1';piece.b.style.opacity='0';return;}
    piece.b.src=src; piece.b.style.opacity='0';
    piece.b.animate([{opacity:0},{opacity:1}],{duration:360,easing:'ease-out',fill:'forwards'});
    piece.a.animate([{opacity:1},{opacity:0}],{duration:360,easing:'ease-out',fill:'forwards'});
    setTimeout(()=>{if(alive || piece.slot.dataset.permanent==='1'){piece.a.src=src;piece.a.style.opacity='1';piece.b.style.opacity='0'}},370);
  }
  function setSides(color,fade){setPiece(victim,color,fade);setPiece(attacker,opposite(color),fade)}
  setSides(activeSide,false);
  fetch('/assets/manifest.json',{cache:'no-store'}).then(r=>r.ok?r.json():null).then(m=>{if(m&&m.pieces){manifest=m;setSides(activeSide,true)}}).catch(()=>{});
  const frames={
    p:[{transform:'translate(-50%,-50%) translate(78px,38px) rotate(22deg) scale(.70)'},{transform:'translate(-50%,-50%) translate(34px,18px) rotate(10deg) scale(.88)',offset:.42},{transform:'translate(-50%,-50%) translate(0,0) rotate(0) scale(1)'}],
    n:[{transform:'translate(-50%,-50%) translate(76px,14px) rotate(16deg) scale(.70)'},{transform:'translate(-50%,-50%) translate(38px,-36px) rotate(-10deg) scale(.90)',offset:.36},{transform:'translate(-50%,-50%) translate(7px,0) rotate(5deg) scale(1.04)',offset:.72},{transform:'translate(-50%,-50%) translate(0,0) rotate(0) scale(1)'}],
    b:[{transform:'translate(-50%,-50%) translate(84px,-54px) rotate(-28deg) scale(.70)'},{transform:'translate(-50%,-50%) translate(38px,-27px) rotate(-12deg) scale(.90)',offset:.44},{transform:'translate(-50%,-50%) translate(0,0) rotate(0) scale(1)'}],
    r:[{transform:'translate(-50%,-50%) translate(116px,0) scale(.70)'},{transform:'translate(-50%,-50%) translate(44px,0) scale(.92)',offset:.48},{transform:'translate(-50%,-50%) translate(0,0) scale(1)'}],
    q:[{transform:'translate(-50%,-50%) translate(92px,-66px) rotate(18deg) scale(.70)'},{transform:'translate(-50%,-50%) translate(46px,-34px) rotate(-10deg) scale(.90)',offset:.42},{transform:'translate(-50%,-50%) translate(10px,3px) rotate(5deg) scale(1.05)',offset:.72},{transform:'translate(-50%,-50%) translate(0,0) rotate(0) scale(1)'}]
  };
  victim.slot.animate([
    {transform:'translate(-50%,-50%) translate(0,-34px) rotate(-7deg) scale(.62)',opacity:0},
    {transform:'translate(-50%,-50%) translate(0,0) rotate(3deg) scale(1.03)',opacity:1,offset:.68},
    {transform:'translate(-50%,-50%) translate(0,0) rotate(0) scale(1)',opacity:1}
  ],{duration:800,easing:'cubic-bezier(.18,.9,.25,1)',fill:'forwards'});
  setTimeout(()=>{
    if(!alive)return;
    attacker.slot.style.opacity='1';
    attacker.slot.animate(frames[attackerType],{duration:1020,easing:'cubic-bezier(.14,.82,.24,1)',fill:'forwards'});
    setTimeout(()=>{
      impact.animate([{opacity:0,transform:'translate(-50%,-50%) scale(.2)'},{opacity:1,transform:'translate(-50%,-50%) scale(1.8)',offset:.3},{opacity:0,transform:'translate(-50%,-50%) scale(4.4)'}],{duration:300,easing:'ease-out',fill:'forwards'});
      logo.animate([{transform:'translateX(0)'},{transform:'translateX(-3px) rotate(-.35deg)',offset:.25},{transform:'translateX(2px) rotate(.3deg)',offset:.55},{transform:'translateX(0)'}],{duration:260,easing:'ease-out'});
      victim.slot.animate([
        {transform:'translate(-50%,-50%) translate(0,0) rotate(0) scale(1)',opacity:1},
        {transform:'translate(-50%,-50%) translate(-20px,-11px) rotate(-18deg) scale(.96)',opacity:.88,offset:.22},
        {transform:'translate(-50%,-50%) translate(-54px,-34px) rotate(-48deg) scale(.72)',opacity:.34,offset:.62},
        {transform:'translate(-50%,-50%) translate(-92px,-64px) rotate(-78deg) scale(.48)',opacity:0}
      ],{duration:820,easing:'cubic-bezier(.18,.78,.2,1)',fill:'forwards'});
    },450);
  },860);
  const watch=setInterval(()=>{const s=side();if(s!==activeSide){activeSide=s;setSides(s,true)}},90);
  setTimeout(()=>{
    finished=true; victim.slot.remove(); impact.remove(); clearInterval(watch); alive=false;
    // Keep the attacker permanently until page reload, but keep its color synced if the menu side changes.
    const permanentWatch=setInterval(()=>{
      const s=side(); if(s!==activeSide){activeSide=s;setPiece(attacker,opposite(s),true)}
    },120);
    if(attacker.slot.parentNode!==root) root.appendChild(attacker.slot);
    attacker.slot.dataset.permanent='1';
    window.addEventListener('beforeunload',()=>clearInterval(permanentWatch),{once:true});
    // Leave the intro styles/root alive because the attacker remains attached to the logo.
  },3300);
}


const CSS = `
*{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%;overflow:hidden;background:#262421;font-family:"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:#fff;user-select:none;-webkit-user-select:none}
canvas{position:fixed;left:0;top:0;touch-action:none}
#bg{z-index:0}#game{z-index:1}
button{font:inherit;cursor:pointer;border:0;outline:0}
#menu{position:fixed;inset:0;display:none;align-items:center;justify-content:center;z-index:5}
#menu.show{display:flex}body.playing #menu{display:none}
.card{background:#fff;color:#2b2b2b;width:410px;max-width:94vw;border-radius:16px;padding:24px 28px 20px;box-shadow:0 14px 44px rgba(0,0,0,.35)}
.logo{font-size:44px;font-weight:800;letter-spacing:-1.5px;line-height:1;text-align:center}.logo span{color:#5d8f36}
.sub{text-align:center;font-weight:700;color:#7a7a7a;margin:6px 0 16px;font-size:15px;letter-spacing:.5px;text-transform:uppercase}
#name{width:100%;font:inherit;font-size:17px;padding:11px 14px;border:2px solid #dcdcdc;border-radius:10px;outline:0;color:#2b2b2b;transition:border-color .15s}
#name:focus{border-color:#81b64c}
.row{display:flex;gap:10px;margin:14px 0 4px}
.kb{flex:1;background:#f3f3f3;border-radius:12px;padding:8px 6px 6px;display:flex;flex-direction:column;align-items:center;border:3px solid transparent;transition:transform .15s,background .15s,border-color .15s;color:#444;font-weight:600;font-size:13px}
.kb img{width:72px;height:72px;object-fit:contain}
.kb:hover{transform:translateY(-3px) scale(1.03);background:#ececec}.kb:active{transform:translateY(1px) scale(.97)}
.kb.on{border-color:#81b64c;background:#eef6e4}
.lab{font-size:12px;font-weight:700;color:#8a8a8a;text-transform:uppercase;letter-spacing:.8px;margin:14px 0 7px}
.themes{display:grid;grid-template-columns:repeat(5,1fr);gap:9px}
.th{width:100%;aspect-ratio:1;display:grid;grid-template-columns:1fr 1fr;border-radius:8px;overflow:hidden;padding:0;border:3px solid transparent;background:none;transition:transform .15s,border-color .15s}
.th i{display:block}.th:hover{transform:translateY(-2px) scale(1.06)}.th:active{transform:scale(.96)}.th.on{border-color:#2b2b2b}
#play{width:100%;margin-top:18px;font-size:22px;font-weight:800;color:#fff;background:#81b64c;border-radius:12px;padding:12px;box-shadow:0 4px 0 #5d8f36;transition:transform .12s,box-shadow .12s,background .12s}
#play:hover{transform:translateY(-2px) scale(1.015);background:#8fc457;box-shadow:0 6px 0 #5d8f36}
#play:active{transform:translateY(3px);box-shadow:0 1px 0 #5d8f36}
.gcards{display:grid;grid-template-columns:1fr 1fr;gap:9px}
.gcard{position:relative;overflow:hidden;background:#f3f3f3;border-radius:13px;padding:10px 8px 9px;display:flex;flex-direction:column;align-items:center;gap:5px;color:#444;font-size:11.5px;font-weight:700;line-height:1.15;text-align:center;box-shadow:0 2px 0 rgba(0,0,0,.07);transition:transform .2s cubic-bezier(.2,.9,.3,1.4),box-shadow .2s,background .2s}
.gcard .mini{width:52px;height:52px;display:grid;grid-template-columns:repeat(3,1fr);grid-template-rows:repeat(3,1fr);border-radius:7px;overflow:hidden;box-shadow:inset 0 0 0 2px rgba(0,0,0,.13)}
.gcard .mini i{background:#eeeed2}.gcard .mini i:nth-child(2n){background:#769656}
.gcard .pc{position:absolute;left:50%;top:14px;width:40px;height:40px;object-fit:contain;font-size:36px;line-height:36px;color:#2b2b2b;pointer-events:none;filter:drop-shadow(0 3px 2px rgba(0,0,0,.35));animation:bob 2.6s ease-in-out infinite;transform:translateX(-50%)}
.gcard b{margin-top:2px}
.gcard em{font-style:normal;font-size:9px;letter-spacing:.6px;text-transform:uppercase;background:#81b64c;color:#fff;border-radius:99px;padding:2px 8px}
.gcard::after{content:"";position:absolute;inset:0;background:linear-gradient(115deg,transparent 34%,rgba(255,255,255,.8) 48%,transparent 62%);transform:translateX(-130%);pointer-events:none}
.gcard:hover{background:#ececec;transform:translateY(-4px) rotate(-1.4deg) scale(1.045);box-shadow:0 10px 18px rgba(0,0,0,.16)}
.gcard:hover::after{animation:shim .8s ease}
.gcard:hover .pc{animation:hopbob .55s ease-in-out infinite}
.gcard:active{transform:translateY(0) scale(.98)}
.gcard.cur{background:#eef6e4;box-shadow:inset 0 0 0 3px #81b64c;cursor:default}
.gcard.cur:hover{transform:none;background:#eef6e4;box-shadow:inset 0 0 0 3px #81b64c}
.gcard.soon{opacity:.6}.gcard.soon em{background:#9a9a9a}
@keyframes bob{0%,100%{transform:translateX(-50%) translateY(0)}50%{transform:translateX(-50%) translateY(-3px)}}
@keyframes hopbob{0%,100%{transform:translateX(-50%) translateY(0) scaleY(1)}30%{transform:translateX(-50%) translateY(-10px) scaleY(1.1)}62%{transform:translateX(-50%) translateY(0) scaleY(.9)}}
@keyframes shim{to{transform:translateX(130%)}}
#hud{display:none}body.playing #hud{display:block}
.shadowtxt{text-shadow:0 1px 3px rgba(0,0,0,.9),0 0 6px rgba(0,0,0,.5)}
#fade{position:fixed;inset:0;background:#111;z-index:999;opacity:0;pointer-events:none;transition:opacity .3s}
#fade.fading{opacity:1}
#lb{position:fixed;left:12px;top:12px;width:210px;background:rgba(0,0,0,.36);border-radius:10px;padding:8px 10px;z-index:3;font-size:13px}
#lb h4{font-size:12px;letter-spacing:.8px;text-transform:uppercase;opacity:.75;margin-bottom:4px}
#lb div div{display:flex;gap:6px;padding:1.5px 0}#lb i{width:16px;font-style:normal;opacity:.6}#lb span{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}#lb b{font-weight:700}
#lb .me{color:#ffd85a;font-weight:700}
#killCounter{margin-top:7px;padding-top:7px;border-top:1px solid rgba(255,255,255,.12);font-weight:800;display:flex;justify-content:space-between;align-items:center}#killCounter b{color:#ffd85a}
#stats{position:fixed;left:14px;bottom:12px;z-index:3;font-weight:700;font-size:15px}
#chatin{position:absolute;width:300px;z-index:4;display:none;background:rgba(0,0,0,.55);border:1px solid rgba(255,255,255,.3);border-radius:8px;color:#fff;padding:6px 9px;font:inherit;font-size:14px;outline:0;user-select:text}
#mmw{position:fixed;right:12px;bottom:12px;z-index:3}#mm{position:static;width:120px;height:120px;border-radius:6px}
#bar{position:fixed;left:50%;bottom:14px;transform:translateX(-50%);z-index:3;display:flex;gap:8px;align-items:flex-end}
body.dead #bar{display:none}
.slot{position:relative;width:74px;height:84px;background:rgba(20,20,20,.55);border:2px solid rgba(255,255,255,.25);border-radius:10px;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;padding-bottom:3px;overflow:hidden;cursor:pointer;transition:transform .12s,border-color .12s,opacity .15s}
.slot:hover{transform:translateY(-3px) scale(1.04)}.slot:active{transform:scale(.96)}
.slot.on{border-color:#ffd85a;background:rgba(60,55,20,.6)}.slot.off{opacity:.45}
.slot img{width:48px;height:48px;object-fit:contain;position:absolute;top:6px}
.slot .ic{position:absolute;top:8px;width:48px;height:48px;display:flex;align-items:center;justify-content:center}
.slot .ic svg{width:48px;height:48px}
.slot .ic.ic-house svg,.slot .ic.ic-gen svg{width:36px;height:36px}
.slot em{position:absolute;left:5px;top:2px;font-style:normal;font-size:11px;font-weight:700;opacity:.8}
.slot b{font-size:12px;position:relative}.slot small{font-size:10px;opacity:.75;position:relative}
.slot u{position:absolute;left:0;bottom:0;width:100%;height:0;background:rgba(0,0,0,.62)}
.cap{align-self:center;margin-left:8px;font-size:14px;font-weight:700;text-align:center;line-height:1.3}.cap small{display:block;font-size:11px;opacity:.7}.cap .ov{color:#ff6b5e}
#promo{display:flex;gap:8px;align-items:flex-end}#promo .pl{align-self:center;font-weight:800;letter-spacing:.8px;text-transform:uppercase;font-size:12px}
#spec{position:fixed;left:34px;bottom:110px;z-index:4;opacity:0;pointer-events:none;transition:opacity .6s}
#spec.show{opacity:1}
#specText{font-size:26px;font-weight:700;line-height:1.45;text-shadow:0 2px 5px rgba(0,0,0,.95),0 0 10px rgba(0,0,0,.6)}
#back{margin-top:16px;padding:11px 22px;font-size:16px;font-weight:800;background:#81b64c;color:#fff;border-radius:10px;box-shadow:0 3px 0 #5d8f36;opacity:0;transform:translateY(8px);transition:opacity .6s .4s,transform .6s .4s,background .12s}
#spec.show #back{opacity:1;transform:none;pointer-events:auto}#back:hover{background:#8fc457}#back:active{transform:translateY(2px) !important;box-shadow:0 1px 0 #5d8f36}
#bldtip{position:fixed;z-index:8;display:none;width:118px;max-width:calc(100vw - 20px);background:rgba(18,18,18,.92);border:1px solid rgba(255,255,255,.24);border-radius:9px;padding:7px 8px;box-shadow:0 7px 22px rgba(0,0,0,.3);transform:translate(-50%,-50%);pointer-events:auto;text-align:center}
#bldtip.show{display:block}#bldtip b{display:block;font-size:13px;margin-bottom:3px}#bldtip small{display:block;font-size:11px;opacity:.8;margin:2px 0}#bldtip button{pointer-events:auto;margin-top:7px;width:100%;padding:6px 10px;border-radius:7px;background:#81b64c;color:#fff;font-weight:900;font-size:12px;box-shadow:0 2px 0 #5d8f36}#bldtip button:hover{background:#8fc457}
#toast{position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:4;font-weight:700;font-size:16px;opacity:0;transition:opacity .3s;text-shadow:0 1px 4px #000}#toast.show{opacity:1}
`;

function pageHtml(mode) {
  const g = mode === 'battlegrid' ? GRID : mode === 'pieces' ? PWP : KOTK;
  const cfg = { mode, title: MODES[mode].title, nav: NAV, pieces: BAL.pieces, g, kv: KV, tagEmoji: TAG_EMOJI, usePng: ICONS.usePng };
  const json = JSON.stringify(cfg).replace(/</g, '\\u003c');
  return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no"><title>Chess.io - ' + MODES[mode].title + '</title><style>' + CSS + '</style></head><body>' +
    '<div id="fade"></div>' +
    '<canvas id="bg"></canvas><canvas id="game"></canvas>' +
    '<div id="menu"><div class="card"><div class="logo">Chess<span>.io</span></div><div class="sub" id="modeTitle"></div>' +
    '<input id="name" maxlength="16" placeholder="Nickname" autocomplete="off"><div class="row" id="kings"></div>' +
    '<div class="lab">Board style</div><div class="themes" id="themes"></div><button id="play">Play</button><div class="lab">Other games</div><div class="gcards" id="nav"></div></div></div>' +
    '<div id="hud"><div id="lb" class="shadowtxt"><h4>Leaderboard - ELO</h4><div id="lbrows"></div><div id="killCounter">Kills <b id="killValue">0</b></div></div><div id="stats" class="shadowtxt"></div>' +
    '<input id="chatin" maxlength="80" placeholder="Say something..." autocomplete="off">' +
    '<div id="mmw"><canvas id="mm"></canvas></div><div id="bar"></div><div id="bldtip"></div><div id="toast"></div>' +
    '<div id="spec"><div id="specText"></div><button id="back">BACK TO MAIN MENU</button></div></div>' +
    '<script>window.__MENU_PIECES=' + JSON.stringify(MANIFEST.pieces || {}).replace(/</g,'\u003c') + ';</script><script>(' + titleIntroAnimation.toString() + ')();</script><script>window.__CFG=' + json + ';(' + clientMain.toString() + ')();</script></body></html>';
}

const arg = (process.argv[2] || '').toLowerCase();

// `node chessio.js selftest` runs the headless test registry (see SUPER CHESS TEST
// HARNESS section) and exits - no server, no assets, no ports opened.
if (arg === 'selftest') {
  const ok = runTests();
  process.exit(ok ? 0 : 1);
}

bootClassic();

function bootClassic() {
  if (!MODES[arg]) {
    console.log('Usage: node chessio.js <battlegrid|kings|pieces|selftest> [port]');
    process.exit(1);
  }
  const PORT = +process.argv[3] || +process.env.PORT || MODES[arg].port;
  // Update NAV URLs to use the actual port
  const baseUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
  // For production, use the Render service URLs. For local, use localhost with respective ports
  if (process.env.RENDER_EXTERNAL_URL) {
    // In production, each service has its own URL
    NAV = [
      ['battlegrid', 'Battle Grid', 'https://chess-io-battlegrid.onrender.com', 'p', 0],
      ['kings', 'Battle of the Kings', 'https://chess-io-kings.onrender.com', 'k', 0],
      ['pieces', 'Pieces with Pieces', 'https://chess-io-pieces.onrender.com', 'n', 0],
      ['superchess', 'Super Chess', '', 'q', 1]
    ];
  } else {
    // Local development
    NAV = [
      ['battlegrid', 'Battle Grid', 'http://localhost:3000', 'p', 0],
      ['kings', 'Battle of the Kings', 'http://localhost:3001', 'k', 0],
      ['pieces', 'Pieces with Pieces', 'http://localhost:3002', 'n', 0],
      ['superchess', 'Super Chess', '', 'q', 1]
    ];
  }
  MANIFEST = scanAssets();
  const GAME = new ({ battlegrid: BattleGrid, kings: Kings, pieces: Pieces }[arg])();
  if (process.env.CHESSIO_TEST) { global.__GAME = GAME; global.__FakeConn = FakeConn; global.__registerTest = registerTest; global.__runTests = runTests; }
  const HTML = pageHtml(arg);
  const server = http.createServer((req, res) => {
    let p = '/'; try { p = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch (e) { }
    if (p === '/' || p === '/index.html') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(HTML); }
    else if (p === '/assets/manifest.json') { res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(MANIFEST)); }
    else if (p.startsWith('/assets/pieces/')) serveAsset(PIECES_DIR, p.slice(15), res);
    else if (p.startsWith('/assets/tags/')) serveAsset(TAGS_DIR, p.slice(13), res);
    else if (p === '/debug/assets') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(debugAssetsPage()); }
    else { res.writeHead(404); res.end('not found'); }
  });
  server.on('upgrade', (req, sock) => {
    const key = req.headers['sec-websocket-key'];
    if (!key || !String(req.url).startsWith('/ws')) { sock.destroy(); return; }
    sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64') + '\r\n\r\n');
    GAME.connect(new WS(sock));
  });
  server.on('error', e => { console.error(e.code === 'EADDRINUSE' ? 'Port ' + PORT + ' is already in use (is this game already running?)' : e); process.exit(1); });
  server.listen(PORT, () => {
    console.log('\n  CHESS.IO - ' + MODES[arg].title + '  ->  http://localhost:' + PORT);
    logAssets(MANIFEST);
    console.log('  (open http://localhost:' + PORT + '/debug/assets to check image matching)\n');
  });
  process.on('uncaughtException', e => console.error('uncaught:', e));}
