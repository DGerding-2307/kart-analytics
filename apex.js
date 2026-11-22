/*
 * Kart Analytics – logger voor Apex Timing (Karting Emmen, Kartcentrum Lelystad)
 *
 * Apex Timing stuurt via een WebSocket regels als "sleutel|klasse|waarde":
 *   init|r|             nieuwe verbinding of nieuwe sessie
 *   grid||<tbody>…      de hele tabel (HTML), met kopregel c1..cN → kolomtype (rk, no, dr, llp, blp, tlp, …)
 *   r128c6|ti|1:20.674  één cel van rij r128 bijgewerkt (hier: laatste ronde)
 *   r128|#|3            nieuwe positie van rij r128
 *   r128|*|80674|       rij r128 kwam over de streep
 *   title1/title2||…    naam van de sessie, light|lg| (groen), lf (finish), …
 *
 * Een ronde wordt opgeslagen als het rondenummer (kolom tlp) omhoog gaat en de laatste rondetijd (llp)
 * is bijgewerkt. De eerste tabel na het verbinden geldt als nulpunt: rondes die al gereden waren
 * (of een sessie die al afgelopen is) worden niet met de verkeerde tijd opgeslagen.
 */
"use strict";

/** "1:20.674" / "59.123" -> ms; anders 0 */
function lapMs(s) {
  const m = /^(?:(\d+):)?(\d+(?:[.,]\d+)?)$/.exec(String(s || "").trim());
  if (!m) return 0;
  const ms = Math.round(((Number(m[1]) || 0) * 60 + parseFloat(m[2].replace(",", "."))) * 1000);
  return ms > 0 ? ms : 0;
}

const plain = (html) => String(html || "").replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").trim();
// "DAYVEN H." -> "Dayven H."
const niceName = (s) => plain(s).toLowerCase().replace(/(^|[\s\-'.])(\p{L})/gu, (_, a, b) => a + b.toUpperCase());

function createApexParser(onLap) {
  const st = { cols: {}, rows: new Map(), title1: "", title2: "", light: "", baseline: true };
  const colOf = (type) => Object.keys(st.cols).find((c) => st.cols[c] === type);
  const row = (rid) => {
    if (!st.rows.has(rid)) st.rows.set(rid, { cells: {}, seen: null, lastLlp: null, star: false });
    return st.rows.get(rid);
  };
  const sessionName = () => [st.title1, st.title2].map(plain).filter(Boolean).join(" ") || "Sessie";
  const info = (r) => ({
    driver: niceName(r.cells[colOf("dr")]),
    kart: plain(r.cells[colOf("no")]),
    pos: Number(plain(r.cells[colOf("rk")])) || null,
    laps: Number(plain(r.cells[colOf("tlp")])) || 0,
    last: lapMs(plain(r.cells[colOf("llp")])),
    best: lapMs(plain(r.cells[colOf("blp")])),
    gap: plain(r.cells[colOf("gap")]),
    int: plain(r.cells[colOf("int")]),
  });

  function parseGrid(html) {
    const cols = {};
    for (const m of html.matchAll(/data-id="c(\d+)"[^>]*data-type="(\w+)"/g)) cols["c" + m[1]] = m[2];
    if (Object.keys(cols).length) st.cols = cols;
    const present = new Set();
    for (const m of html.matchAll(/data-id="(r\d+)c(\d+)"[^>]*>([\s\S]*?)<\/(?:td|div|p)>/g)) {
      row(m[1]).cells["c" + m[2]] = m[3];
      present.add(m[1]);
    }
    for (const rid of [...st.rows.keys()]) if (!present.has(rid)) st.rows.delete(rid);
    return present;
  }

  /** nieuwe ronde? (alleen na het nulpunt) */
  function check(rid, now) {
    const r = st.rows.get(rid);
    if (!r) return 0;
    const i = info(r);
    const llpText = plain(r.cells[colOf("llp")]);
    const hasLapCol = !!colOf("tlp");
    if (r.seen == null || st.baseline) {
      r.seen = hasLapCol ? i.laps : 0;
      r.lastLlp = llpText;
      r.star = false;
      return 0;
    }
    if (hasLapCol && i.laps < r.seen) r.seen = i.laps; // nieuwe sessie in dezelfde rij
    const fresh = llpText !== r.lastLlp || r.star;
    const lapNo = hasLapCol ? i.laps : r.seen + 1;
    if (!fresh || lapNo <= r.seen || !i.last) return 0;
    r.seen = lapNo;
    r.lastLlp = llpText;
    r.star = false;
    onLap({ session: sessionName(), participant: Number(rid.slice(1)), driver: i.driver, kart: i.kart, lapNo, lapMs: i.last, pos: i.pos, now });
    return 1;
  }

  function handle(raw, now = Date.now()) {
    const dirty = new Set();
    let added = 0;
    for (const line of String(raw).split("\n")) {
      if (!line) continue;
      const p = line.split("|");
      const [k, cls = "", val = ""] = p;
      if (k === "init") {
        st.baseline = true;
        st.rows.clear();
      } else if (k === "grid") {
        for (const rid of parseGrid(p.slice(2).join("|"))) dirty.add(rid);
      } else if (k === "title1" || k === "title2") {
        if (plain(val) !== plain(st[k])) for (const r of st.rows.values()) r.seen = st.baseline ? r.seen : 0;
        st[k] = val;
      } else if (k === "light") {
        st.light = cls;
      } else if (/^r\d+c\d+$/.test(k)) {
        const [, rid, c] = /^(r\d+)(c\d+)$/.exec(k);
        row(rid).cells[c] = val;
        dirty.add(rid);
      } else if (/^r\d+$/.test(k) && cls === "*") {
        row(k).star = true;
        dirty.add(k);
      }
    }
    for (const rid of dirty) added += check(rid, now);
    if (st.baseline && st.rows.size) st.baseline = false;
    return added;
  }

  /** zelfde vorm als het SMS-Timing-bericht, zodat het scherm hetzelfde kan tonen */
  function snapshot() {
    const D = [...st.rows].map(([rid, r]) => {
      const i = info(r);
      return { D: Number(rid.slice(1)), P: i.pos, N: i.driver, K: i.kart, L: i.laps, T: i.last || null, B: i.best || null, G: i.gap || null, I: i.int || null };
    }).filter((d) => d.N);
    return { N: sessionName(), light: st.light, D };
  }

  return { handle, snapshot, state: st };
}

/** WebSocket-verbinding met automatisch opnieuw verbinden */
function createApexLogger({ id = "apex", url, log, onLap, watchdogMs = 10 * 60000 }) {
  const say = (...a) => log(`[${id}]`, ...a);
  const parser = createApexParser((lap) => {
    try {
      if (onLap(lap)) live.lapsLogged++;
    } catch (e) {
      say("ronde opslaan mislukt", e.message);
    }
  });
  const live = { state: "starting", connectedSince: null, lastMessage: null, lastLap: null, lapsLogged: 0, reconnects: 0 };
  let ws = null, retry = 0, timer = null, dog = null, stopped = false;

  function connect() {
    timer = null;
    if (stopped) return;
    live.state = "connecting";
    try {
      ws = new WebSocket(url);
    } catch (e) {
      say("websocket fout", e.message);
      return later();
    }
    const sock = ws;
    const openTimeout = setTimeout(() => {
      if (sock.readyState !== 1) {
        try { sock.close(); } catch (_) {}
        later();
      }
    }, 20000);
    sock.onopen = () => {
      clearTimeout(openTimeout);
      retry = 0;
      live.state = "open";
      live.connectedSince = Date.now();
      say("verbonden met Apex Timing");
    };
    sock.onmessage = (ev) => {
      if (sock !== ws) return;
      live.lastMessage = Date.now();
      const n = parser.handle(typeof ev.data === "string" ? ev.data : Buffer.from(ev.data).toString());
      if (n) live.lastLap = live.lastMessage;
    };
    sock.onerror = (e) => {
      if (sock !== ws) return;
      clearTimeout(openTimeout);
      say("websocket fout", e && e.message ? e.message : "");
      later();
    };
    sock.onclose = () => {
      clearTimeout(openTimeout);
      if (sock !== ws) return;
      live.state = "closed";
      later();
    };
  }

  function later() {
    if (timer || stopped) return;
    if (ws && ws.readyState === 1) return;
    live.state = "wachten";
    live.reconnects++;
    timer = setTimeout(connect, Math.min(60000, 2000 * 2 ** Math.min(retry++, 5)));
  }

  return {
    live,
    snapshot: parser.snapshot,
    handle: parser.handle, // voor tests: berichten zonder verbinding verwerken
    start() {
      connect();
      // buiten openingstijden stuurt Apex niets; na lange stilte gewoon opnieuw verbinden
      dog = setInterval(() => {
        if (live.state === "open" && Date.now() - (live.lastMessage || live.connectedSince) > watchdogMs) {
          const old = ws;
          ws = null;
          live.state = "closed";
          try { old.close(); } catch (_) {}
          later();
        }
      }, 60000);
    },
    stop() {
      stopped = true;
      clearInterval(dog);
      try { ws && ws.close(); } catch (_) {}
    },
  };
}

module.exports = { createApexParser, createApexLogger, lapMs, niceName };
