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
  // Optioneel: persoonlijke app-sleutels voor profielfoto's. Alleen via omgevingsvariabelen, nooit in de code.
  smsAccessToken: process.env.SMS_ACCESS_TOKEN || "",
  smsDeviceToken: process.env.SMS_DEVICE_TOKEN || "",
  smsVersion: process.env.SMS_VERSION || "6260618 202608281022",
  smsApi: process.env.SMS_API || "https://mobile-api7.sms-timing.com/api",
  smsClient: process.env.SMS_CLIENT || "kartenfunfabriek",
};
const VERSION = "1.3.0";

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
    }
    const clean = laps.filter((l) => l.flag === "clean").map((l) => l.lap_ms);
    const hmed = median(clean);
    for (const l of laps) l.heatRel = hmed ? l.lap_ms / hmed : null; // t.o.v. de heat (omstandigheden)
  }
  cache = { at: Date.now(), key, data: rows };
  return rows;
}

function kartStats(opts) {
  const rows = loadLaps(opts);
  const clean = rows.filter((r) => r.flag === "clean");
  const overallMed = median(clean.map((r) => r.lap_ms)) || 0;

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
    driverCorrectedMs: k.corr.length >= 5 ? median(k.corr) * overallMed : null,
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
  return [...m.values()]
    .map((d) => ({ driver: d.driver, laps: d.laps, heats: d.heats.size, karts: d.karts.size, best: d.clean.length ? Math.min(...d.clean) : null, median: median(d.clean), std: std(d.clean), last: d.last }))
    .sort((a, b) => (a.best ?? 1e9) - (b.best ?? 1e9));
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
    photos: Boolean(CFG.smsAccessToken && CFG.smsDeviceToken),
  };
}

/* ------------------------------------------------------------------ */
/* Profielfoto's (via de app-API, met cache op schijf)                 */
/* ------------------------------------------------------------------ */

const photoDir = path.join(path.dirname(CFG.dbPath), "photos");
const PHOTO_TTL = 7 * 86400000; // foto 7 dagen bewaren
const MISS_TTL = 86400000; // "geen foto" 1 dag onthouden
const photoBusy = new Map();

async function photo(pid, size) {
  if (!CFG.smsAccessToken || !CFG.smsDeviceToken) return null;
  fs.mkdirSync(photoDir, { recursive: true });
  const file = path.join(photoDir, `${pid}_${size}.jpg`);
  const miss = file + ".none";
  const fresh = (f, ttl) => fs.existsSync(f) && Date.now() - fs.statSync(f).mtimeMs < ttl;
  if (fresh(file, PHOTO_TTL)) return fs.readFileSync(file);
  if (fresh(miss, MISS_TTL)) return null;
  if (photoBusy.has(file)) return photoBusy.get(file);
  const job = (async () => {
    try {
      const url = `${CFG.smsApi}/person/picture/${CFG.smsClient}?personId=${pid}&width=${size}&height=${size}`;
      const r = await fetch(url, {
        headers: { "X-Fast-AccessToken": CFG.smsAccessToken, "X-Fast-DeviceToken": CFG.smsDeviceToken, "X-Fast-Version": CFG.smsVersion, Accept: "*/*" },
        signal: AbortSignal.timeout(10000),
      });
      if (r.status === 404) {
        fs.writeFileSync(miss, "");
        return null;
      }
      if (!r.ok) {
        log("foto", pid, "status", r.status);
        return fs.existsSync(file) ? fs.readFileSync(file) : null;
      }
      const buf = Buffer.from(await r.arrayBuffer());
      fs.writeFileSync(file, buf);
      return buf;
    } catch (e) {
      log("foto fout", pid, e.message);
      return fs.existsSync(file) ? fs.readFileSync(file) : null;
    } finally {
      photoBusy.delete(file);
    }
  })();
  photoBusy.set(file, job);
  return job;
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
const peopleUpsert = db.prepare(
  "INSERT INTO people (key, name, person_id, seen) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET name = excluded.name, person_id = excluded.person_id, seen = excluded.seen"
);
let peopleCache = null;
function peopleMap() {
  if (!peopleCache) peopleCache = Object.fromEntries(db.prepare("SELECT key, person_id FROM people").all().map((r) => [r.key, r.person_id]));
  return peopleCache;
}
async function refreshPeople() {
  if (!CFG.smsAccessToken || !CFG.smsDeviceToken) return;
  const rsc = CFG.resourceKey.split("@")[0];
  const now = new Date();
  const day = (d) => new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())).toISOString();
  const monday = new Date(now);
  monday.setDate(now.getDate() - ((now.getDay() + 6) % 7));
  const starts = ["", day(now), day(monday), day(new Date(now.getFullYear(), now.getMonth(), 1)), day(new Date(now.getFullYear(), 0, 1))];
  let n = 0;
  for (const scg of ["117858", "117860"]) {
    for (const st of starts) {
      try {
        const url = `${CFG.smsApi}/ranking/records-v2/${CFG.smsClient}?rscId=${rsc}&scgId=${scg}&sorting=0${st ? `&startDate=${encodeURIComponent(st)}` : ""}`;
        const r = await fetch(url, {
          headers: { "X-Fast-AccessToken": CFG.smsAccessToken, "X-Fast-DeviceToken": CFG.smsDeviceToken, "X-Fast-Version": CFG.smsVersion, Accept: "application/json" },
          signal: AbortSignal.timeout(15000),
        });
        if (!r.ok) continue;
        const rows = await r.json();
        for (const row of Array.isArray(rows) ? rows : []) {
          const k = nameKey(row.participant);
          if (k && row.personId) {
            peopleUpsert.run(k, String(row.participant), String(row.personId), Date.now());
            n++;
          }
        }
      } catch (e) {
        log("klassement ophalen mislukt", e.message);
      }
    }
  }
  peopleCache = null;
  log(`namenlijst bijgewerkt (${n} regels, ${Object.keys(peopleMap()).length} personen)`);
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

function csv(opts) {
  const rows = loadLaps(opts);
  const head = "tijd,heat,kart,coureur,ronde,rondetijd_ms,positie,markering";
  const esc = (s) => `"${String(s ?? "").replace(/"/g, '""')}"`;
  return [head, ...rows.map((r) => [new Date(r.ts).toISOString(), esc(r.heat_name), esc(r.kart), esc(r.driver), r.lap_no, r.lap_ms, r.pos ?? "", r.flag].join(","))].join("\n");
}

const server = http.createServer(async (req, res) => {
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
    if (p === "/api/karts") return send(res, 200, kartStats(opts));
    if (p.startsWith("/api/kart/")) return send(res, 200, kartDetail(decodeURIComponent(p.slice(10)), opts));
    if (p === "/api/drivers") return send(res, 200, driverStats(opts));
    if (p.startsWith("/api/driver/")) return send(res, 200, driverDetail(decodeURIComponent(p.slice(12)), opts));
    if (p === "/api/heats") return send(res, 200, heatList(opts));
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
  // namenlijst voor foto's: bij start en elke 20 minuten (alleen als de sleutels zijn ingesteld)
  setTimeout(refreshPeople, 5000);
  setInterval(refreshPeople, 20 * 60000);
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

module.exports = { handleMessage, kartStats, kartDetail, driverStats, driverDetail, conditions, heatList, heatDetail, summary, db };
