/*
 * Kart Analytics – logger + backend
 *
 * - Luistert 24/7 naar de live timing van SMS-Timing (WebSocket) en slaat elke ronde op in SQLite.
 * - Biedt een API en een analysescherm (public/index.html) op http://<server>:PORT
 *
 * Geen externe pakketten: alleen ingebouwde Node.js-modules (Node 22.13+ / 24).
 */
"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const CFG = {
  port: Number(process.env.PORT || 8095),
  wsUrl: process.env.WS_URL || "wss://webserver7.sms-timing.com:10015/",
  resourceKey: process.env.RESOURCE_KEY || "26932@kartenfunfabriek",
  dbPath: process.env.DB_PATH || "/data/kart.db",
  publicDir: process.env.PUBLIC_DIR || path.join(__dirname, "public"),
  watchdogMs: Number(process.env.WATCHDOG_MS || 90000),
  // rondes langzamer dan dit tellen nooit als schone ronde (volwassenen)
  cleanMaxMs: Number(process.env.CLEAN_MAX_MS || 40000),
};
const VERSION = "2.0.1";

const log = (...a) => console.log(new Date().toISOString(), ...a);

/* ------------------------------------------------------------------ */
/* Database                                                            */
/* ------------------------------------------------------------------ */

fs.mkdirSync(path.dirname(CFG.dbPath), { recursive: true });
const db = new DatabaseSync(CFG.dbPath);
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
CREATE TABLE IF NOT EXISTS heats (
  id INTEGER PRIMARY KEY,
  key TEXT UNIQUE NOT NULL,
  name TEXT,
  heat_no INTEGER,
  grp TEXT,
  sched_ts INTEGER,
  first_seen INTEGER,
  last_seen INTEGER
);
CREATE TABLE IF NOT EXISTS laps (
  id INTEGER PRIMARY KEY,
  heat_id INTEGER NOT NULL REFERENCES heats(id),
  ts INTEGER NOT NULL,
  participant INTEGER NOT NULL,
  driver TEXT,
  kart TEXT,
  lap_no INTEGER NOT NULL,
  lap_ms INTEGER NOT NULL,
  pos INTEGER,
  UNIQUE (heat_id, participant, lap_no)
);
CREATE INDEX IF NOT EXISTS laps_kart ON laps(kart);
CREATE INDEX IF NOT EXISTS laps_driver ON laps(driver);
CREATE INDEX IF NOT EXISTS laps_ts ON laps(ts);
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS people (key TEXT PRIMARY KEY, name TEXT, person_id TEXT NOT NULL, seen INTEGER);
`);

const q = {
  heatByKey: db.prepare("SELECT id FROM heats WHERE key = ?"),
  heatInsert: db.prepare("INSERT INTO heats (key, name, heat_no, grp, sched_ts, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?)"),
  heatSeen: db.prepare("UPDATE heats SET last_seen = ? WHERE id = ?"),
  lapInsert: db.prepare(
    "INSERT OR IGNORE INTO laps (heat_id, ts, participant, driver, kart, lap_no, lap_ms, pos) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ),
  metaSet: db.prepare("INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v"),
};

/* ------------------------------------------------------------------ */
/* Logger                                                              */
/* ------------------------------------------------------------------ */

const live = {
  state: "starting",
  connectedSince: null,
  lastMessage: null,
  lastSnapshot: null,
  lapsLogged: 0,
  reconnects: 0,
};
const seen = new Map(); // heatKey|participant -> last lap number
let currentHeat = null; // { key, id }

function parseHeatName(name) {
  const s = String(name || "");
  const no = (s.match(/(\d+)/) || [])[1];
  const grp = /kid/i.test(s) ? "Kids" : /volwassen/i.test(s) ? "Volwassenen" : "Overig";
  return { heatNo: no ? Number(no) : null, grp };
}

/*
 * Een heat herkennen we aan dag + heatnaam ("33 - Volwassenen").
 * Komt dezelfde naam op dezelfde dag na meer dan 20 minuten stilte terug, dan is het een nieuwe heat.
 */
const HEAT_GAP_MS = 20 * 60000;
const heatLastSeen = db.prepare("SELECT id, key, last_seen FROM heats WHERE key = ? OR key LIKE ? ORDER BY id DESC LIMIT 1");
function heatId(msg, now) {
  const name = String(msg.N || "").trim() || "Onbekend";
  const base = `${dayKey(now)}|${name}`;
  if (currentHeat && currentHeat.base === base && now - currentHeat.last < HEAT_GAP_MS) {
    currentHeat.last = now;
    if (now - currentHeat.saved > 10000) {
      q.heatSeen.run(now, currentHeat.id);
      currentHeat.saved = now;
    }
    return currentHeat.id;
  }
  let row = heatLastSeen.get(base, `${base}#%`);
  if (!row || now - Number(row.last_seen) >= HEAT_GAP_MS) {
    const key = row ? `${base}#${now}` : base;
    const { heatNo, grp } = parseHeatName(name);
    const r = q.heatInsert.run(key, name, heatNo, grp, Number(msg.T) || null, now, now);
    row = { id: Number(r.lastInsertRowid) };
    log("nieuwe heat", key);
  } else {
    q.heatSeen.run(now, row.id);
  }
  currentHeat = { base, id: Number(row.id), last: now, saved: now };
  if (seen.size > 5000) seen.clear();
  return currentHeat.id;
}

function handleMessage(raw, now = Date.now()) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch (_) {
    return 0;
  }
  live.lastMessage = now;
  live.lastSnapshot = msg;
  const drivers = Array.isArray(msg.D) ? msg.D : [];
  if (!drivers.length) return 0;
  const hid = heatId(msg, now);
  let added = 0;
  for (const d of drivers) {
    const pid = Number(d.D);
    const lapNo = Number(d.L) || 0;
    const lapMs = Number(d.T) || 0;
    if (!pid || lapNo < 1 || lapMs <= 0) continue;
    const k = `${hid}|${pid}`;
    const prev = seen.get(k) || 0;
    if (lapNo <= prev) continue;
    seen.set(k, lapNo);
    // d.T is de tijd van de zojuist voltooide ronde (lapNo). Gemiste tussenrondes kunnen we niet reconstrueren.
    const r = q.lapInsert.run(hid, now, pid, String(d.N || ""), String(d.K || ""), lapNo, lapMs, Number(d.P) || null);
    if (r.changes) added++;
  }
  live.lapsLogged += added;
  if (added) cacheBust();
  return added;
}

let ws = null;
let retry = 0;
let watchdog = null;

let reconnectTimer = null;
function connect() {
  reconnectTimer = null;
  live.state = "connecting";
  try {
    ws = new WebSocket(CFG.wsUrl);
  } catch (e) {
    log("websocket fout", e.message);
    return scheduleReconnect();
  }
  const sock = ws;
  // als de verbinding binnen 20 s niet open is: opnieuw proberen
  const openTimeout = setTimeout(() => {
    if (sock.readyState !== 1) {
      log("verbinden duurt te lang");
      try {
        sock.close();
      } catch (_) {}
      scheduleReconnect();
    }
  }, 20000);
  ws.onopen = () => {
    clearTimeout(openTimeout);
    retry = 0;
    live.state = "open";
    live.connectedSince = Date.now();
    ws.send(`START ${CFG.resourceKey}`);
    log("verbonden met live timing");
  };
  ws.onmessage = (ev) => {
    if (sock !== ws) return;
    const data = typeof ev.data === "string" ? ev.data : Buffer.from(ev.data).toString();
    handleMessage(data);
  };
  ws.onerror = (e) => {
    if (sock !== ws) return;
    log("websocket fout", e && e.message ? e.message : "");
    clearTimeout(openTimeout);
    scheduleReconnect();
  };
  ws.onclose = () => {
    clearTimeout(openTimeout);
    if (sock !== ws) return;
    live.state = "closed";
    log("verbinding gesloten");
    scheduleReconnect();
  };
}

function scheduleReconnect() {
  if (reconnectTimer) return; // al gepland
  if (ws && ws.readyState === 1) return;
  live.state = "wachten";
  const delay = Math.min(60000, 2000 * 2 ** Math.min(retry++, 5));
  live.reconnects++;
  reconnectTimer = setTimeout(connect, delay);
}

function startWatchdog() {
  watchdog = setInterval(() => {
    if (live.state === "open" && live.lastMessage && Date.now() - live.lastMessage > CFG.watchdogMs) {
      log("geen berichten meer ontvangen, opnieuw verbinden");
      try {
        ws.close();
      } catch (_) {}
      live.state = "closed";
      ws = null;
      scheduleReconnect();
    }
  }, 15000);
}

/* ------------------------------------------------------------------ */
/* Analyse                                                             */
/* ------------------------------------------------------------------ */

const median = (a) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
const std = (a) => {
  if (a.length < 2) return null;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
};
const pct = (a, p) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.max(0, Math.round((p / 100) * (s.length - 1))))];
};

let cache = { at: 0, key: "", data: null };
function cacheBust() {
  cache.at = 0;
}

/**
 * Laadt rondes en markeert ze:
 *  - out:    eerste ronde (uitrijden / start)
 *  - yellow: veel karts tegelijk traag (gele vlag, crash, stilstand)
 *  - slow:   ronde ver boven het eigen niveau in die heat (spin, botsing)
 *  - clean:  geen van bovenstaande
 */
function loadLaps({ since = 0, until = 0, grp = "Volwassenen" } = {}) {
  const key = `${since}|${until}|${grp}`;
  if (cache.data && cache.key === key && Date.now() - cache.at < 60000) return cache.data;
  const rows = db
    .prepare(
      `SELECT l.id, l.heat_id, l.ts, l.participant, l.driver, l.kart, l.lap_no, l.lap_ms, l.pos,
              h.name AS heat_name, h.heat_no, h.grp, h.sched_ts
       FROM laps l JOIN heats h ON h.id = l.heat_id
       WHERE l.ts >= ? AND l.ts < ? AND (? = 'Alle' OR h.grp = ?)
       ORDER BY l.ts`
    )
    .all(since, until || 8.64e15, grp, grp);

  const byHeat = new Map();
  for (const r of rows) {
    if (!byHeat.has(r.heat_id)) byHeat.set(r.heat_id, []);
    byHeat.get(r.heat_id).push(r);
  }
  for (const laps of byHeat.values()) {
    // mediaan per deelnemer (zonder eerste ronde)
    const per = new Map();
    for (const l of laps) {
      if (l.lap_no <= 1) continue;
      if (!per.has(l.participant)) per.set(l.participant, []);
      per.get(l.participant).push(l.lap_ms);
    }
    const pmed = new Map([...per].map(([p, a]) => [p, median(a)]));
    for (const l of laps) {
      const m = pmed.get(l.participant);
      l.rel = m ? l.lap_ms / m : null;
    }
    // gele vlag: in een venster van 25 s is meer dan de helft van de rondes > 15% boven eigen mediaan
    for (const l of laps) {
      const win = laps.filter((x) => Math.abs(x.ts - l.ts) <= 25000 && x.rel);
      const slowShare = win.length ? win.filter((x) => x.rel > 1.15).length / win.length : 0;
      l.flag = l.lap_no <= 1 ? "out" : win.length >= 3 && slowShare > 0.5 ? "yellow" : l.rel && l.rel > 1.12 ? "slow" : "clean";
      // vaste grens: boven 40,0 s is geen schone ronde (niet bij kids)
      if (l.flag === "clean" && l.grp !== "Kids" && l.lap_ms > CFG.cleanMaxMs) l.flag = "slow";
    }
    const clean = laps.filter((l) => l.flag === "clean").map((l) => l.lap_ms);
    const hmed = median(clean);
    for (const l of laps) l.heatRel = hmed ? l.lap_ms / hmed : null; // t.o.v. de heat (omstandigheden)
  }
  cache = { at: Date.now(), key, data: rows };
  return rows;
}

/*
 * Regressiemodel (vaste effecten, ridge):
 *   rondetijd = gemiddelde + coureur + kart + rondenummer (opwarmen banden) + ruis
 * (indoorbaan: geen correctie voor weer of baanomstandigheden)
 * Opgelost met backfitting. Kleine groepen worden naar 0 getrokken (ridge), zodat een kart of coureur
 * met weinig rondes niet meteen bovenaan of onderaan staat.
 */
let modelCache = { key: "", at: 0, data: null };
function fitModel(opts) {
  const key = `${opts.since || 0}|${opts.until || 0}|${opts.grp}`;
  if (modelCache.data && modelCache.key === key && Date.now() - modelCache.at < 60000) return modelCache.data;
  const rows = loadLaps(opts).filter((r) => r.flag === "clean" && r.lap_no >= 2 && r.driver && r.kart);
  const n = rows.length;
  const empty = { n: 0, mean: 0, sigma: 0, r2: 0, karts: new Map(), drivers: new Map() };
  if (n < 30) return (modelCache = { key, at: Date.now(), data: empty }).data;
  const lapKey = (l) => String(Math.min(l, 15));
  const F = [
    { name: "driver", key: (r) => r.driver, lambda: 3, center: false },
    { name: "kart", key: (r) => r.kart, lambda: 8, center: true },
    { name: "lap", key: (r) => lapKey(r.lap_no), lambda: 20, center: true },
  ];
  const y = rows.map((r) => r.lap_ms);
  const mu = y.reduce((a, b) => a + b, 0) / n;
  const idx = F.map((f) => rows.map(f.key));
  const eff = F.map(() => new Map());
  const pred = (i) => mu + F.reduce((s, f, j) => s + (eff[j].get(idx[j][i]) || 0), 0);
  for (let it = 0; it < 40; it++) {
    let change = 0;
    F.forEach((f, j) => {
      const sum = new Map(), cnt = new Map();
      for (let i = 0; i < n; i++) {
        const k = idx[j][i];
        const r = y[i] - pred(i) + (eff[j].get(k) || 0);
        sum.set(k, (sum.get(k) || 0) + r);
        cnt.set(k, (cnt.get(k) || 0) + 1);
      }
      const next = new Map([...sum].map(([k, v]) => [k, v / (cnt.get(k) + f.lambda)]));
      if (f.center) {
        // gewogen centreren: het gemiddelde effect is 0 (een 'gemiddelde kart', 'gemiddelde heat')
        let tot = 0;
        for (const [k, v] of next) tot += v * cnt.get(k);
        const c = tot / n;
        for (const [k, v] of next) next.set(k, v - c);
      }
      for (const [k, v] of next) change = Math.max(change, Math.abs(v - (eff[j].get(k) || 0)));
      eff[j] = next;
      f.cnt = cnt;
    });
    if (change < 0.5) break; // < 0,5 ms verschil: klaar
  }
  let sse = 0, sst = 0;
  for (let i = 0; i < n; i++) {
    sse += (y[i] - pred(i)) ** 2;
    sst += (y[i] - mu) ** 2;
  }
  const sigma = Math.sqrt(sse / Math.max(1, n - 1));
  const out = (j) =>
    new Map([...eff[j]].map(([k, v]) => [k, { effect: v, se: sigma / Math.sqrt(F[j].cnt.get(k) + F[j].lambda), n: F[j].cnt.get(k) }]));
  const lapEff = Object.fromEntries([...eff[2]].map(([k, v]) => [k, Math.round(v)]));
  const data = { n, mean: mu, sigma, r2: sst ? 1 - sse / sst : 0, karts: out(1), drivers: out(0), laps: lapEff };
  modelCache = { key, at: Date.now(), data };
  return data;
}

function modelSummary(opts) {
  const m = fitModel(opts);
  const rnd = (x) => Math.round(x);
  return {
    laps: m.n,
    sigmaMs: rnd(m.sigma),
    r2: Math.round(m.r2 * 1000) / 1000,
    meanMs: rnd(m.mean),
    lapEffectMs: m.laps,
    karts: [...m.karts].map(([kart, e]) => ({ kart, effectMs: rnd(e.effect), seMs: rnd(e.se), laps: e.n })).sort((a, b) => a.effectMs - b.effectMs),
    drivers: [...m.drivers]
      .map(([driver, e]) => ({ driver, ratingMs: rnd(m.mean + e.effect), seMs: rnd(e.se), laps: e.n }))
      .sort((a, b) => a.ratingMs - b.ratingMs),
  };
}

function kartStats(opts) {
  const rows = loadLaps(opts);
  const clean = rows.filter((r) => r.flag === "clean");
  const overallMed = median(clean.map((r) => r.lap_ms)) || 0;
  const model = fitModel(opts);

  // coureur-niveau (op basis van heat-relatieve tijden), om kart-effect los van rijvaardigheid te schatten
  const drv = new Map();
  for (const r of clean) {
    if (!r.driver || !r.heatRel) continue;
    if (!drv.has(r.driver)) drv.set(r.driver, { rels: [], karts: new Set() });
    const d = drv.get(r.driver);
    d.rels.push(r.heatRel);
    d.karts.add(r.kart);
  }
  const skill = new Map([...drv].map(([n, d]) => [n, { s: median(d.rels), multi: d.karts.size >= 2 }]));

  const karts = new Map();
  for (const r of rows) {
    if (!r.kart) continue;
    if (!karts.has(r.kart)) karts.set(r.kart, { kart: r.kart, all: [], clean: [], rel: [], corr: [], drivers: new Set(), heats: new Set(), last: 0, flags: {} });
    const k = karts.get(r.kart);
    k.all.push(r.lap_ms);
    k.flags[r.flag] = (k.flags[r.flag] || 0) + 1;
    k.heats.add(r.heat_id);
    k.last = Math.max(k.last, r.ts);
    if (r.flag !== "clean") continue;
    k.clean.push(r.lap_ms);
    k.drivers.add(r.driver);
    if (r.heatRel) k.rel.push(r.heatRel - 1);
    const sk = skill.get(r.driver);
    if (sk && sk.multi && r.heatRel) k.corr.push(r.heatRel - sk.s);
  }
  const out = [...karts.values()].map((k) => ({
    kart: k.kart,
    laps: k.all.length,
    cleanLaps: k.clean.length,
    heats: k.heats.size,
    drivers: k.drivers.size,
    best: k.clean.length ? Math.min(...k.clean) : null,
    worst: k.clean.length ? Math.max(...k.clean) : null,
    mean: mean(k.clean),
    median: median(k.clean),
    p10: pct(k.clean, 10),
    std: std(k.clean),
    // positief = langzamer dan gemiddeld, in ms per ronde
    heatIndexMs: k.rel.length ? median(k.rel) * overallMed : null,
    driverCorrectedMs: model.karts.has(k.kart) ? Math.round(model.karts.get(k.kart).effect) : null,
    seMs: model.karts.has(k.kart) ? Math.round(model.karts.get(k.kart).se) : null,
    corrSamples: k.corr.length,
    lastUsed: k.last,
    flags: k.flags,
  }));
  out.sort((a, b) => (a.driverCorrectedMs ?? a.heatIndexMs ?? 1e9) - (b.driverCorrectedMs ?? b.heatIndexMs ?? 1e9));
  return { overallMedian: overallMed, karts: out };
}

function dayKey(ts) {
  return new Date(ts).toLocaleDateString("sv-SE", { timeZone: process.env.TZ || "Europe/Amsterdam" });
}

function kartDetail(kart, opts) {
  const rows = loadLaps(opts).filter((r) => r.kart === kart);
  const days = new Map();
  for (const r of rows) {
    if (r.flag !== "clean") continue;
    const d = dayKey(r.ts);
    if (!days.has(d)) days.set(d, []);
    days.get(d).push(r.lap_ms);
  }
  const daily = [...days].map(([day, a]) => ({ day, laps: a.length, best: Math.min(...a), median: median(a), mean: mean(a), worst: Math.max(...a) }));
  return {
    kart,
    laps: rows.map((r) => ({ ts: r.ts, ms: r.lap_ms, driver: r.driver, heat: r.heat_name, lap: r.lap_no, flag: r.flag })),
    daily,
  };
}

function driverStats(opts) {
  const rows = loadLaps(opts);
  const m = new Map();
  for (const r of rows) {
    if (!r.driver) continue;
    if (!m.has(r.driver)) m.set(r.driver, { driver: r.driver, laps: 0, clean: [], karts: new Set(), heats: new Set(), last: 0 });
    const d = m.get(r.driver);
    d.laps++;
    d.heats.add(r.heat_id);
    d.karts.add(r.kart);
    d.last = Math.max(d.last, r.ts);
    if (r.flag === "clean") d.clean.push(r.lap_ms);
  }
  const model = fitModel(opts);
  return mergeRecords([...m.values()]
    .map((d) => {
      const e = model.drivers.get(d.driver);
      return {
        key: nameKey(d.driver), driver: d.driver, laps: d.laps, heats: d.heats.size, karts: d.karts.size,
        best: d.clean.length ? Math.min(...d.clean) : null, median: median(d.clean), std: std(d.clean), last: d.last,
        // regressie: verwachte rondetijd in een gemiddelde kart, op een warme ronde
        rating: e ? Math.round(model.mean + e.effect) : null,
        ratingSe: e ? Math.round(e.se) : null,
      };
    })
    // ranglijst op basis van de regressie; coureurs zonder schone rondes achteraan
    .concat([])
    , opts).sort((a, b) => (a.rating ?? 1e9) - (b.rating ?? 1e9) || (a.best ?? 1e9) - (b.best ?? 1e9));
}

const scoreMs = (sc) => {
  const p = String(sc ?? "").trim().replace(",", ".").split(":");
  const sec = parseFloat(p.pop());
  const min = p.length ? parseInt(p[0], 10) : 0;
  const ms = Math.round((min * 60 + sec) * 1000);
  return isFinite(ms) && ms > 0 ? ms : 0;
};
/** opgeslagen SMS-Timing-records (beste rondes van vóór de logger) samenvoegen met de eigen gegevens */
function mergeRecords(list, opts) {
  const scg = { Volwassenen: "117858", Kids: "117860" }[opts.grp];
  const recs = db.prepare("SELECT rows FROM sms_records" + (scg ? " WHERE k LIKE ?" : "")).all(...(scg ? [`${scg}|%`] : []));
  const byKey = new Map(list.map((d) => [nameKey(d.driver), d]));
  for (const r of recs) {
    for (const row of JSON.parse(r.rows) || []) {
      const ms = scoreMs(row.score);
      const ts = new Date(row.date).getTime();
      const k = nameKey(row.participant);
      if (!ms || !k || !isFinite(ts)) continue;
      if (ts < (opts.since || 0) || (opts.until && ts >= opts.until)) continue;
      const d = byKey.get(k);
      if (d) {
        if (!d.best || ms < d.best) Object.assign(d, { best: ms, bestSrc: "SMS-Timing", bestKart: row.kart ?? null, bestAt: ts });
        d.personId = d.personId || String(row.personId || "");
      } else {
        const n = { key: k, driver: row.participant, laps: 0, heats: 0, karts: 0, best: ms, median: null, std: null, last: ts, rating: null, ratingSe: null,
          bestSrc: "SMS-Timing", bestKart: row.kart ?? null, bestAt: ts, personId: String(row.personId || "") };
        byKey.set(k, n);
        list.push(n);
      }
    }
  }
  return list;
}

function driverDetail(name, opts) {
  const rows = loadLaps(opts).filter((r) => r.driver === name);
  const perKart = new Map();
  for (const r of rows) {
    if (r.flag !== "clean") continue;
    if (!perKart.has(r.kart)) perKart.set(r.kart, []);
    perKart.get(r.kart).push(r.lap_ms);
  }
  const heats = new Map();
  for (const r of rows) {
    if (!heats.has(r.heat_id)) heats.set(r.heat_id, { heat: r.heat_name, ts: r.ts, kart: r.kart, laps: [] });
    heats.get(r.heat_id).laps.push({ lap: r.lap_no, ms: r.lap_ms, flag: r.flag });
  }
  return {
    driver: name,
    karts: [...perKart].map(([kart, a]) => ({ kart, laps: a.length, best: Math.min(...a), median: median(a) })).sort((a, b) => a.best - b.best),
    heats: [...heats.values()].sort((a, b) => b.ts - a.ts),
  };
}

function conditions(opts) {
  const rows = loadLaps(opts).filter((r) => r.flag === "clean" && r.heatRel);
  const hours = Array.from({ length: 24 }, () => []);
  const wd = Array.from({ length: 7 }, () => []);
  const fmt = new Intl.DateTimeFormat("en-GB", { timeZone: process.env.TZ || "Europe/Amsterdam", hour: "numeric", weekday: "short", hour12: false });
  const days = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
  for (const r of rows) {
    const parts = Object.fromEntries(fmt.formatToParts(new Date(r.ts)).map((p) => [p.type, p.value]));
    hours[Number(parts.hour) % 24].push(r.lap_ms);
    wd[days[parts.weekday]].push(r.lap_ms);
  }
  const s = (a) => ({ laps: a.length, median: median(a), best: a.length ? Math.min(...a) : null });
  // ronde-in-heat: hoe snel wordt men gemiddeld per ronde (opwarmen banden/baan)
  const byLap = new Map();
  for (const r of rows) {
    if (!byLap.has(r.lap_no)) byLap.set(r.lap_no, []);
    byLap.get(r.lap_no).push(r.heatRel);
  }
  return {
    hours: hours.map(s),
    weekdays: wd.map(s),
    lapInHeat: [...byLap].sort((a, b) => a[0] - b[0]).filter(([, a]) => a.length >= 5).map(([lap, a]) => ({ lap, rel: median(a), n: a.length })),
  };
}

function heatList(opts) {
  const rows = loadLaps(opts);
  const m = new Map();
  for (const r of rows) {
    if (!m.has(r.heat_id)) m.set(r.heat_id, { id: r.heat_id, name: r.heat_name, ts: r.ts, drivers: new Set(), laps: 0, best: null, yellow: 0 });
    const h = m.get(r.heat_id);
    h.ts = Math.min(h.ts, r.ts);
    h.drivers.add(r.participant);
    h.laps++;
    if (r.flag === "yellow") h.yellow++;
    if (r.flag === "clean" && (!h.best || r.lap_ms < h.best.ms)) h.best = { ms: r.lap_ms, driver: r.driver, kart: r.kart };
  }
  return [...m.values()].map((h) => ({ ...h, drivers: h.drivers.size })).sort((a, b) => b.ts - a.ts);
}

function heatDetail(id) {
  const rows = loadLaps({ since: 0, grp: "Alle" }).filter((r) => r.heat_id === id);
  const p = new Map();
  for (const r of rows) {
    if (!p.has(r.participant)) p.set(r.participant, { driver: r.driver, kart: r.kart, laps: [] });
    p.get(r.participant).laps.push({ lap: r.lap_no, ms: r.lap_ms, flag: r.flag, pos: r.pos });
  }
  return { id, name: rows[0] ? rows[0].heat_name : "", participants: [...p.values()] };
}

function summary() {
  const c = db.prepare("SELECT COUNT(*) n, MIN(ts) first, MAX(ts) last, COUNT(DISTINCT kart) karts, COUNT(DISTINCT driver) drivers FROM laps").get();
  const h = db.prepare("SELECT COUNT(*) n FROM heats").get();
  return {
    version: VERSION,
    logger: { ...live, lastSnapshot: undefined },
    totals: { laps: c.n, heats: h.n, karts: c.karts, drivers: c.drivers, first: c.first, last: c.last },
    dbSizeBytes: fs.existsSync(CFG.dbPath) ? fs.statSync(CFG.dbPath).size : 0,
    photos: fs.existsSync(photoDir) && fs.readdirSync(photoDir).some((f) => f.endsWith(".jpg")),
  };
}

/* ------------------------------------------------------------------ */
/* Profielfoto's (via de app-API, met cache op schijf)                 */
/* ------------------------------------------------------------------ */

const photoDir = path.join(path.dirname(CFG.dbPath), "photos");

/** foto's komen alleen nog uit de opgeslagen cache (geen verbinding met SMS-Timing meer) */
async function photo(pid, size) {
  if (!fs.existsSync(photoDir)) return null;
  const exact = path.join(photoDir, `${pid}_${size}.jpg`);
  if (fs.existsSync(exact)) return fs.readFileSync(exact);
  const any = fs.readdirSync(photoDir).filter((f) => f.startsWith(`${pid}_`) && f.endsWith(".jpg"));
  return any.length ? fs.readFileSync(path.join(photoDir, any[0])) : null;
}

/* ------------------------------------------------------------------ */
/* Namen koppelen aan personId (uit de klassementen), voor foto's      */
/* ------------------------------------------------------------------ */

// "Dennis Gerding" / "danny e." -> "dennis g." / "danny e."
function nameKey(n) {
  const w = String(n || "").trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!w.length) return "";
  return w.length === 1 ? w[0] : `${w[0]} ${w[w.length - 1].charAt(0)}.`;
}
try {
  db.exec("ALTER TABLE people ADD COLUMN ever_pos INTEGER");
} catch (_) {}
const peoplePos = db.prepare("UPDATE people SET ever_pos = ? WHERE key = ?");
const peopleUpsert = db.prepare(
  "INSERT INTO people (key, name, person_id, seen) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET name = excluded.name, person_id = excluded.person_id, seen = excluded.seen"
);
let peopleCache = null;
function peopleMap() {
  if (!peopleCache) peopleCache = Object.fromEntries(db.prepare("SELECT key, person_id FROM people").all().map((r) => [r.key, r.person_id]));
  return peopleCache;
}
/** namen ↔ personId en plek 'ooit' uit de opgeslagen SMS-klassementen */
function refreshPeople() {
  let n = 0;
  for (const r of db.prepare("SELECT k, rows FROM sms_records").all()) {
    const [scg, per] = r.k.split("|");
    for (const row of JSON.parse(r.rows) || []) {
      const k = nameKey(row.participant);
      if (!k || !row.personId) continue;
      peopleUpsert.run(k, String(row.participant), String(row.personId), Date.now());
      if (per === "ever" && scg === "117858" && Number(row.position) > 0) peoplePos.run(Number(row.position), k);
      n++;
    }
  }
  peopleCache = null;
  return n;
}

function driverNumbers() {
  const out = {};
  const rank = driverStats({ since: 0, grp: "Volwassenen" }).filter((d) => d.best);
  rank.forEach((d, i) => {
    const k = nameKey(d.driver);
    if (k && !out[k]) out[k] = { sms: null, log: i + 1 };
  });
  for (const r of db.prepare("SELECT key, ever_pos FROM people WHERE ever_pos IS NOT NULL").all()) {
    out[r.key] = { ...(out[r.key] || { log: null }), sms: r.ever_pos };
  }
  return out;
}
function liveWithPeople() {
  const snap = live.lastSnapshot;
  if (!snap || !Array.isArray(snap.D)) return snap;
  const m = peopleMap();
  return { ...snap, D: snap.D.map((d) => ({ ...d, PID: m[nameKey(d.N)] || null })) };
}

/* ------------------------------------------------------------------ */
/* HTTP                                                                */
/* ------------------------------------------------------------------ */

function sinceFrom(params) {
  if (params.get("since")) return Number(params.get("since")) || 0;
  const p = params.get("period") || "all";
  const days = { "1d": 1, "7d": 7, "30d": 30, "90d": 90, "365d": 365 }[p];
  return days ? Date.now() - days * 86400000 : 0;
}

function send(res, code, body, type = "application/json; charset=utf-8") {
  res.writeHead(code, {
    "Content-Type": type,
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-store",
  });
  res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

/* ------------------------------------------------------------------ */
/* SMS-Timing-gegevens (met jouw sleutels) opslaan en samenvoegen      */
/* ------------------------------------------------------------------ */

db.exec(`
CREATE TABLE IF NOT EXISTS sms_heats (session_id TEXT PRIMARY KEY, date TEXT, name TEXT, meta TEXT, details TEXT, laps TEXT, fetched INTEGER);
CREATE TABLE IF NOT EXISTS sms_records (k TEXT PRIMARY KEY, rows TEXT, fetched INTEGER);
`);
try {
  db.exec("ALTER TABLE heats ADD COLUMN sms_session TEXT");
} catch (_) {}
const smsHeatGet = db.prepare("SELECT * FROM sms_heats WHERE session_id = ?");
const smsHeatPut = db.prepare(
  "INSERT INTO sms_heats (session_id, date, name, meta, details, laps, fetched) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET meta = excluded.meta, details = COALESCE(excluded.details, sms_heats.details), laps = COALESCE(excluded.laps, sms_heats.laps), fetched = excluded.fetched"
);
const smsRecPut = db.prepare("INSERT INTO sms_records (k, rows, fetched) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET rows = excluded.rows, fetched = excluded.fetched");

/** zet een opgeslagen SMS-heat om naar de eigen tabellen (als de logger die heat niet al heeft) */
function mergeSmsHeat(row) {
  if (!row || !row.details || !row.laps) return;
  const det = JSON.parse(row.details);
  const laps = JSON.parse(row.laps);
  if (!Array.isArray(laps) || !laps.length) return;
  const start = new Date(det.date || row.date).getTime();
  if (!isFinite(start)) return;
  const name = String(det.name || row.name || "").trim();
  const day = dayKey(start);
  const exists = db.prepare("SELECT id, sms_session FROM heats WHERE key = ? OR key LIKE ? OR sms_session = ?").all(`${day}|${name}`, `${day}|${name}#%`, String(row.session_id));
  if (exists.length) {
    for (const h of exists) if (!h.sms_session) db.prepare("UPDATE heats SET sms_session = ? WHERE id = ?").run(String(row.session_id), h.id);
    return; // de logger had deze heat al (met alle deelnemers)
  }
  const { heatNo, grp } = parseHeatName(name);
  const r = q.heatInsert.run(`sms|${row.session_id}`, name, heatNo, grp, start, start, start);
  const hid = Number(r.lastInsertRowid);
  db.prepare("UPDATE heats SET sms_session = ? WHERE id = ?").run(String(row.session_id), hid);
  const parts = new Map((det.participants || []).map((p) => [String(p.id), p]));
  const cum = new Map();
  for (const l of [...laps].sort((a, b) => a.lapNumber - b.lapNumber)) {
    const p = parts.get(String(l.participantId)) || {};
    const first = String(p.firstName || l.firstName || "").trim();
    const last = String(p.name || l.lastName || "").trim();
    const driver = (first ? first.charAt(0).toUpperCase() + first.slice(1) : "") + (last ? ` ${last.charAt(0).toUpperCase()}.` : "");
    const t = (cum.get(l.participantId) || 0) + Number(l.LapTimeMs || 0);
    cum.set(l.participantId, t);
    q.lapInsert.run(hid, start + t, Number(l.participantId), driver, null, Number(l.lapNumber), Number(l.LapTimeMs), Number(l.position) || null);
  }
  cacheBust();
}

/** gegevens die de Home Assistant-kaart eerder bewaarde, eenmalig overnemen */
function importArchive(a) {
  let heats = 0, recs = 0;
  for (const [id, e] of Object.entries((a && a.heats) || {})) {
    if (!/^\d+$/.test(id) || !e) continue;
    const have = smsHeatGet.get(id);
    if (have && have.details && have.laps) continue;
    const meta = e.meta || {};
    smsHeatPut.run(id, meta.date || (e.details && e.details.date) || null, meta.name || (e.details && e.details.name) || null, JSON.stringify(meta),
      e.details ? JSON.stringify(e.details) : null, Array.isArray(e.laps) && e.laps.length ? JSON.stringify(e.laps) : null, Date.now());
    mergeSmsHeat(smsHeatGet.get(id));
    heats++;
  }
  const groups = { 117858: 1, 117860: 1 };
  for (const [k, e] of Object.entries((a && a.rankings) || {})) {
    const [g, per] = k.split("|");
    if (!groups[g] || !e || !Array.isArray(e.rows)) continue;
    const cur = db.prepare("SELECT fetched FROM sms_records WHERE k = ?").get(k);
    const at = new Date(e.at || 0).getTime() || 0;
    if (cur && cur.fetched >= at) continue;
    smsRecPut.run(k, JSON.stringify(e.rows), at);
    recs++;
  }
  refreshPeople();
  return { heats, records: recs };
}

function smsRecords(group, period) {
  const r = db.prepare("SELECT rows, fetched FROM sms_records WHERE k = ?").get(`${group}|${period}`);
  return r ? { rows: JSON.parse(r.rows), fetched: r.fetched } : { rows: null, fetched: null };
}

/**
 * Heats van jou (alle SMS-heats + logger-heats onder jouw namen) en van gevolgde coureurs.
 * names = jouw namen, follow = namen van gevolgde coureurs (gescheiden door |)
 */
function personalHeats(names, follow) {
  const me = new Set(names.map(nameKey).filter(Boolean));
  const fol = new Map(follow.map((n) => [nameKey(n), n]).filter(([k]) => k));
  const rows = loadLaps({ since: 0, grp: "Alle" });
  const heats = new Map();
  for (const r of rows) {
    const k = nameKey(r.driver);
    const isMe = me.has(k), f = fol.get(k);
    if (!isMe && !f) continue;
    if (!heats.has(r.heat_id)) heats.set(r.heat_id, { id: r.heat_id, name: r.heat_name, ts: r.ts, who: new Map() });
    const h = heats.get(r.heat_id);
    h.ts = Math.min(h.ts, r.ts);
    const label = isMe ? "JIJ" : f;
    if (!h.who.has(label)) h.who.set(label, { me: isMe, name: isMe ? r.driver : f, best: 0, pos: null, lastLap: 0 });
    const w = h.who.get(label);
    if (r.lap_no > 1 && r.lap_ms > 0 && (!w.best || r.lap_ms < w.best)) w.best = r.lap_ms;
    if (r.lap_no >= w.lastLap) { w.lastLap = r.lap_no; w.pos = r.pos; }
  }
  // SMS-heats zijn altijd van jou (ook als de naam anders gespeld is)
  const smsMap = new Map(db.prepare("SELECT id, sms_session FROM heats WHERE sms_session IS NOT NULL").all().map((x) => [x.id, x.sms_session]));
  for (const row of db.prepare("SELECT * FROM sms_heats").all()) {
    const meta = row.meta ? JSON.parse(row.meta) : {};
    const hid = [...smsMap].find(([, s]) => s === String(row.session_id));
    const id = hid ? hid[0] : null;
    const key = id ?? `s${row.session_id}`;
    if (!heats.has(key)) heats.set(key, { id: key, name: row.name, ts: new Date(row.date).getTime(), who: new Map() });
    const h = heats.get(key);
    const w = h.who.get("JIJ") || { me: true, name: "JIJ", best: 0, pos: null, lastLap: 0 };
    const b = Number(meta.bestTimeMs) || 0;
    if (b && (!w.best || b < w.best)) w.best = b;
    if (meta.finishPosition) w.pos = meta.finishPosition;
    h.who.set("JIJ", w);
  }
  return [...heats.values()]
    .map((h) => ({ id: h.id, name: h.name, ts: h.ts, who: [...h.who.values()].map(({ lastLap, ...w }) => w) }))
    .sort((a, b) => b.ts - a.ts);
}

/** uitslag + rondes van één heat (logger of SMS), met personId waar bekend */
function heatFull(id) {
  let sessionId = null, base = null;
  if (/^s\d+$/.test(String(id))) sessionId = String(id).slice(1);
  else {
    base = heatDetail(Number(id));
    const h = db.prepare("SELECT sms_session, first_seen FROM heats WHERE id = ?").get(Number(id));
    sessionId = h && h.sms_session;
    if (h) base.ts = h.first_seen;
  }
  const row = sessionId ? smsHeatGet.get(sessionId) : null;
  const det = row && row.details ? JSON.parse(row.details) : null;
  const pids = new Map();
  for (const p of (det && det.participants) || []) pids.set(nameKey(`${p.firstName || ""} ${p.name || ""}`), String(p.personId || ""));
  if (base && base.participants.length) {
    return {
      id, name: base.name, ts: base.ts,
      participants: base.participants.map((p) => {
        const best = Math.min(...p.laps.filter((l) => l.lap > 1).map((l) => l.ms).concat([1e12]));
        const last = p.laps.reduce((a, l) => (l.lap >= (a ? a.lap : 0) ? l : a), null);
        return { name: p.driver, kart: p.kart, personId: pids.get(nameKey(p.driver)) || "", best: best < 1e12 ? best : null, pos: last ? last.pos : null, laps: p.laps };
      }),
    };
  }
  if (!det) return { id, name: row ? row.name : "", ts: row ? new Date(row.date).getTime() : null, participants: [] };
  const laps = row.laps ? JSON.parse(row.laps) : [];
  return {
    id, name: det.name, ts: new Date(det.date).getTime(),
    participants: (det.participants || []).map((p) => ({
      name: `${p.firstName || ""} ${p.name || ""}`.trim(), kart: null, personId: String(p.personId || ""),
      best: Number(p.scoreDefault) || null, pos: p.position,
      laps: laps.filter((l) => String(l.participantId) === String(p.id)).sort((a, b) => a.lapNumber - b.lapNumber).map((l) => ({ lap: l.lapNumber, ms: Number(l.LapTimeMs), pos: l.position, flag: "clean" })),
    })),
  };
}

function csv(opts) {
  const rows = loadLaps(opts);
  const head = "tijd,heat,kart,coureur,ronde,rondetijd_ms,positie,markering";
  const esc = (s) => `"${String(s ?? "").replace(/"/g, '""')}"`;
  return [head, ...rows.map((r) => [new Date(r.ts).toISOString(), esc(r.heat_name), esc(r.kart), esc(r.driver), r.lap_no, r.lap_ms, r.pos ?? "", r.flag].join(","))].join("\n");
}

const uploads = new Map();
setInterval(() => {
  for (const [k, v] of uploads) if (Date.now() - v.at > 3600000) uploads.delete(k);
}, 600000).unref();
const server = http.createServer(async (req, res) => {
  if (req.method === "POST" && req.url.split("?")[0] === "/api/import-archive") {
    let body = "";
    for await (const c of req) {
      body += c;
      if (body.length > 20e6) return send(res, 413, { error: "te groot" });
    }
    try {
      return send(res, 200, importArchive(JSON.parse(body)));
    } catch (e) {
      return send(res, 400, { error: e.message });
    }
  }
  // foto als tekst (base64), voor Home Assistant via https (rest_command kan geen plaatjes doorgeven)
  const m64 = /^\/api\/photo64\/(\d{5,25})$/.exec(req.url.split("?")[0]);
  if (m64) {
    const size = Math.min(300, Math.max(40, Number(new URL(req.url, "http://x").searchParams.get("size")) || 100));
    const buf = await photo(m64[1], size).catch(() => null);
    const full = buf ? `data:${buf[0] === 0x89 ? "image/png" : "image/jpeg"};base64,${buf.toString("base64")}` : null;
    // in stukken (voor Home Assistant via Nabu Casa, dat grote berichten niet goed doorgeeft)
    const q = new URL(req.url, "http://x").searchParams;
    if (q.has("chunk")) {
      const len = Math.min(60000, Math.max(4000, Number(q.get("len")) || 20000));
      const parts = full ? Math.ceil(full.length / len) : 0;
      const i = Math.max(0, Number(q.get("chunk")) || 0);
      return send(res, 200, { parts, part: i, data: full ? full.slice(i * len, (i + 1) * len) : null });
    }
    return send(res, 200, { data: full });
  }
  const m = /^\/api\/photo\/(\d{5,25})$/.exec(req.url.split("?")[0]);
  if (m) {
    const size = Math.min(300, Math.max(40, Number(new URL(req.url, "http://x").searchParams.get("size")) || 100));
    const buf = await photo(m[1], size).catch(() => null);
    if (!buf) return send(res, 404, { error: "geen foto" });
    res.writeHead(200, { "Content-Type": "image/jpeg", "Cache-Control": "public, max-age=86400", "Access-Control-Allow-Origin": "*" });
    return res.end(buf);
  }
  try {
    const url = new URL(req.url, "http://x");
    const P = url.searchParams;
    const opts = { since: sinceFrom(P), until: Number(P.get("until")) || 0, grp: P.get("group") || "Volwassenen" };
    const p = url.pathname;
    if (p === "/api/summary") return send(res, 200, summary());
    if (p === "/api/live") return send(res, 200, { state: live.state, at: live.lastMessage, snapshot: liveWithPeople() });
    if (p === "/api/people") return send(res, 200, peopleMap());
    if (p === "/api/numbers") return send(res, 200, driverNumbers());
    if (p === "/api/karts") return send(res, 200, kartStats(opts));
    if (p === "/api/model") return send(res, 200, modelSummary(opts));
    if (p.startsWith("/api/kart/")) return send(res, 200, kartDetail(decodeURIComponent(p.slice(10)), opts));
    if (p === "/api/drivers") return send(res, 200, driverStats(opts));
    if (p.startsWith("/api/driver/")) return send(res, 200, driverDetail(decodeURIComponent(p.slice(12)), opts));
    if (p === "/api/heats") return send(res, 200, heatList(opts));
    if (p === "/api/import-chunk") {
      // archief in stukjes via GET (Home Assistant via Nabu Casa kan geen POST doen)
      const u = String(P.get("u") || ""), i = Number(P.get("i")), n = Number(P.get("n"));
      if (!/^[a-z0-9]{6,40}$/i.test(u) || !(n > 0 && n < 5000) || !(i >= 0 && i < n)) return send(res, 400, { error: "ongeldig" });
      const up = uploads.get(u) || { n, parts: new Array(n), at: Date.now() };
      up.parts[i] = String(P.get("d") || "");
      uploads.set(u, up);
      if (up.parts.filter((x) => x != null).length < n) return send(res, 200, { ok: true, got: i });
      uploads.delete(u);
      const b64 = up.parts.join("").replace(/-/g, "+").replace(/_/g, "/");
      const json = Buffer.from(b64, "base64").toString("utf8");
      return send(res, 200, { done: true, ...importArchive(JSON.parse(json)) });
    }
    if (p === "/api/myheats") return send(res, 200, personalHeats((P.get("names") || "").split("|"), (P.get("follow") || "").split("|").filter(Boolean)));
    if (p.startsWith("/api/heatfull/")) return send(res, 200, heatFull(decodeURIComponent(p.slice(14))));
    if (p === "/api/records") return send(res, 200, smsRecords(P.get("group") || "117858", P.get("period") || "ever"));
    if (p === "/api/sms") return send(res, 200, { heats: db.prepare("SELECT COUNT(*) n FROM sms_heats").get().n, records: db.prepare("SELECT COUNT(*) n FROM sms_records").get().n });
    if (p.startsWith("/api/heat/")) return send(res, 200, heatDetail(Number(p.slice(10))));
    if (p === "/api/conditions") return send(res, 200, conditions(opts));
    if (p === "/api/export.csv") return send(res, 200, csv(opts), "text/csv; charset=utf-8");
    if (p === "/health") return send(res, live.state === "open" ? 200 : 503, { state: live.state });
    // statische bestanden
    const file = path.join(CFG.publicDir, p === "/" ? "index.html" : path.normalize(p).replace(/^(\.\.[/\\])+/, ""));
    if (file.startsWith(CFG.publicDir) && fs.existsSync(file) && fs.statSync(file).isFile()) {
      const ext = path.extname(file);
      const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json" };
      return send(res, 200, fs.readFileSync(file), types[ext] || "application/octet-stream");
    }
    send(res, 404, { error: "niet gevonden" });
  } catch (e) {
    log("fout", e.stack || e.message);
    send(res, 500, { error: e.message });
  }
});

if (require.main === module) {
  server.listen(CFG.port, () => log(`Kart Analytics ${VERSION} op poort ${CFG.port}, database ${CFG.dbPath}`));
  connect();
  startWatchdog();
  refreshPeople();
  const stop = () => {
    log("afsluiten");
    try {
      ws && ws.close();
    } catch (_) {}
    db.close();
    process.exit(0);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

module.exports = { importArchive, personalHeats, heatFull, smsRecords, handleMessage, kartStats, kartDetail, driverStats, driverDetail, conditions, heatList, heatDetail, summary, db };
