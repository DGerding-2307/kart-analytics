/*
 * Kart Analytics – automatische updater
 *
 * Start server.js en controleert elk uur (UPDATE_INTERVAL_MIN) of er een nieuwe versie op GitHub staat.
 * Zo ja: code ophalen (git) en de server netjes herstarten. De database (in /data) blijft altijd staan.
 * Crasht de server, dan wordt hij na 5 seconden opnieuw gestart.
 */
"use strict";
const { spawn, execFileSync } = require("node:child_process");
const path = require("node:path");

const DIR = __dirname;
const BRANCH = process.env.UPDATE_BRANCH || "main";
const INTERVAL = Math.max(5, Number(process.env.UPDATE_INTERVAL_MIN || 60)) * 60000;
const AUTO = (process.env.AUTO_UPDATE || "true") !== "false";
const log = (...a) => console.log(new Date().toISOString(), "[updater]", ...a);

let child = null;
let stopping = false;
let restarting = false;

function start() {
  child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", path.join(DIR, "server.js")], { stdio: "inherit", env: process.env });
  child.on("exit", (code, sig) => {
    child = null;
    if (stopping) return process.exit(0);
    if (restarting) return;
    log(`server gestopt (code ${code}, signaal ${sig}), herstart over 5 s`);
    setTimeout(start, 5000);
  });
}

function restart() {
  if (!child) return start();
  restarting = true;
  child.once("exit", () => {
    restarting = false;
    start();
  });
  child.kill("SIGTERM");
  setTimeout(() => child && child.kill("SIGKILL"), 15000);
}

const git = (...args) => execFileSync("git", ["-C", DIR, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

function checkUpdate() {
  try {
    git("fetch", "--quiet", "origin", BRANCH);
    const local = git("rev-parse", "HEAD");
    const remote = git("rev-parse", `origin/${BRANCH}`);
    if (local === remote) return;
    log(`nieuwe versie gevonden (${local.slice(0, 7)} → ${remote.slice(0, 7)}), bijwerken…`);
    git("reset", "--hard", `origin/${BRANCH}`);
    // Is de updater zelf veranderd? Dan het hele proces herstarten; Docker start hem opnieuw (restart: unless-stopped).
    const changed = git("diff", "--name-only", local, remote).split("\n");
    if (changed.includes("updater.js")) {
      log("updater zelf bijgewerkt, container herstart");
      stopping = true;
      if (child) child.kill("SIGTERM");
      else process.exit(0);
      setTimeout(() => process.exit(0), 15000);
      return;
    }
    restart();
  } catch (e) {
    log("update-controle mislukt:", (e.stderr || e.message || "").toString().trim());
  }
}

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    stopping = true;
    if (child) child.kill("SIGTERM");
    else process.exit(0);
    setTimeout(() => process.exit(0), 15000);
  });
}

start();
if (AUTO) {
  log(`automatisch bijwerken aan: elke ${INTERVAL / 60000} min (branch ${BRANCH})`);
  setTimeout(checkUpdate, 60000);
  setInterval(checkUpdate, INTERVAL);
} else {
  log("automatisch bijwerken staat uit (AUTO_UPDATE=false)");
}
