const KART_CARD_VERSION = "2.4.0";
const LIVE_WS_URL = "wss://webserver7.sms-timing.com:10015/";
const LIVE_RESOURCE_KEY = "26932@kartenfunfabriek";
const FOLLOW_STORE = "kart-card-follows";
const KNOWN_STORE = "kart-card-known";
const ARCHIVE_KEY = "kart_card_archive";
const DETAIL_LOOKBACK = 10;
const SCORE_GROUPS = [
{ id: "117858", name: "Volwassenen" },
{ id: "117860", name: "Kids" },
];
const PERIODS = [
{ id: "today", name: "Vandaag" },
{ id: "week", name: "Deze week" },
{ id: "lastweek", name: "Vorige week" },
{ id: "month", name: "Deze maand" },
{ id: "year", name: "Dit jaar" },
{ id: "ever", name: "Ooit" },
];
function esc(s) {
return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function fmtLap(ms) {
const n = Number(ms);
if (!isFinite(n) || n <= 0) return "–";
const totalS = n / 1000;
const m = Math.floor(totalS / 60);
const s = (totalS - m * 60).toFixed(3);
return m > 0 ? `${m}:${s.padStart(6, "0")}` : s;
}
function scoreToMs(score) {
const s = String(score ?? "").trim();
if (!s) return 0;
const parts = s.split(":");
const sec = parseFloat(parts.pop().replace(",", "."));
const min = parts.length ? parseInt(parts[0], 10) : 0;
const ms = Math.round((min * 60 + sec) * 1000);
return isFinite(ms) ? ms : 0;
}
function fmtClock(ms) {
const n = Number(ms);
if (!isFinite(n) || n < 0) return "";
const t = Math.round(n / 1000);
return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
}
function fmtDate(iso, withTime = true) {
const d = new Date(iso);
if (isNaN(d.getTime())) return esc(iso);
const date = d.toLocaleDateString("nl-NL", { weekday: "short", day: "numeric", month: "short" });
if (!withTime) return date;
return `${date} ${d.toLocaleTimeString("nl-NL", { hour: "2-digit", minute: "2-digit" })}`;
}
function fmtDelta(ms) {
const n = Number(ms);
if (!isFinite(n)) return "";
return `${n >= 0 ? "+" : "−"}${(Math.abs(n) / 1000).toFixed(3)}`;
}
function liveName(full) {
const parts = String(full || "").trim().split(/\s+/).filter(Boolean);
if (!parts.length) return "";
const first = parts[0].charAt(0).toUpperCase() + parts[0].slice(1);
if (parts.length === 1) return first;
return `${first} ${parts[parts.length - 1].charAt(0).toUpperCase()}.`;
}
function sameName(a, b) {
const n = (s) => String(s || "").trim().toLowerCase().replace(/\s+/g, " ");
return !!n(a) && n(a) === n(b);
}
function dayStr(d) {
return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}T00:00:00.000Z`;
}
function periodRange(period, now = new Date()) {
const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
const monday = new Date(today);
monday.setDate(today.getDate() - ((today.getDay() + 6) % 7));
switch (period) {
case "today":
return { start_date: dayStr(today), end_date: "" };
case "week":
return { start_date: dayStr(monday), end_date: "" };
case "lastweek": {
const prev = new Date(monday);
prev.setDate(monday.getDate() - 7);
return { start_date: dayStr(prev), end_date: dayStr(monday) };
}
case "month":
return { start_date: dayStr(new Date(today.getFullYear(), today.getMonth(), 1)), end_date: "" };
case "year":
return { start_date: dayStr(new Date(today.getFullYear(), 0, 1)), end_date: "" };
default:
return { start_date: "", end_date: "" };
}
}
function ownRange(period, now = new Date()) {
const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
const monday = new Date(today);
monday.setDate(today.getDate() - ((today.getDay() + 6) % 7));
const t = (d) => d.getTime();
switch (period) {
case "today": return { since: t(today), until: 0 };
case "week": return { since: t(monday), until: 0 };
case "lastweek": { const prev = new Date(monday); prev.setDate(monday.getDate() - 7); return { since: t(prev), until: t(monday) }; }
case "month": return { since: t(new Date(today.getFullYear(), today.getMonth(), 1)), until: 0 };
case "year": return { since: t(new Date(today.getFullYear(), 0, 1)), until: 0 };
default: return { since: 0, until: 0 };
}
}
function fmtAgo(ts) {
if (!ts) return "nooit";
const s = (Date.now() - ts) / 1000;
if (s < 90) return `${Math.round(s)} s geleden`;
if (s < 5400) return `${Math.round(s / 60)} min geleden`;
if (s < 172800) return `${Math.round(s / 3600)} uur geleden`;
return `${Math.round(s / 86400)} dagen geleden`;
}
function storeGet(key) {
try {
const v = window.localStorage.getItem(key);
return v ? JSON.parse(v) : null;
} catch (_) {
return null;
}
}
function storeSet(key, val) {
try {
if (val === null) window.localStorage.removeItem(key);
else window.localStorage.setItem(key, JSON.stringify(val));
} catch (_) {
}
}
class KartCard extends HTMLElement {
constructor() {
super();
this._tab = null;
this._group = null;
this._period = "ever";
this._live = null;
this._wsState = "idle";
this._heats = { data: null, error: null, promise: null };
this._selectedHeat = null;
this._heatCache = {};
this._ranking = {};
this._connected = false;
this._follows = undefined;
this._known = storeGet(KNOWN_STORE) || {};
this._archive = null;
this._offline = false;
this._liveRec = {};
this._ka = {};
this._kaMode = null;
this._rankSrc = "sms";
}
async _loadArchive() {
try {
const r = await this._hass.callWS({ type: "frontend/get_user_data", key: ARCHIVE_KEY });
this._archive = (r && r.value) || {};
} catch (_) {
this._archive = {};
}
const A = this._archive;
A.heats = A.heats || {};
A.rankings = A.rankings || {};
A.live = A.live || {};
if (Array.isArray(A.follows)) {
for (const f of this._follows) if (!A.follows.some((g) => this._matches(g, f.name, f.personId))) A.follows.push(f);
this._follows = A.follows;
} else A.follows = this._follows;
A.known = Object.assign({}, this._known, A.known || {});
this._known = A.known;
storeSet(FOLLOW_STORE, this._follows);
this._saveArchive();
this._render();
}
_saveArchive(delay = 2000) {
if (!this._archive || !this._hass) return;
clearTimeout(this._saveTimer);
this._saveTimer = setTimeout(() => {
this._archive.follows = this._follows;
this._archive.known = this._known;
this._archive.saved = new Date().toISOString();
this._hass.callWS({ type: "frontend/set_user_data", key: ARCHIVE_KEY, value: this._archive }).catch(() => {});
}, delay);
}
_archiveHeats(list) {
if (!this._archive) return;
for (const h of list) {
const e = this._archive.heats[h.id] || (this._archive.heats[h.id] = {});
e.meta = h;
}
this._saveArchive();
}
_archiveHeat(id, details, laps) {
if (!this._archive) return;
const e = this._archive.heats[id] || (this._archive.heats[id] = {});
const myPid = String(this._config.person_id || "");
const keep = new Set((details.participants || []).filter((p) => String(p.personId) === myPid || this._isFollowed(`${p.firstName} ${p.name}`, p.personId)).map((p) => String(p.id)));
e.details = details;
e.laps = (laps || []).filter((l) => keep.has(String(l.participantId)));
this._saveArchive();
}
_heatsFromArchive() {
if (!this._archive) return null;
const list = Object.values(this._archive.heats).map((e) => e.meta).filter(Boolean);
return list.length ? list.sort((a, b) => String(b.date).localeCompare(String(a.date))) : null;
}
// live: rondetijden van jou en gevolgde coureurs vastleggen terwijl de kaart open is
_recordLive() {
const L = this._live;
if (!L || !Array.isArray(L.D) || !L.D.length || !this._archive) return;
const day = new Date().toISOString().slice(0, 10);
let changed = false;
for (const d of L.D) {
const isMe = sameName(d.N, this._myLiveName());
const f = isMe ? null : this._followOfLive(d.N);
if (!isMe && !f) continue;
const key = isMe ? "me" : this._knownKey(f);
const heatKey = `${day} ${L.N || "heat"}`;
const log = this._archive.live[key] || (this._archive.live[key] = []);
let e = log.find((x) => x.heat === heatKey);
if (!e) {
e = { heat: heatKey, name: d.N, date: new Date().toISOString(), laps: [], best: 0, lastLap: 0 };
log.push(e);
if (log.length > 200) log.shift();
}
const lapNo = Number(d.L) || 0;
if (lapNo > e.lastLap && Number(d.T) > 0) {
e.laps.push(Number(d.T));
e.lastLap = lapNo;
changed = true;
}
if (Number(d.B) > 0 && (!e.best || Number(d.B) < e.best)) {
e.best = Number(d.B);
changed = true;
}
}
if (changed) this._saveArchive(10000);
}
static getStubConfig() {
return { person_id: "", driver_name: "" };
}
setConfig(config) {
this._config = Object.assign(
{
title: "Kart en Fun Fabriek",
person_id: "",
driver_name: "",
follow_name: "",
follow_person_id: "",
default_tab: "overview",
score_group: "117858",
analytics_url: "",
},
config || {}
);
if (!this._tab) this._tab = this._config.default_tab === "track" ? "overview" : this._config.default_tab;
if (!this._group) this._group = String(this._config.score_group);
if (this._follows === undefined) {
const stored = storeGet(FOLLOW_STORE);
if (Array.isArray(stored)) this._follows = stored;
else if (this._config.follow_name || this._config.follow_person_id)
this._follows = [{ name: this._config.follow_name, personId: String(this._config.follow_person_id || "") }];
else this._follows = [];
}
if (!this.shadowRoot) {
this.attachShadow({ mode: "open" });
this.shadowRoot.addEventListener("click", (ev) => this._onClick(ev));
}
this._render();
}
set hass(hass) {
const first = !this._hass;
this._hass = hass;
if (first) this._loadArchive().then(() => this._loadForTab());
}
getCardSize() {
return 12;
}
connectedCallback() {
this._connected = true;
this._syncWs();
}
disconnectedCallback() {
this._connected = false;
this._wsStop();
}
async _call(service, data = {}) {
if (!this._hass) throw new Error("Home Assistant is nog niet klaar.");
let r;
try {
r = await this._hass.callWS({
type: "call_service",
domain: "rest_command",
service,
service_data: data,
return_response: true,
});
} catch (e) {
const msg = (e && (e.message || e.code)) || String(e);
throw new Error(`rest_command.${service} werkt niet (${msg}). Staat het in configuration.yaml en is HA herstart?`);
}
const resp = r && r.response;
if (!resp) throw new Error(`Geen antwoord van rest_command.${service}.`);
if (resp.status === 401) throw new Error("Geen toegang (401): de app-sleutels in secrets.yaml kloppen niet of zijn verlopen.");
if (resp.status !== 200) throw new Error(`SMS-Timing gaf foutcode ${resp.status}.`);
let content = resp.content;
if (typeof content === "string") {
try {
content = JSON.parse(content);
} catch (_) {
}
}
return content;
}
_kaBase() {
return String(this._config.analytics_url || `http://${location.hostname}:8095`).replace(/\/+$/, "");
}
_kaGroup() {
const g = SCORE_GROUPS.find((x) => x.id === String(this._config.score_group));
return g ? g.name : "Volwassenen";
}
async _kaFetch(path) {
if (this._kaMode !== "rest" && !(location.protocol === "https:" && this._kaBase().startsWith("http:"))) {
try {
const ctl = new AbortController();
const t = setTimeout(() => ctl.abort(), 6000);
const r = await fetch(`${this._kaBase()}/api/${path}`, { signal: ctl.signal });
clearTimeout(t);
if (r.ok) {
this._kaMode = "direct";
return await r.json();
}
} catch (_) {}
}
try {
const c = await this._call("kart_analytics", { path });
this._kaMode = "rest";
return c;
} catch (_) {
this._kaMode = null;
throw new Error(`Kart Analytics-server niet bereikbaar (${this._kaBase()}).`);
}
}
_kaGet(key, path, maxAge = 60000, force = false) {
const c = this._ka[key] || (this._ka[key] = {});
if (c.promise) return c.promise;
if (!force && c.at && Date.now() - c.at < maxAge) return Promise.resolve(c.data);
c.promise = this._kaFetch(path)
.then((d) => {
c.data = d;
c.error = null;
return d;
})
.catch((e) => {
c.error = e.message;
return c.data || null;
})
.finally(() => {
c.at = Date.now();
c.promise = null;
this._render();
});
return c.promise;
}
_loadAnalytics(force = false) {
const g = encodeURIComponent(this._kaGroup());
this._kaGet("summary", "summary", 15000, force);
this._kaGet("karts", `karts?period=all&group=${g}`, 120000, force);
this._kaGet("drivers", `drivers?period=all&group=${g}`, 60000, force);
}
_ownRankKey() {
return `rank|${this._group}|${this._period}`;
}
_loadOwnRanking(force = false) {
const g = (SCORE_GROUPS.find((x) => x.id === this._group) || {}).name || "Volwassenen";
const r = ownRange(this._period);
this._kaGet(this._ownRankKey(), `drivers?group=${encodeURIComponent(g)}&since=${r.since}${r.until ? `&until=${r.until}` : ""}`, 60000, force);
}
_kaDriver(name) {
const d = this._ka.drivers && this._ka.drivers.data;
if (!Array.isArray(d) || !name) return null;
return d.find((x) => sameName(x.driver, name) || sameName(x.driver, liveName(name))) || null;
}
_wantsLive() {
return this._connected && (this._tab === "live" || this._tab === "overview");
}
_syncWs() {
if (this._wantsLive()) this._wsStart();
else this._wsStop();
}
_wsStart() {
if (this._ws || !this._wantsLive()) return;
clearTimeout(this._retryTimer);
this._wsState = "connecting";
this._renderLiveish();
let ws;
try {
ws = new WebSocket(LIVE_WS_URL);
} catch (_) {
this._wsState = "closed";
this._wsRetry();
return;
}
this._ws = ws;
ws.onopen = () => {
this._retryCount = 0;
this._wsState = "open";
ws.send(`START ${LIVE_RESOURCE_KEY}`);
this._renderLiveish();
};
ws.onmessage = (ev) => {
try {
this._live = JSON.parse(ev.data);
this._liveAt = Date.now();
} catch (_) {
return;
}
this._recordLive();
this._renderLiveish();
};
ws.onerror = () => {
try {
ws.close();
} catch (_) {}
};
ws.onclose = () => {
if (this._ws !== ws) return;
this._ws = null;
this._wsState = "closed";
this._renderLiveish();
this._wsRetry();
};
}
_wsRetry() {
if (!this._wantsLive()) return;
const n = this._retryCount || 0;
const delay = Math.min(30000, 2000 * 2 ** n);
this._retryCount = n + 1;
this._retryTimer = setTimeout(() => this._wsStart(), delay);
}
_wsStop() {
clearTimeout(this._retryTimer);
if (this._ws) {
const ws = this._ws;
this._ws = null;
try {
ws.close();
} catch (_) {}
}
this._wsState = "idle";
}
_renderLiveish() {
if (this._tab === "live" || this._tab === "overview") this._render();
}
_liveDrivers() {
const L = this._live;
return L && Array.isArray(L.D) ? [...L.D].sort((a, b) => (a.P || 99) - (b.P || 99)) : [];
}
_myLiveName() {
return this._config.driver_name || "";
}
_followOfLive(n) {
return this._follows.find((f) => sameName(n, liveName(f.name)) || sameName(n, f.name));
}
_ensureHeats(force = false) {
const h = this._heats;
if (h.promise) return h.promise;
if (h.data && !force) return Promise.resolve(h.data);
h.error = null;
h.promise = this._call("kart_heats")
.then((list) => {
h.data = Array.isArray(list) ? list : [];
this._offline = false;
this._archiveHeats(h.data);
return h.data;
})
.catch((e) => {
const arc = this._heatsFromArchive();
if (arc) {
h.data = arc;
this._offline = true;
return h.data;
}
h.error = e.message;
return null;
})
.finally(() => {
h.promise = null;
this._render();
});
this._render();
return h.promise;
}
_ensureHeat(id) {
const c = this._heatCache[id] || (this._heatCache[id] = {});
if (c.promise) return c.promise;
if (c.details) return Promise.resolve(c);
c.error = null;
c.promise = Promise.all([this._call("kart_heat_details", { session_id: id }), this._call("kart_heat_laps", { session_id: id })])
.then(([details, laps]) => {
c.details = details || {};
c.laps = Array.isArray(laps) ? laps : [];
this._archiveHeat(id, c.details, c.laps);
return c;
})
.catch((e) => {
const a = this._archive && this._archive.heats[id];
if (a && a.details) {
c.details = a.details;
c.laps = a.laps || [];
this._offline = true;
return c;
}
c.error = e.message;
return c;
})
.finally(() => {
c.promise = null;
this._render();
});
return c.promise;
}
_rankKey(group, period) {
return `${group}|${period}`;
}
_ensureRanking(group, period, force = false) {
const key = this._rankKey(group, period);
const c = this._ranking[key] || (this._ranking[key] = {});
if (c.promise) return c.promise;
if (!force && c.at && Date.now() - c.at < 5 * 60 * 1000) return Promise.resolve(c.rows);
c.error = null;
c.promise = this._call("kart_ranking", { score_group: group, ...periodRange(period) })
.then((rows) => {
c.rows = Array.isArray(rows) ? rows : [];
c.at = Date.now();
if (this._archive) {
this._archive.rankings[key] = { rows: c.rows, at: new Date().toISOString() };
this._saveArchive();
}
return c.rows;
})
.catch((e) => {
const a = this._archive && this._archive.rankings[key];
c.at = Date.now();
if (a && a.rows) {
c.rows = a.rows;
c.stale = a.at;
this._offline = true;
return c.rows;
}
c.error = e.message;
return null;
})
.finally(() => {
c.promise = null;
this._render();
});
this._render();
return c.promise;
}
async _loadOverview() {
this._loadAnalytics();
const grp = String(this._config.score_group);
this._ensureRanking(grp, "ever");
this._ensureRanking(grp, "today");
if (this._follows.length) ["week", "lastweek", "month", "year"].forEach((p) => this._ensureRanking(grp, p));
const heats = await this._ensureHeats();
if (heats && this._follows.length) heats.slice(0, DETAIL_LOOKBACK).forEach((h) => this._ensureHeat(h.id));
}
_loadForTab() {
if (!this._hass) return;
if (this._tab === "overview") this._loadOverview();
if (this._tab === "heats") this._ensureHeats();
if (this._tab === "ranking") this._rankSrc === "own" ? this._loadOwnRanking() : this._ensureRanking(this._group, this._period);
if (this._tab === "analytics") this._loadAnalytics();
}
_matches(f, name, personId) {
if (personId && f.personId && String(personId) === String(f.personId)) return true;
return sameName(name, f.name) || sameName(name, liveName(f.name)) || sameName(liveName(name), liveName(f.name)) && !f.personId && !personId;
}
_isFollowed(name, personId) {
return this._follows.some((f) => this._matches(f, name, personId));
}
_addFollow(f) {
if (this._isFollowed(f.name, f.personId)) return;
this._follows = [...this._follows, f];
storeSet(FOLLOW_STORE, this._follows);
if (this._archive) this._archive.follows = this._follows;
this._saveArchive(500);
this._render();
this._loadOverview();
}
_removeFollow(name, personId) {
this._follows = this._follows.filter((f) => !this._matches(f, name, personId));
storeSet(FOLLOW_STORE, this._follows);
if (this._archive) this._archive.follows = this._follows;
this._saveArchive(500);
this._render();
}
_knownKey(f) {
return f.personId ? `p:${f.personId}` : `n:${liveName(f.name).toLowerCase()}`;
}
// beste bekende ronde van een gevolgde coureur, uit alle beschikbare bronnen
_bestFor(f) {
const cands = [];
const pname = (k) => (PERIODS.find((p) => p.id === k) || {}).name || k;
for (const [key, c] of Object.entries(this._ranking)) {
if (!c.rows) continue;
const [grp, per] = key.split("|");
if (grp !== String(this._config.score_group)) continue;
const r = c.rows.find((x) => this._matches(f, x.participant, x.personId));
if (r && scoreToMs(r.score) > 0) cands.push({ ms: scoreToMs(r.score), date: r.date, src: `klassement ${pname(per).toLowerCase()}`, pos: per === "ever" ? r.position : null });
}
for (const h of this._heats.data || []) {
const c = this._heatCache[h.id];
if (!c || !c.details || !Array.isArray(c.details.participants)) continue;
const p = c.details.participants.find((x) => this._matches(f, `${x.firstName} ${x.name}`, x.personId));
if (p && Number(p.scoreDefault) > 0) cands.push({ ms: Number(p.scoreDefault), date: c.details.date, src: `heat ${c.details.name}` });
}
if (this._archive) {
for (const e of Object.values(this._archive.heats)) {
if (!e.details || !Array.isArray(e.details.participants)) continue;
const p = e.details.participants.find((x) => this._matches(f, `${x.firstName} ${x.name}`, x.personId));
if (p && Number(p.scoreDefault) > 0) cands.push({ ms: Number(p.scoreDefault), date: e.details.date, src: `heat ${e.details.name}` });
}
for (const e of this._archive.live[this._knownKey(f)] || []) {
if (e.best > 0) cands.push({ ms: e.best, date: e.date, src: "live opgenomen" });
}
}
const own = this._kaDriver(f.name);
if (own && own.best > 0) cands.push({ ms: own.best, date: new Date(own.last).toISOString(), src: "eigen logger" });
const live = this._liveDrivers().find((d) => this._matches(f, d.N, ""));
if (live && Number(live.B) > 0) cands.push({ ms: Number(live.B), date: new Date().toISOString(), src: "live gezien" });
const key = this._knownKey(f);
const stored = this._known[key];
if (stored && stored.ms > 0) cands.push(stored);
if (!cands.length) return null;
const best = cands.reduce((a, b) => (b.ms < a.ms ? b : a));
const evPos = cands.find((c) => c.pos);
if (!stored || best.ms < stored.ms || (evPos && stored.pos !== evPos.pos)) {
this._known[key] = { ms: best.ms, date: best.date, src: best.src, pos: evPos ? evPos.pos : stored && stored.pos };
storeSet(KNOWN_STORE, this._known);
this._saveArchive();
}
return { ...best, pos: evPos ? evPos.pos : stored && stored.pos };
}
_myBestMs() {
let best = 0;
for (const h of this._heats.data || []) {
const t = Number(h.bestTimeMs);
if (t > 0 && (!best || t < best)) best = t;
}
const ever = this._ranking[this._rankKey(String(this._config.score_group), "ever")];
const me = ever && ever.rows && ever.rows.find((r) => String(r.personId) === String(this._config.person_id));
const t = me ? scoreToMs(me.score) : 0;
if (t > 0 && (!best || t < best)) best = t;
for (const e of (this._archive && this._archive.live.me) || []) if (e.best > 0 && (!best || e.best < best)) best = e.best;
const own = this._kaDriver(this._myLiveName());
if (own && own.best > 0 && (!best || own.best < best)) best = own.best;
return best;
}
_liveLapCount(key) {
const log = (this._archive && this._archive.live[key]) || [];
return log.reduce((s, e) => s + e.laps.length, 0);
}
_followBtn(name, personId) {
if (!name) return "";
const on = this._isFollowed(name, personId);
return `<button class="star ${on ? "on" : ""}" title="${on ? "Niet meer volgen" : "Volg deze coureur"}"
data-action="${on ? "unfollow" : "follow"}" data-name="${esc(name)}" data-pid="${esc(personId || "")}">${on ? "★" : "☆"}</button>`;
}
_onClick(ev) {
const el = ev.target.closest("[data-action]");
if (!el) return;
const a = el.dataset.action;
if (a === "tab") {
this._tab = el.dataset.tab;
this._selectedHeat = this._tab === "heats" ? this._selectedHeat : null;
this._syncWs();
this._render();
this._loadForTab();
} else if (a === "heat") {
this._selectedHeat = el.dataset.id;
this._render();
this._ensureHeat(this._selectedHeat);
} else if (a === "back") {
this._selectedHeat = null;
this._render();
} else if (a === "refresh-heats") {
this._heatCache = {};
this._ensureHeats(true);
} else if (a === "group") {
this._group = el.dataset.group;
this._render();
this._loadForTab();
} else if (a === "period") {
this._period = el.dataset.period;
this._render();
this._loadForTab();
} else if (a === "refresh-ranking") {
if (this._rankSrc === "own") this._loadOwnRanking(true);
else this._ensureRanking(this._group, this._period, true);
} else if (a === "follow") {
ev.stopPropagation();
this._addFollow({ name: el.dataset.name, personId: el.dataset.pid || "" });
} else if (a === "unfollow") {
ev.stopPropagation();
this._removeFollow(el.dataset.name, el.dataset.pid || "");
} else if (a === "ranksrc") {
this._rankSrc = el.dataset.src;
this._render();
this._loadForTab();
} else if (a === "refresh-ka") {
this._loadAnalytics(true);
} else if (a === "goto") {
this._tab = el.dataset.tab;
this._syncWs();
this._render();
this._loadForTab();
}
}
_render() {
if (!this.shadowRoot || !this._config) return;
const tabs = [
{ id: "overview", name: "Overzicht" },
{ id: "live", name: "Live" },
{ id: "heats", name: "Heats" },
{ id: "ranking", name: "Klassement" },
{ id: "analytics", name: "Analyse" },
];
let body = "";
if (this._tab === "overview") body = this._renderOverview();
else if (this._tab === "live") body = this._renderLive();
else if (this._tab === "heats") body = this._renderHeats();
else if (this._tab === "ranking") body = this._renderRanking();
else body = this._renderAnalytics();
const liveOn = this._wsState === "open" && this._liveDrivers().length > 0;
this.shadowRoot.innerHTML = `
<style>${KART_CSS}</style>
<ha-card>
<div class="f1">
<div class="top">
<div class="brand"><span class="redbar"></span><span class="title">${esc(this._config.title)}</span></div>
${liveOn ? `<span class="livepill" data-action="goto" data-tab="live"><span class="pulse"></span>LIVE</span>` : ""}
</div>
<nav class="tabs">
${tabs
.map((t) => `<button class="tab ${t.id === this._tab ? "on" : ""}" data-action="tab" data-tab="${t.id}">${t.name}</button>`)
.join("")}
</nav>
<div class="body">${this._offline ? `<div class="offline">Offline · SMS-Timing niet bereikbaar – opgeslagen gegevens${this._archive && this._archive.saved ? ` (bijgewerkt ${fmtDate(this._archive.saved)})` : ""}</div>` : ""}${body}</div>
</div>
</ha-card>`;
}
_renderOverview() {
const grp = String(this._config.score_group);
const ever = this._ranking[this._rankKey(grp, "ever")] || {};
const today = this._ranking[this._rankKey(grp, "today")] || {};
const heats = this._heats.data;
const myPid = String(this._config.person_id || "");
const record = ever.rows && ever.rows.find((r) => r.position === 1);
const meEver = ever.rows && myPid ? ever.rows.find((r) => String(r.personId) === myPid) : null;
const todayTop = today.rows && today.rows.find((r) => r.position === 1);
let myBest = null;
if (heats && heats.length) {
for (const h of heats) if (Number(h.bestTimeMs) > 0 && (!myBest || Number(h.bestTimeMs) < Number(myBest.bestTimeMs))) myBest = h;
}
const last = heats && heats.length ? heats[0] : null;
const recordMs = record ? scoreToMs(record.score) : 0;
const myBestMs = myBest ? Number(myBest.bestTimeMs) : meEver ? scoreToMs(meEver.score) : 0;
const loading = (x) => (x === undefined ? `<span class="muted">laden…</span>` : x);
const tile = (label, value, sub, cls = "") => `
<div class="tile ${cls}">
<div class="tlabel">${label}</div>
<div class="tvalue">${value}</div>
<div class="tsub">${sub || "&nbsp;"}</div>
</div>`;
const errs = [this._heats.error, ever.error].filter(Boolean);
const errHtml = errs.length ? `<div class="error">${esc(errs[0])}</div>` : "";
const tiles = [
tile(
"Jouw snelste ronde",
myBestMs ? fmtLap(myBestMs) : heats || ever.rows ? "–" : loading(),
myBest ? `${fmtDate(myBest.date, false)} · heat ${esc(myBest.name)}` : "",
"pb"
),
tile(
"Baanrecord",
record ? esc(record.score) : ever.error ? "–" : loading(),
record ? `${esc(record.participant)} · ${fmtDate(record.date, false)}` : "",
"purple"
),
tile(
"Jouw positie ooit",
meEver ? `P${esc(meEver.position)}` : ever.rows ? "–" : loading(),
recordMs && myBestMs ? `${fmtDelta(myBestMs - recordMs)} tot het record` : ""
),
tile(
"Snelste vandaag",
todayTop ? esc(todayTop.score) : today.rows ? "–" : loading(),
todayTop ? esc(todayTop.participant) : today.rows ? "nog niemand gereden" : ""
),
tile(
"Laatste heat",
last ? `P${esc(last.finishPosition ?? "–")}` : heats ? "–" : loading(),
last ? `${esc(last.bestTime)} · ${fmtDate(last.date)}` : ""
),
tile("Heats gereden", heats ? String(heats.length) : loading(), heats && heats.length ? `sinds ${fmtDate(heats[heats.length - 1].date, false)}` : ""),
this._kaKartTile(tile),
].join("");
return `${errHtml}
${this._renderLiveStrip()}
<div class="tiles">${tiles}</div>
${this._renderFollowPanel()}`;
}
_renderLiveStrip() {
const drivers = this._liveDrivers();
const L = this._live;
if (this._wsState !== "open" || !drivers.length) {
const txt = this._wsState === "open" ? "Geen heat bezig" : this._wsState === "connecting" ? "Verbinden met live timing…" : "Live timing niet bereikbaar";
return `<div class="strip"><span class="dot ${this._wsState === "open" ? "ok" : "bad"}"></span>${txt}</div>`;
}
const me = drivers.find((d) => sameName(d.N, this._myLiveName()));
const fols = drivers.filter((d) => !sameName(d.N, this._myLiveName()) && this._followOfLive(d.N));
const lead = drivers[0];
const who = (d, label) => (d ? `<span class="who"><b>P${esc(d.P)}</b> ${label} · ${fmtLap(d.B)}</span>` : "");
return `<div class="strip on" data-action="goto" data-tab="live">
<span class="pulse"></span><b>${esc(L.N || "Heat")}</b><span class="clock-s">${fmtClock(L.C)}</span>
<span class="who">Leider: ${esc(lead.N)}</span>${who(me, "jij")}${fols.map((d) => who(d, esc(d.N))).join("")}
</div>`;
}
_renderFollowPanel() {
if (!this._follows.length) {
return `<div class="follow empty-f">
<div class="fh">Coureurs volgen</div>
<div class="muted">Tik op ☆ naast een naam in Live, Heats of Klassement om iemand te volgen. Je kunt meerdere coureurs volgen.</div>
</div>`;
}
const myPid = String(this._config.person_id || "");
const myBest = this._myBestMs();
const heats = (this._heats.data || []).slice(0, DETAIL_LOOKBACK);
const pending = heats.some((h) => this._heatCache[h.id] && this._heatCache[h.id].promise) || Object.values(this._ranking).some((c) => c.promise);
const cards = this._follows
.map((f) => {
const live = this._liveDrivers().find((d) => this._matches(f, d.N, ""));
const best = this._bestFor(f);
const recLaps = this._liveLapCount(this._knownKey(f));
let shared = 0,
ahead = 0;
for (const h of heats) {
const c = this._heatCache[h.id];
if (!c || !c.details || !Array.isArray(c.details.participants)) continue;
const ps = c.details.participants;
const them = ps.find((p) => this._matches(f, `${p.firstName} ${p.name}`, p.personId));
const me = ps.find((p) => String(p.personId) === myPid);
if (!them || !me || them === me) continue;
shared++;
if ((me.position || 99) < (them.position || 99)) ahead++;
}
let diffHtml = `<div class="tvalue muted">–</div><div class="tsub">${pending ? "zoeken…" : myBest ? "nog geen tijd bekend" : "jouw tijd onbekend"}</div>`;
if (best && myBest) {
const d = best.ms - myBest;
const cls = d > 0 ? "green" : d < 0 ? "red" : "";
const abs = (Math.abs(d) / 1000).toFixed(3);
const txt = d > 0 ? `jij bent ${abs} s sneller` : d < 0 ? `${abs} s sneller dan jij` : "precies gelijk";
diffHtml = `<div class="tvalue ${cls}">${fmtDelta(d)}</div><div class="tsub">${txt}</div>`;
}
const bestHtml = best
? `<div class="tvalue">${fmtLap(best.ms)}</div><div class="tsub">${esc(best.src)} · ${fmtDate(best.date, false)}</div>`
: `<div class="tvalue muted">–</div><div class="tsub">${pending ? "zoeken…" : "niet in een top 10 of gedeelde heat"}</div>`;
return `<div class="fcard ${live ? "islive" : ""}">
<div class="fh"><span class="fname">${esc(f.name)}</span>
${live ? `<span class="fbadge">LIVE P${esc(live.P)}</span>` : ""}
${best && best.pos ? `<span class="fpos">P${esc(best.pos)} ooit</span>` : ""}
${recLaps ? `<span class="fpos">${recLaps} ronden opgeslagen</span>` : ""}
<button class="star on" title="Niet meer volgen" data-action="unfollow" data-name="${esc(f.name)}" data-pid="${esc(f.personId || "")}">★</button></div>
<div class="fgrid">
<div class="fstat"><div class="tlabel">Beste ronde</div>${bestHtml}</div>
<div class="fstat"><div class="tlabel">Verschil met jou</div>${diffHtml}</div>
<div class="fstat ${live ? "live" : ""}"><div class="tlabel">${live ? "Nu live" : "Onderling"}</div>${
live
? `<div class="tvalue">${fmtLap(live.T)}</div><div class="tsub">laatste · beste ${fmtLap(live.B)}</div>`
: shared
? `<div class="tvalue">${ahead}–${shared - ahead}</div><div class="tsub">${shared} gedeelde heat${shared > 1 ? "s" : ""}</div>`
: `<div class="tvalue muted">–</div><div class="tsub">nog niet samen gereden</div>`
}</div>
</div>
</div>`;
})
.join("");
return `<div class="section-h"><span>Gevolgde coureurs</span><span class="muted small">jouw beste: ${fmtLap(myBest)}</span></div>
<div class="follows">${cards}</div>`;
}
_renderLive() {
const st = this._wsState;
const dot = st === "open" ? "ok" : st === "connecting" ? "wait" : "bad";
const stText = st === "open" ? "Live verbonden" : st === "connecting" ? "Verbinden…" : "Geen verbinding – opnieuw proberen…";
const statusLine = `<div class="status"><span class="dot ${dot}"></span>${stText}</div>`;
const L = this._live;
if (!L) return statusLine + `<div class="empty">Wachten op gegevens van de baan…</div>`;
const drivers = this._liveDrivers();
if (!drivers.length) return statusLine + `<div class="empty">Geen races momenteel.<div class="muted">Kom later terug.</div></div>`;
const bests = drivers.map((d) => Number(d.B)).filter((n) => n > 0);
const fastest = bests.length ? Math.min(...bests) : 0;
const rows = drivers
.map((d) => {
const me = sameName(d.N, this._myLiveName());
const fol = !me && !!this._followOfLive(d.N);
const last = Number(d.T);
const best = Number(d.B);
let lastCls = "";
if (last > 0) lastCls = last === fastest ? "purple" : last === best ? "green" : "yellow";
return `<div class="trow ${me ? "me" : ""} ${fol ? "fol" : ""}">
<div class="tpos">${esc(d.P)}</div>
<div class="tname">${esc(d.N)}${me ? `<span class="tag">JIJ</span>` : ""}</div>
<div class="tk">#${esc(d.K)}</div>
<div class="tl">${esc(d.L)}</div>
<div class="tt ${lastCls}">${fmtLap(d.T)}</div>
<div class="tt ${best && best === fastest ? "purple" : ""}">${fmtLap(d.B)}</div>
<div class="tg">${d.P === 1 ? "Leider" : esc(d.G || "")}</div>
<div class="tf">${me ? "" : this._followBtn(d.N, "")}</div>
</div>`;
})
.join("");
return `${statusLine}
<div class="heatbar">
<div class="heatname">${esc(L.N || "Heat")}</div>
<div class="clock">${fmtClock(L.C)}</div>
</div>
<div class="tower">
<div class="trow head"><div class="tpos">P</div><div class="tname">Coureur</div><div class="tk">Kart</div><div class="tl">Rnd</div>
<div class="tt">Laatste</div><div class="tt">Beste</div><div class="tg">Gap</div><div class="tf"></div></div>
${rows}
</div>
<div class="legend"><span class="sw purple"></span>snelste ronde <span class="sw green"></span>eigen beste <span class="sw yellow"></span>langzamer</div>`;
}
_renderHeats() {
if (this._selectedHeat) return this._renderHeatDetail(this._selectedHeat);
const h = this._heats;
if (h.error) return `<div class="error">${esc(h.error)}</div><button class="btn" data-action="refresh-heats">Opnieuw proberen</button>`;
if (!h.data) return `<div class="empty">Heats laden…</div>`;
if (!h.data.length) return `<div class="empty">Nog geen heats gevonden.</div>`;
const bestOverall = Math.min(...h.data.map((x) => Number(x.bestTimeMs)).filter((n) => n > 0));
const items = h.data
.map((x) => {
const pb = Number(x.bestTimeMs) === bestOverall;
const p = Number(x.finishPosition) || 0;
return `<button class="heat" data-action="heat" data-id="${esc(x.id)}">
<div class="pbadge p${p && p <= 3 ? p : 0}">P${esc(x.finishPosition ?? "–")}</div>
<div class="hinfo">
<div class="hname">Heat ${esc(x.name)}</div>
<div class="muted">${fmtDate(x.date)}</div>
</div>
<div class="htime ${pb ? "purpletxt" : ""}">${esc(x.bestTime || fmtLap(x.bestTimeMs))}${pb ? `<div class="muted">persoonlijk record</div>` : ""}</div>
<div class="chev">›</div>
</button>`;
})
.join("");
return `<div class="toolbar"><span class="muted">${h.data.length} heats</span>
<button class="btn small" data-action="refresh-heats">Vernieuwen</button></div>
<div class="heats">${items}</div>`;
}
_renderHeatDetail(id) {
const back = `<button class="btn small" data-action="back">‹ Terug</button>`;
const c = this._heatCache[id];
if (!c || (!c.details && !c.error)) return `${back}<div class="empty">Heat laden…</div>`;
if (c.error) return `${back}<div class="error">${esc(c.error)}</div>`;
const det = c.details || {};
const parts = Array.isArray(det.participants) ? [...det.participants].sort((a, b) => (a.position || 99) - (b.position || 99)) : [];
const myPid = String(this._config.person_id || "");
const mePart = parts.find((p) => String(p.personId) === myPid);
const fastest = Math.min(...parts.map((p) => Number(p.scoreDefault)).filter((n) => n > 0));
const result = parts
.map((p) => {
const me = mePart && p.id === mePart.id;
const name = `${p.firstName || ""} ${p.name || ""}`.trim();
const fol = this._isFollowed(name, p.personId);
return `<div class="trow ${me ? "me" : ""} ${fol ? "fol" : ""}">
<div class="tpos">${esc(p.position)}</div>
<div class="tname">${esc(name)}${me ? `<span class="tag">JIJ</span>` : ""}</div>
<div class="tt ${Number(p.scoreDefault) === fastest ? "purple" : ""}">${Number(p.scoreDefault) > 0 ? esc(p.score) : "–"}</div>
<div class="tg">${Number(p.scoreDefault) > 0 && fastest ? (Number(p.scoreDefault) === fastest ? "" : fmtDelta(Number(p.scoreDefault) - fastest)) : ""}</div>
<div class="tf">${me ? "" : this._followBtn(name, p.personId)}</div>
</div>`;
})
.join("");
let lapsHtml = "";
if (mePart) {
const mine = c.laps.filter((l) => String(l.participantId) === String(mePart.id)).sort((a, b) => a.lapNumber - b.lapNumber);
if (mine.length) {
const times = mine.map((l) => Number(l.LapTimeMs));
const best = Math.min(...times);
const sorted = [...times].sort((a, b) => a - b);
const median = sorted[Math.floor(sorted.length / 2)];
const clean = times.filter((t) => t <= median * 1.15);
const avg = clean.reduce((s, t) => s + t, 0) / clean.length;
const consistency = Math.sqrt(clean.reduce((s, t) => s + (t - avg) ** 2, 0) / clean.length);
lapsHtml = `
<div class="section-h"><span>Jouw rondes</span></div>
<div class="tiles three">
<div class="tile pb"><div class="tlabel">Beste</div><div class="tvalue">${fmtLap(best)}</div><div class="tsub">ronde ${mine[times.indexOf(best)].lapNumber}</div></div>
<div class="tile"><div class="tlabel">Gemiddeld*</div><div class="tvalue">${fmtLap(avg)}</div><div class="tsub">${fmtDelta(avg - best)} op je beste</div></div>
<div class="tile"><div class="tlabel">Constantheid</div><div class="tvalue">±${(consistency / 1000).toFixed(2)}s</div><div class="tsub">spreiding per ronde</div></div>
</div>
${this._lapChart(times, best, median)}
<div class="tower laps">
<div class="trow head"><div class="tpos">Rnd</div><div class="tt">Tijd</div><div class="tg">Δ beste</div><div class="tl">Pos</div></div>
${mine
.map((l) => {
const t = Number(l.LapTimeMs);
const cls = t === best ? "purple" : t <= best + 300 ? "green" : t > median * 1.15 ? "red" : "yellow";
return `<div class="trow"><div class="tpos">${esc(l.lapNumber)}</div><div class="tt ${cls}">${fmtLap(t)}</div>
<div class="tg">${t === best ? "" : fmtDelta(t - best)}</div><div class="tl">P${esc(l.position)}</div></div>`;
})
.join("")}
</div>
<div class="muted small">* gemiddelde zonder uitschieters (rondes &gt; 15% boven je mediaan)</div>`;
}
} else if (myPid) {
lapsHtml = `<div class="muted">Je eigen rondes zijn niet gevonden in deze heat (klopt person_id?).</div>`;
}
return `${back}
<div class="heatbar"><div class="heatname">Heat ${esc(det.name || "")}</div><div class="muted">${fmtDate(det.date)}</div></div>
<div class="section-h"><span>Uitslag</span></div>
<div class="tower">${result}</div>
${lapsHtml}`;
}
_lapChart(times, best, median) {
const W = 600,
H = 170,
P = 30;
const hi = Math.max(best + 1000, median * 1.15);
const lo = best - 300;
const x = (i) => P + (times.length === 1 ? (W - 2 * P) / 2 : (i * (W - 2 * P)) / (times.length - 1));
const y = (t) => 12 + ((Math.min(t, hi) - lo) / (hi - lo)) * (H - 36);
const pts = times.map((t, i) => `${x(i).toFixed(1)},${y(t).toFixed(1)}`).join(" ");
const dots = times
.map((t, i) => {
const cls = t === best ? "cbest" : t > hi ? "cout" : "cdot";
return `<circle class="${cls}" cx="${x(i).toFixed(1)}" cy="${y(t).toFixed(1)}" r="${t === best ? 5 : 3.5}"><title>Ronde ${i + 1}: ${fmtLap(t)}</title></circle>`;
})
.join("");
const yb = y(best).toFixed(1);
const labels = times
.map((_, i) => (times.length <= 20 || i % 2 === 0 ? `<text class="cx" x="${x(i).toFixed(1)}" y="${H - 6}">${i + 1}</text>` : ""))
.join("");
return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Rondetijden">
<line class="cgrid" x1="${P}" x2="${W - P}" y1="${yb}" y2="${yb}"/>
<text class="clabel" x="${W - P}" y="${Number(yb) - 6}" text-anchor="end">${fmtLap(best)}</text>
<polyline class="cline" points="${pts}"/>
${dots}${labels}
</svg>`;
}
_renderRanking() {
const groups = SCORE_GROUPS.map(
(g) => `<button class="chip ${g.id === this._group ? "on" : ""}" data-action="group" data-group="${g.id}">${g.name}</button>`
).join("");
const periods = PERIODS.map(
(p) => `<button class="chip ${p.id === this._period ? "on" : ""}" data-action="period" data-period="${p.id}">${p.name}</button>`
).join("");
const srcs = [["sms", "Top 10 (SMS-Timing)"], ["own", "Volledig (eigen logger)"]]
.map(([id, n]) => `<button class="chip ${this._rankSrc === id ? "on" : ""}" data-action="ranksrc" data-src="${id}">${n}</button>`)
.join("");
const head = `<div class="chips">${srcs}</div><div class="chips">${groups}</div><div class="chips">${periods}</div>`;
if (this._rankSrc === "own") return head + this._renderOwnRanking();
const c = this._ranking[this._rankKey(this._group, this._period)];
if (!c || (!c.rows && !c.error)) return `${head}<div class="empty">Klassement laden…</div>`;
if (c.error) return `${head}<div class="error">${esc(c.error)}</div><button class="btn" data-action="refresh-ranking">Opnieuw proberen</button>`;
if (!c.rows.length) return `${head}<div class="empty">Geen records gevonden.</div>`;
const myPid = String(this._config.person_id || "");
const leaderMs = scoreToMs((c.rows.find((r) => r.position === 1) || {}).score);
let prevPos = 0;
const rows = c.rows
.map((r) => {
const gap = prevPos && r.position - prevPos > 1 ? `<div class="trow gaprow">⋯</div>` : "";
prevPos = r.position;
const me = myPid && String(r.personId) === myPid;
const fol = this._isFollowed(r.participant, r.personId);
const ms = scoreToMs(r.score);
const pc = r.position <= 3 ? ` p${r.position}` : "";
return `${gap}<div class="trow ${me ? "me" : ""} ${fol ? "fol" : ""}">
<div class="tpos${pc}">${esc(r.position)}</div>
<div class="tname">${esc(r.participant)}${me ? `<span class="tag">JIJ</span>` : ""}<div class="muted small">${fmtDate(r.date, false)} · kart ${esc(r.kart ?? "")}</div></div>
<div class="tt ${r.position === 1 ? "purple" : ""}">${esc(r.score)}</div>
<div class="tg">${r.position === 1 || !leaderMs ? "" : fmtDelta(ms - leaderMs)}</div>
<div class="tf">${me ? "" : this._followBtn(r.participant, r.personId)}</div>
</div>`;
})
.join("");
return `${head}
<div class="tower">${rows}</div>
<div class="toolbar"><span class="muted small">Top 10 en de plekken rond jou</span><button class="btn small" data-action="refresh-ranking">Vernieuwen</button></div>`;
}
_kaKartTile(tile) {
const k = this._ka.karts;
if (!k) return "";
const list = k.data && Array.isArray(k.data.karts) ? k.data.karts.filter((x) => (x.driverCorrectedMs ?? x.heatIndexMs) != null) : [];
if (!list.length) return tile("Snelste kart", "–", k.error ? "logger niet bereikbaar" : "logger verzamelt nog data");
const b = list[0], v = b.driverCorrectedMs ?? b.heatIndexMs;
return `<div data-action="goto" data-tab="analytics" style="cursor:pointer">${tile("Snelste kart", `#${esc(b.kart)}`, `${fmtDelta(v)} s/ronde · eigen logger`, "pb")}</div>`;
}
_renderOwnRanking() {
const c = this._ka[this._ownRankKey()];
if (!c || (!c.data && !c.error)) return `<div class="empty">Klassement laden…</div>`;
if (!c.data) return `<div class="error">${esc(c.error)}</div>${this._kaHelp()}`;
const rows = c.data.filter((r) => r.best);
if (!rows.length) return `<div class="empty">In deze periode nog geen rondes gelogd.</div>`;
const lead = rows[0].best;
const myName = this._myLiveName();
const html = rows
.map((r, i) => {
const me = sameName(r.driver, myName);
const fol = !me && this._isFollowed(r.driver, "");
const pc = i < 3 ? ` p${i + 1}` : "";
return `<div class="trow ${me ? "me" : ""} ${fol ? "fol" : ""}">
<div class="tpos${pc}">${i + 1}</div>
<div class="tname">${esc(r.driver)}${me ? `<span class="tag">JIJ</span>` : ""}<div class="muted small">${r.heats} heat${r.heats === 1 ? "" : "s"} · ${r.laps} rondes · ${fmtAgo(r.last)}</div></div>
<div class="tt ${i === 0 ? "purple" : ""}">${fmtLap(r.best)}</div>
<div class="tg">${i === 0 ? "" : fmtDelta(r.best - lead)}</div>
<div class="tf">${me ? "" : this._followBtn(r.driver, "")}</div>
</div>`;
})
.join("");
const sum = this._ka.summary && this._ka.summary.data;
return `<div class="tower">${html}</div>
<div class="toolbar"><span class="muted small">Alle ${rows.length} coureurs die de logger zag${sum && sum.totals.first ? ` (sinds ${fmtDate(new Date(sum.totals.first).toISOString(), false)})` : ""} · alleen schone rondes</span><button class="btn small" data-action="refresh-ranking">Vernieuwen</button></div>`;
}
_kaHelp() {
return `<div class="muted small">Draait de Kart Analytics-server op ${esc(this._kaBase())}? Bekijk je Home Assistant via https, voeg dan <b>rest_command.kart_analytics</b> toe (zie uitleg).</div>`;
}
_renderAnalytics() {
const S = this._ka.summary, K = this._ka.karts;
if (!S || (!S.data && !S.error)) return `<div class="empty">Analyse laden…</div>`;
if (!S.data) return `<div class="error">${esc(S.error)}</div>${this._kaHelp()}`;
const s = S.data, lg = s.logger || {}, t = s.totals || {};
const on = lg.state === "open" && lg.lastMessage && Date.now() - lg.lastMessage < 120000;
const status = `<div class="strip"><span class="dot ${on ? "ok" : lg.state === "open" ? "wait" : "bad"}"></span>
${on ? "Logger live" : lg.state === "open" ? "Logger verbonden · geen heat bezig" : `Logger: ${esc(lg.state)}`}
<span class="who">${(t.laps || 0).toLocaleString("nl-NL")} rondes · ${t.heats || 0} heats · ${t.karts || 0} karts${t.first ? ` · sinds ${fmtDate(new Date(t.first).toISOString(), false)}` : ""}</span></div>`;
const karts = K && K.data && Array.isArray(K.data.karts) ? K.data.karts : [];
const idx = (x) => x.driverCorrectedMs ?? x.heatIndexMs;
const ranked = karts.filter((x) => idx(x) != null);
const base = this._kaBase();
const kRow = (x, i) => {
const v = idx(x);
return `<a class="trow klink" href="${esc(base)}/#kart/${encodeURIComponent(x.kart)}" target="_blank" rel="noopener">
<div class="tpos">${esc(x.kart)}</div>
<div class="tname">${i != null ? `<span class="muted small">#${i + 1}</span> ` : ""}<span class="${v < 0 ? "green" : "red"}">${fmtDelta(v)} s</span><div class="muted small">${x.cleanLaps} schone rondes · ${x.drivers} rijders${x.driverCorrectedMs == null ? " · nog ongecorrigeerd" : ""}</div></div>
<div class="tt purple">${fmtLap(x.best)}</div>
<div class="tt">${fmtLap(x.median)}</div>
</a>`;
};
const head = `<div class="trow head"><div class="tpos">Kart</div><div class="tname">Kart-effect</div><div class="tt">Snelste</div><div class="tt">Mediaan</div></div>`;
let kartHtml;
if (!ranked.length) kartHtml = `<div class="muted">${K && K.error ? esc(K.error) : "Nog te weinig rondes. Na een paar drukke dagen verschijnt hier welke kart het snelst is."}</div>`;
else {
const best = ranked.slice(0, 5), worst = ranked.length > 8 ? ranked.slice(-3).reverse() : [];
kartHtml = `<div class="tower">${head}${best.map((x, i) => kRow(x, i)).join("")}</div>
${worst.length ? `<div class="section-h"><span>Liever niet</span></div><div class="tower">${worst.map((x) => kRow(x, ranked.indexOf(x))).join("")}</div>` : ""}`;
}
const me = this._kaDriver(this._myLiveName());
const meHtml = me
? `<div class="tiles">
<div class="tile pb"><div class="tlabel">Beste ronde</div><div class="tvalue">${fmtLap(me.best)}</div><div class="tsub">eigen logger</div></div>
<div class="tile"><div class="tlabel">Mediaan</div><div class="tvalue">${fmtLap(me.median)}</div><div class="tsub">schone rondes</div></div>
<div class="tile"><div class="tlabel">Constantheid</div><div class="tvalue">±${me.std ? (me.std / 1000).toFixed(2) : "–"}s</div><div class="tsub">spreiding per ronde</div></div>
<div class="tile"><div class="tlabel">Gelogd</div><div class="tvalue">${me.heats}</div><div class="tsub">heats · ${me.laps} rondes in ${me.karts} karts</div></div>
</div>
<a class="btn small" style="display:inline-block;margin-top:8px;text-decoration:none" href="${esc(base)}/#driver/${encodeURIComponent(me.driver)}" target="_blank" rel="noopener">Mijn analyse ↗</a>`
: `<div class="muted">Nog geen rondes van ${esc(this._myLiveName() || "jou")} gelogd.</div>`;
const all = ranked.length
? `<div class="tower">${head}${ranked.map((x, i) => kRow(x, i)).join("")}</div>`
: "";
return `${status}
<div class="section-h"><span>Welke kart kies ik?</span><button class="link" data-action="refresh-ka">Vernieuwen</button></div>
${kartHtml}
<div class="muted small" style="margin-top:6px">Kart-effect = seconden per ronde sneller (−) of langzamer (+) dan een gemiddelde kart, gecorrigeerd voor de coureur en de omstandigheden in de heat.</div>
<div class="section-h"><span>Jij</span></div>
${meHtml}
${ranked.length > 8 ? `<div class="section-h"><span>Alle karts</span></div>${all}` : ""}
<div class="section-h"><span>Meer</span></div>
<a class="btn" style="display:inline-block;text-decoration:none" href="${esc(base)}" target="_blank" rel="noopener">Open volledig analysescherm ↗</a>
<div class="muted small" style="margin-top:6px">Grafieken per kart, per coureur, per heat, opwarmcurve en tijdstip van de dag.${this._kaMode === "rest" ? " (gegevens via Home Assistant)" : ""}</div>`;
}
}
const KART_CSS = `
@import url('https://fonts.googleapis.com/css2?family=Titillium+Web:ital,wght@0,400;0,600;0,700;0,900;1,700;1,900&display=swap');
:host { display:block; --f1-red:#E10600; --f1-bg:#15151E; --f1-panel:#1F1F2A; --f1-panel2:#272733; --f1-line:#38383F;
--f1-text:#F5F5F7; --f1-muted:#9A9AA6; --f1-purple:#A64DFF; --f1-green:#00D26A; --f1-yellow:#FFD12E; --f1-follow:#00A3E0; }
ha-card { overflow:hidden; background:var(--f1-bg); color:var(--f1-text); border:none; }
.f1 { font-family:'Titillium Web', 'Segoe UI', Arial, sans-serif; background:var(--f1-bg); color:var(--f1-text); }
.top { display:flex; align-items:center; justify-content:space-between; padding:14px 16px 10px;
background:linear-gradient(90deg, #15151E 0%, #1d1d28 100%); border-top:4px solid var(--f1-red); }
.brand { display:flex; align-items:center; gap:10px; }
.redbar { width:6px; height:26px; background:var(--f1-red); transform:skewX(-15deg); }
.title { font-weight:900; font-style:italic; text-transform:uppercase; letter-spacing:.5px; font-size:1.2em; }
.livepill { display:flex; align-items:center; gap:6px; background:var(--f1-red); color:#fff; font-weight:900; font-style:italic;
padding:3px 10px; transform:skewX(-12deg); cursor:pointer; font-size:.85em; letter-spacing:1px; }
.pulse { width:8px; height:8px; border-radius:50%; background:#fff; animation:pulse 1.2s infinite; display:inline-block; }
@keyframes pulse { 0%{opacity:1} 50%{opacity:.25} 100%{opacity:1} }
.tabs { display:flex; overflow-x:auto; background:var(--f1-panel); border-bottom:1px solid var(--f1-line); scrollbar-width:none; }
.tab { flex:1 0 auto; background:none; border:none; color:var(--f1-muted); font:inherit; font-weight:700; text-transform:uppercase;
letter-spacing:.6px; font-size:.82em; padding:11px 12px; cursor:pointer; border-bottom:3px solid transparent; }
.tab.on { color:#fff; border-bottom-color:var(--f1-red); }
.body { padding:14px 16px 18px; }
.muted { color:var(--f1-muted); font-weight:400; }
.small { font-size:.8em; }
.offline { padding:8px 12px; border-left:4px solid var(--f1-yellow); background:rgba(255,209,46,.1); color:var(--f1-yellow); margin:0 0 12px; font-size:.85em; }
.error { padding:10px 12px; border-left:4px solid var(--f1-red); background:rgba(225,6,0,.12); margin:0 0 12px; }
.empty { padding:30px 8px; text-align:center; color:var(--f1-muted); }
.btn { background:var(--f1-panel2); border:1px solid var(--f1-line); color:var(--f1-text); font:inherit; font-weight:600; padding:7px 14px; cursor:pointer; }
.btn.small { padding:4px 10px; font-size:.85em; }
.link { background:none; border:none; color:var(--f1-muted); font:inherit; font-size:.85em; cursor:pointer; padding:0; }
.link:hover { color:#fff; }
.toolbar { display:flex; justify-content:space-between; align-items:center; margin:10px 0; }
.section-h { display:flex; justify-content:space-between; align-items:center; margin:18px 0 8px; }
.section-h span { font-weight:900; font-style:italic; text-transform:uppercase; letter-spacing:.5px; border-left:4px solid var(--f1-red); padding-left:8px; }
.tiles { display:grid; grid-template-columns:repeat(auto-fill, minmax(150px, 1fr)); gap:8px; }
.tiles.three { grid-template-columns:repeat(3, 1fr); }
.tile { background:var(--f1-panel); border-left:4px solid var(--f1-line); padding:10px 12px; min-width:0; }
.tile.pb { border-left-color:var(--f1-green); }
.tile.purple { border-left-color:var(--f1-purple); }
.tlabel { font-size:.72em; text-transform:uppercase; letter-spacing:.8px; color:var(--f1-muted); font-weight:700; }
.tvalue { font-size:1.6em; font-weight:900; font-variant-numeric:tabular-nums; line-height:1.2; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.tile.pb .tvalue { color:var(--f1-green); }
.tile.purple .tvalue { color:var(--f1-purple); }
.tsub { font-size:.78em; color:var(--f1-muted); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.strip { display:flex; align-items:center; flex-wrap:wrap; gap:6px 12px; background:var(--f1-panel); padding:9px 12px; margin-bottom:10px; color:var(--f1-muted); }
.strip.on { background:linear-gradient(90deg, rgba(225,6,0,.35), var(--f1-panel) 60%); color:#fff; cursor:pointer; }
.strip .who { font-size:.85em; color:#ddd; }
.clock-s { font-weight:900; font-variant-numeric:tabular-nums; }
.status { display:flex; align-items:center; gap:8px; font-size:.82em; color:var(--f1-muted); margin-bottom:8px; }
.dot { width:9px; height:9px; border-radius:50%; display:inline-block; }
.dot.ok { background:var(--f1-green); } .dot.wait { background:var(--f1-yellow); } .dot.bad { background:var(--f1-red); }
.follows { display:flex; flex-direction:column; gap:8px; }
.fcard { background:var(--f1-panel); border-left:4px solid var(--f1-follow); padding:10px 12px; }
.fcard.islive { background:linear-gradient(90deg, rgba(0,163,224,.18), var(--f1-panel) 60%); }
.fpos { color:var(--f1-muted); font-size:.8em; font-weight:700; }
.section-h .muted { border:none; padding:0; font-style:normal; text-transform:none; font-weight:400; letter-spacing:0; }
.follow { margin-top:12px; background:var(--f1-panel); border-left:4px solid var(--f1-follow); padding:10px 12px; }
.follow.empty-f { border-left-color:var(--f1-line); }
.fh { display:flex; align-items:center; gap:10px; margin-bottom:8px; font-weight:700; }
.fbadge { background:var(--f1-follow); color:#001; font-weight:900; font-style:italic; font-size:.7em; padding:2px 8px; transform:skewX(-12deg); letter-spacing:1px; }
.fname { font-weight:900; text-transform:uppercase; font-style:italic; flex:1; }
.fgrid { display:grid; grid-template-columns:repeat(3, 1fr); gap:8px; }
.fstat { background:var(--f1-panel2); padding:8px 10px; min-width:0; }
.fstat .tvalue { font-size:1.3em; }
.fstat.live .tvalue { color:var(--f1-follow); }
.star { background:none; border:none; color:var(--f1-muted); font-size:1.15em; cursor:pointer; padding:0 4px; line-height:1; }
.star.on { color:var(--f1-follow); }
.heatbar { display:flex; justify-content:space-between; align-items:baseline; gap:12px; margin:4px 0 10px; }
.heatname { font-weight:900; font-style:italic; text-transform:uppercase; font-size:1.05em; }
.clock { font-size:1.9em; font-weight:900; font-variant-numeric:tabular-nums; }
.tower { display:flex; flex-direction:column; gap:2px; }
.trow { display:flex; align-items:center; gap:8px; background:var(--f1-panel); padding:6px 8px 6px 0; font-variant-numeric:tabular-nums;
border-left:4px solid transparent; }
.trow.head { background:none; color:var(--f1-muted); font-size:.72em; text-transform:uppercase; letter-spacing:.8px; font-weight:700; padding:2px 8px 2px 0; }
.trow.me { border-left-color:var(--f1-red); background:linear-gradient(90deg, rgba(225,6,0,.22), var(--f1-panel) 70%); }
.trow.fol { border-left-color:var(--f1-follow); background:linear-gradient(90deg, rgba(0,163,224,.2), var(--f1-panel) 70%); }
.trow.gaprow { justify-content:center; background:none; color:var(--f1-muted); padding:0; }
.tpos { width:34px; text-align:center; font-weight:900; font-size:1.05em; flex:none; }
.trow:not(.head) .tpos { background:#fff; color:#111; padding:2px 0; margin-left:6px; width:30px; }
.trow .tpos.p1 { background:#F6C343; } .trow .tpos.p2 { background:#CFD4DA; } .trow .tpos.p3 { background:#D79A63; }
.tname { flex:1; min-width:0; font-weight:700; text-transform:uppercase; overflow:hidden; text-overflow:ellipsis; }
.tname .small { text-transform:none; }
.tag { background:var(--f1-red); color:#fff; font-size:.65em; padding:1px 5px; margin-left:6px; font-style:italic; font-weight:900; vertical-align:middle; }
.tk, .tl { width:44px; text-align:right; color:var(--f1-muted); flex:none; }
.tt { width:70px; text-align:right; font-weight:700; flex:none; }
.tg { width:66px; text-align:right; color:var(--f1-muted); font-size:.9em; flex:none; }
.tf { width:24px; text-align:center; flex:none; }
.purple { color:var(--f1-purple); } .green { color:var(--f1-green); } .yellow { color:var(--f1-yellow); } .red { color:#ff5a52; }
.purpletxt { color:var(--f1-purple); }
.legend { display:flex; align-items:center; gap:6px; flex-wrap:wrap; margin-top:10px; font-size:.78em; color:var(--f1-muted); }
.sw { width:14px; height:4px; display:inline-block; margin-left:8px; }
.sw.purple { background:var(--f1-purple); } .sw.green { background:var(--f1-green); } .sw.yellow { background:var(--f1-yellow); }
.laps .tt { width:80px; } .laps .tg { width:80px; } .laps .tpos { width:40px; }
.heats { display:flex; flex-direction:column; gap:4px; }
.heat { display:flex; align-items:center; gap:12px; width:100%; text-align:left; background:var(--f1-panel); border:none; border-left:4px solid var(--f1-line);
font:inherit; color:inherit; padding:10px 12px; cursor:pointer; }
.heat:hover { background:var(--f1-panel2); border-left-color:var(--f1-red); }
.pbadge { min-width:38px; text-align:center; font-weight:900; font-style:italic; padding:4px 6px; background:var(--f1-panel2); }
.pbadge.p1 { background:#F6C343; color:#111; } .pbadge.p2 { background:#CFD4DA; color:#111; } .pbadge.p3 { background:#D79A63; color:#111; }
.hinfo { flex:1; min-width:0; }
.hname { font-weight:700; text-transform:uppercase; }
.htime { font-weight:900; font-variant-numeric:tabular-nums; text-align:right; font-size:1.1em; }
.chev { color:var(--f1-muted); font-size:1.4em; }
a.trow.klink { color:inherit; text-decoration:none; cursor:pointer; }
a.trow.klink:hover { background:var(--f1-panel2); }
.chips { display:flex; flex-wrap:wrap; gap:4px; margin-bottom:8px; }
.chip { background:var(--f1-panel); border:1px solid var(--f1-line); color:var(--f1-muted); font:inherit; font-weight:700; font-size:.8em;
text-transform:uppercase; letter-spacing:.5px; padding:5px 12px; cursor:pointer; }
.chip.on { background:var(--f1-red); border-color:var(--f1-red); color:#fff; }
.chart { width:100%; height:auto; display:block; margin:6px 0 10px; background:var(--f1-panel); }
.cline { fill:none; stroke:#fff; stroke-width:2; }
.cgrid { stroke:var(--f1-purple); stroke-dasharray:5 5; stroke-width:1.5; }
.clabel { fill:var(--f1-purple); font:700 13px 'Titillium Web', Arial, sans-serif; }
.cdot { fill:#fff; } .cbest { fill:var(--f1-purple); } .cout { fill:#ff5a52; }
.cx { fill:var(--f1-muted); font:600 11px 'Titillium Web', Arial, sans-serif; text-anchor:middle; }
.mapwrap { background:#15151E; }
.mapwrap.small { cursor:pointer; }
.mapwrap svg { width:100%; height:auto; display:block; }
.tips p { color:#ddd; line-height:1.45; margin:6px 0; }
.tips .g { color:var(--f1-green); } .tips .y { color:var(--f1-yellow); } .tips .r { color:#ff5a52; }
@media (max-width: 520px) {
.body { padding:12px 10px 14px; }
.tk, .tl { display:none; }
.tt { width:62px; } .tg { width:56px; }
.fgrid { grid-template-columns:1fr 1fr; }
.fgrid .fstat:last-child { grid-column:span 2; }
.tiles.three { grid-template-columns:1fr 1fr; }
.tvalue { font-size:1.35em; }
}
`;
if (!customElements.get("kart-card")) {
customElements.define("kart-card", KartCard);
window.customCards = window.customCards || [];
window.customCards.push({
type: "kart-card",
name: "Kart en Fun Fabriek",
description: "Live timing, heats, klassement en baankaart (SMS-Timing), F1-stijl.",
});
console.info(`%c KART-CARD %c ${KART_CARD_VERSION} `, "background:#E10600;color:#fff;font-weight:bold", "background:#15151E;color:#fff");
}