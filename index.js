/* =============================================================================
 * SENTRY worker — Mac mini / local edition.
 * Runs the 5-condition stack 24/7, fires Telegram alerts on ENTER and on paper
 * TP/SL closes, and keeps per-timeframe paper accounts (with fees).
 * Paper state is saved to a local state.json so it survives restarts.
 *
 * Dependency-free: Node 18+ built-ins + global fetch only.
 *
 * ENV (set before `node index.js`, or via pm2 ecosystem file):
 *   TELEGRAM_BOT_TOKEN   (for alerts)  e.g. 123456:ABC...
 *   TELEGRAM_CHAT_ID     (for alerts)  your numeric chat id
 *   TIMEFRAMES           default "30m"   comma list of: 5m,15m,30m,1h
 *   BALANCE              default 1000
 *   LEVERAGE             default 10
 *   PAPER                default "on"
 *   POLL_SECONDS         default 60
 *   STATE_FILE           default "./state.json"
 * ============================================================================= */

import fs from "node:fs";

/* ----------------------------- CONFIG -------------------------------------- */
const env = (k, d) => (process.env[k] !== undefined && process.env[k] !== "" ? process.env[k] : d);

const PAIRS = [
  { sym: "BTCUSDT", base: "BTC", notional: 2500 },
  { sym: "ETHUSDT", base: "ETH", notional: 2500 },
  { sym: "SOLUSDT", base: "SOL", notional: 1500 },
  { sym: "BNBUSDT", base: "BNB", notional: 2500 },
  { sym: "XRPUSDT", base: "XRP", notional: 2000 },
  { sym: "DOGEUSDT", base: "DOGE", notional: 1500 },
];
const TF_DEFS = {
  "5m":  { tf: "5",  htf: "15",  gate: "15m", tp: 18,  sl: 12,  mins: 5,  htfMins: 15 },
  "15m": { tf: "15", htf: "60",  gate: "1H",  tp: 40,  sl: 27,  mins: 15, htfMins: 60 },
  "30m": { tf: "30", htf: "120", gate: "2H",  tp: 74,  sl: 50,  mins: 30, htfMins: 120 },
  "1h":  { tf: "60", htf: "240", gate: "4H",  tp: 111, sl: 75,  mins: 60, htfMins: 240 },
};
const BYBIT = "https://api.bybit.com";
const CE_LEN = 4, CE_MULT = 2, ZL_LEN = 38, ADX_LEN = 14, MACD = { fast: 5, slow: 35, sig: 5 };
const ADX_THR = 20, FEE_RATE = 0.0005, FRESH_FLIP_BARS = 3;
const KLINE_TF = 220, KLINE_HTF = 320;

const CFG = {
  timeframes: String(env("TIMEFRAMES", "30m")).split(",").map(s => s.trim()).filter(t => TF_DEFS[t]),
  balance: +env("BALANCE", 1000),
  lev: +env("LEVERAGE", 10),
  paper: String(env("PAPER", "on")).toLowerCase() !== "off",
  pollMs: +env("POLL_SECONDS", 60) * 1000,
  tg: { token: env("TELEGRAM_BOT_TOKEN", ""), chat: env("TELEGRAM_CHAT_ID", "") },
  stateFile: env("STATE_FILE", "./state.json"),
};
if (!CFG.timeframes.length) CFG.timeframes = ["30m"];

/* --------------------------- INDICATOR MATH -------------------------------- */
function sma(a, len) { const o = Array(a.length).fill(NaN); let s = 0; for (let i = 0; i < a.length; i++) { s += a[i]; if (i >= len) s -= a[i - len]; if (i >= len - 1) o[i] = s / len; } return o; }
function emaSeed(a, len) { const o = Array(a.length).fill(NaN); const k = 2 / (len + 1); let p; for (let i = 0; i < a.length; i++) { if (i === len - 1) { let s = 0; for (let j = 0; j < len; j++) s += a[j]; p = s / len; o[i] = p; } else if (i > len - 1) { p = a[i] * k + p * (1 - k); o[i] = p; } } return o; }
function emaFrom(a, len) { const o = Array(a.length).fill(NaN); let s = 0; while (s < a.length && isNaN(a[s])) s++; if (a.length - s < len) return o; const sub = a.slice(s); const e = emaSeed(sub, len); for (let i = 0; i < e.length; i++) o[s + i] = e[i]; return o; }
function rmaFrom(a, len) { const o = Array(a.length).fill(NaN); let s = 0; while (s < a.length && isNaN(a[s])) s++; if (a.length - s < len) return o; let p; for (let i = s; i < a.length; i++) { const idx = i - s; if (idx === len - 1) { let sum = 0; for (let j = 0; j < len; j++) sum += a[s + j]; p = sum / len; o[i] = p; } else if (idx > len - 1) { p = (p * (len - 1) + a[i]) / len; o[i] = p; } } return o; }
function trueRange(h, l, c) { const t = Array(h.length).fill(NaN); for (let i = 0; i < h.length; i++) { t[i] = i === 0 ? h[i] - l[i] : Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1])); } return t; }
function atr(h, l, c, len) { return rmaFrom(trueRange(h, l, c), len); }
function chandelier(h, l, c, len, mult) {
  const n = c.length, a = atr(h, l, c, len);
  const ls = Array(n).fill(NaN), ss = Array(n).fill(NaN), dir = Array(n).fill(1);
  for (let i = 0; i < n; i++) {
    if (i < len - 1 || isNaN(a[i])) { if (i > 0) dir[i] = dir[i - 1]; continue; }
    let hh = -Infinity, ll = Infinity;
    for (let j = i - len + 1; j <= i; j++) { if (c[j] > hh) hh = c[j]; if (c[j] < ll) ll = c[j]; }
    let L = hh - mult * a[i], S = ll + mult * a[i];
    const Lp = isNaN(ls[i - 1]) ? L : ls[i - 1], Sp = isNaN(ss[i - 1]) ? S : ss[i - 1];
    if (i >= 1 && c[i - 1] > Lp) L = Math.max(L, Lp);
    if (i >= 1 && c[i - 1] < Sp) S = Math.min(S, Sp);
    ls[i] = L; ss[i] = S;
    let d = dir[i - 1] || 1;
    if (c[i] > Sp) d = 1; else if (c[i] < Lp) d = -1;
    dir[i] = d;
  }
  return { dir };
}
function linEnd(src, len, end) { let sx = 0, sy = 0, sxx = 0, sxy = 0; for (let k = 0; k < len; k++) { const x = k, y = src[end - len + 1 + k]; sx += x; sy += y; sxx += x * x; sxy += x * y; } const slope = (len * sxy - sx * sy) / (len * sxx - sx * sx); const inter = (sy - slope * sx) / len; return inter + slope * (len - 1); }
function zlsma(src, len) { const n = src.length, lsma = Array(n).fill(NaN), out = Array(n).fill(NaN); for (let i = len - 1; i < n; i++) lsma[i] = linEnd(src, len, i); for (let i = 2 * (len - 1); i < n; i++) { const l2 = linEnd(lsma, len, i); out[i] = lsma[i] + (lsma[i] - l2); } return out; }
function macd(src, f, sl, sg) { const ef = emaFrom(src, f), es = emaFrom(src, sl); const line = src.map((_, i) => (isNaN(ef[i]) || isNaN(es[i])) ? NaN : ef[i] - es[i]); const sig = emaFrom(line, sg); const hist = line.map((v, i) => (isNaN(v) || isNaN(sig[i])) ? NaN : v - sig[i]); return { hist }; }
function adx(h, l, c, len) {
  const n = c.length, tr = trueRange(h, l, c);
  const pDM = Array(n).fill(0), mDM = Array(n).fill(0);
  for (let i = 1; i < n; i++) { const up = h[i] - h[i - 1], dn = l[i - 1] - l[i]; pDM[i] = (up > dn && up > 0) ? up : 0; mDM[i] = (dn > up && dn > 0) ? dn : 0; }
  const atrS = rmaFrom(tr, len), pS = rmaFrom(pDM, len), mS = rmaFrom(mDM, len);
  const dx = Array(n).fill(NaN);
  for (let i = 0; i < n; i++) { if (isNaN(atrS[i]) || atrS[i] === 0) continue; const pdi = 100 * pS[i] / atrS[i], mdi = 100 * mS[i] / atrS[i], sum = pdi + mdi; dx[i] = sum === 0 ? 0 : 100 * Math.abs(pdi - mdi) / sum; }
  return { adx: rmaFrom(dx, len) };
}
function barsSinceFlip(dir, ci) { let n = 0; for (let i = ci; i > 0; i--) { if (dir[i] === dir[i - 1]) n++; else break; } return n; }

/* ------------------------------ BYBIT -------------------------------------- */
async function getJSON(url) {
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 12000);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const j = await r.json();
    if (j.retCode !== 0) throw new Error("Bybit " + j.retCode + " " + (j.retMsg || ""));
    return j.result;
  } finally { clearTimeout(t); }
}
function parseKlines(list) { const k = list.slice().reverse(); return { o: k.map(r => +r[1]), h: k.map(r => +r[2]), l: k.map(r => +r[3]), c: k.map(r => +r[4]), v: k.map(r => +r[5]) }; }
async function fetchKlines(sym, interval, limit) { const r = await getJSON(`${BYBIT}/v5/market/kline?category=linear&symbol=${sym}&interval=${interval}&limit=${limit}`); return parseKlines(r.list); }
async function fetchTicker(sym) { const r = await getJSON(`${BYBIT}/v5/market/tickers?category=linear&symbol=${sym}`); const t = r.list[0]; return { price: +t.lastPrice, funding: +t.fundingRate }; }

/* ---------------------------- EVALUATION ----------------------------------- */
function evaluatePair(p, k1, k4, ticker) {
  const c = k1.c, ci = c.length - 2; // last CLOSED bar
  const ce = chandelier(k1.h, k1.l, c, CE_LEN, CE_MULT);
  const zl = zlsma(c, ZL_LEN);
  const md = macd(c, MACD.fast, MACD.slow, MACD.sig);
  const ax = adx(k1.h, k1.l, c, ADX_LEN);
  const c4 = k4.c, ci4 = c4.length - 2;
  const ema200 = emaFrom(c4, Math.min(200, c4.length - 1));
  const htfUp = c4[ci4] > ema200[ci4], htfDown = c4[ci4] < ema200[ci4];
  const dir = htfUp ? "long" : htfDown ? "short" : "none";
  const want = dir === "long";
  const ceDir = ce.dir[ci], flip = barsSinceFlip(ce.dir, ci);
  const aboveZ = c[ci] > zl[ci], hist = md.hist[ci], adxV = ax.adx[ci], adxRising = adxV > ax.adx[ci - 1];
  const cond = {
    htf: dir !== "none",
    ceZ: dir !== "none" && (want ? (ceDir === 1 && aboveZ) : (ceDir === -1 && !aboveZ)),
    macd: dir !== "none" && (want ? hist > 0 : hist < 0),
    adx: adxV >= ADX_THR && adxRising,
  };
  const core = cond.htf && cond.ceZ && cond.macd && cond.adx;
  return { sym: p.sym, base: p.base, notional: p.notional, dir, price: ticker.price, funding: ticker.funding, adxV, flip, fresh: flip <= FRESH_FLIP_BARS, core, dup: true };
}
function resolveCorrelation(results) {
  for (const d of ["long", "short"]) {
    const armed = results.filter(r => r.dir === d && r.core);
    if (armed.length > 1) { armed.sort((a, b) => b.adxV - a.adxV); armed.forEach((r, i) => { if (i > 0) r.dup = false; }); }
  }
}
const isEnter = r => r.core && r.dup && r.dir !== "none";

/* ---------------------------- PAPER ENGINE --------------------------------- */
function openPaper(acct, r, tfDef) {
  const stopPct = tfDef.sl / r.notional, tpPct = tfDef.tp / r.notional, entry = r.price, dir = r.dir;
  acct.open.push({
    id: acct.tf + "-" + r.sym + "-" + Date.now(), tf: acct.tf, sym: r.sym, base: r.base, dir, entry,
    notional: r.notional, qty: r.notional / entry,
    tp: dir === "long" ? entry * (1 + tpPct) : entry * (1 - tpPct),
    sl: dir === "long" ? entry * (1 - stopPct) : entry * (1 + stopPct),
    tpUsd: tfDef.tp, slUsd: tfDef.sl, margin: r.notional / CFG.lev, openedAt: Date.now(),
  });
}
function closePaper(acct, pos, exit, outcome) {
  const gross = pos.dir === "long" ? (exit - pos.entry) * pos.qty : (pos.entry - exit) * pos.qty;
  const fee = pos.notional * FEE_RATE + (exit * pos.qty) * FEE_RATE;
  const pnl = gross - fee;
  pos.closedAt = Date.now(); pos.exit = exit; pos.gross = gross; pos.fee = fee; pos.pnl = pnl; pos.outcome = outcome;
  pos.rMultiple = pnl >= 0 ? pnl / pos.slUsd : -Math.abs(pnl) / pos.slUsd;
  acct.balance += pnl;
  acct.open = acct.open.filter(p => p.id !== pos.id);
  acct.closed.unshift(pos);
  if (acct.closed.length > 500) acct.closed.length = 500;
  return pos;
}

/* ------------------------------ TELEGRAM ----------------------------------- */
async function tg(text) {
  if (!CFG.tg.token || !CFG.tg.chat) return;
  try {
    await fetch(`https://api.telegram.org/bot${CFG.tg.token}/sendMessage`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: CFG.tg.chat, text, parse_mode: "HTML", disable_web_page_preview: true }),
    });
  } catch (e) { log("telegram error: " + e.message); }
}

/* ------------------------- STATE (local file) ------------------------------ */
const state = { accounts: {}, prevArm: {}, paperPrevArm: {}, lastRun: null, lastError: null, started: Date.now() };
for (const tf of CFG.timeframes) { state.accounts[tf] = { tf, on: CFG.paper, balance: CFG.balance, open: [], closed: [] }; state.prevArm[tf] = {}; state.paperPrevArm[tf] = {}; }

function loadState() {
  try {
    if (fs.existsSync(CFG.stateFile)) {
      const saved = JSON.parse(fs.readFileSync(CFG.stateFile, "utf8"));
      for (const tf of CFG.timeframes) if (saved.accounts && saved.accounts[tf]) state.accounts[tf] = saved.accounts[tf];
      if (saved.paperPrevArm) state.paperPrevArm = { ...state.paperPrevArm, ...saved.paperPrevArm };
      log("state loaded from " + CFG.stateFile);
    } else { log("no state file yet — starting fresh"); }
  } catch (e) { log("loadState error: " + e.message); }
}
let saveTimer = null;
function saveStateSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      const tmp = CFG.stateFile + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify({ accounts: state.accounts, paperPrevArm: state.paperPrevArm }, null, 2));
      fs.renameSync(tmp, CFG.stateFile); // atomic replace
    } catch (e) { log("saveState error: " + e.message); }
  }, 1500);
}

/* -------------------------------- LOOP ------------------------------------- */
function log(...a) { console.log(new Date().toISOString(), ...a); }
const fmt = x => (Math.round(x * 100) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
function fmtPrice(x) { return x >= 1000 ? x.toFixed(1) : x >= 100 ? x.toFixed(2) : x >= 1 ? x.toFixed(3) : x.toFixed(5); }

async function runOnce() {
  const tickers = {};
  await Promise.all(PAIRS.map(async p => { tickers[p.sym] = await fetchTicker(p.sym); }));

  for (const tf of CFG.timeframes) {
    const d = TF_DEFS[tf];
    const kc = {};
    for (const p of PAIRS) {
      const [k1, k4] = await Promise.all([fetchKlines(p.sym, d.tf, KLINE_TF), fetchKlines(p.sym, d.htf, KLINE_HTF)]);
      kc[p.sym] = { k1, k4 };
    }
    const results = PAIRS.map(p => evaluatePair(p, kc[p.sym].k1, kc[p.sym].k4, tickers[p.sym]));
    resolveCorrelation(results);

    const acct = state.accounts[tf], prevArm = state.prevArm[tf], paperPrevArm = state.paperPrevArm[tf];

    // 1) close paper positions on TP/SL (live price)
    if (acct.on) {
      for (const pos of acct.open.slice()) {
        const px = tickers[pos.sym].price;
        let exit = null, outcome = null;
        if (pos.dir === "long") { if (px >= pos.tp) { exit = pos.tp; outcome = "TP"; } else if (px <= pos.sl) { exit = pos.sl; outcome = "SL"; } }
        else { if (px <= pos.tp) { exit = pos.tp; outcome = "TP"; } else if (px >= pos.sl) { exit = pos.sl; outcome = "SL"; } }
        if (exit != null) {
          const c = closePaper(acct, pos, exit, outcome);
          await tg(`${outcome === "TP" ? "✅" : "🛑"} <b>${c.base} ${tf}</b> ${c.dir.toUpperCase()} closed <b>${outcome}</b>\npnl ${c.pnl >= 0 ? "+" : ""}${fmt(c.pnl)} (${c.rMultiple >= 0 ? "+" : ""}${c.rMultiple.toFixed(2)}R) · bal ${fmt(acct.balance)}`);
        }
      }
    }

    // 2) ENTER alerts (rising edge) + paper open
    for (const r of results) {
      const enter = isEnter(r);
      if (enter && !prevArm[r.sym]) {
        const dir = r.dir === "long" ? "LONG" : "SHORT", emoji = r.dir === "long" ? "🟢" : "🔴";
        const tpPct = d.tp / r.notional, slPct = d.sl / r.notional;
        const tp = r.dir === "long" ? r.price * (1 + tpPct) : r.price * (1 - tpPct);
        const sl = r.dir === "long" ? r.price * (1 - slPct) : r.price * (1 + slPct);
        await tg(`${emoji} <b>${r.base} ${tf}</b> — ENTER ${dir}${r.fresh ? " (fresh)" : ""}\n@ ${fmtPrice(r.price)} · TP ${fmtPrice(tp)} · SL ${fmtPrice(sl)} · ADX ${r.adxV.toFixed(0)}`);
      }
      prevArm[r.sym] = enter;

      if (acct.on) {
        const was = paperPrevArm[r.sym] || false;
        if (enter && !was) {
          const hasOpen = acct.open.some(o => o.sym === r.sym);
          const usedMargin = acct.open.reduce((s, o) => s + o.margin, 0);
          const margin = r.notional / CFG.lev;
          if (!hasOpen && (acct.balance - usedMargin) >= margin) openPaper(acct, r, d);
        }
        paperPrevArm[r.sym] = enter;
      }
    }
  }
  state.lastRun = Date.now();
  state.lastError = null;
  saveStateSoon();
}

let runs = 0;
async function loop() {
  try {
    await runOnce();
    if (++runs % 30 === 0) { // periodic heartbeat in the logs (~every 30 polls)
      const parts = CFG.timeframes.map(tf => { const a = state.accounts[tf]; return `${tf}: bal ${fmt(a.balance)} · ${a.open.length} open · ${a.closed.length} closed`; });
      log("heartbeat · " + parts.join("  |  "));
    }
  } catch (e) { state.lastError = e.message; log("run error: " + e.message); }
  setTimeout(loop, CFG.pollMs);
}

/* ------------------------------- BOOT -------------------------------------- */
log(`SENTRY (Mac) starting · TFs=${CFG.timeframes.join(",")} · paper=${CFG.paper} · poll=${CFG.pollMs / 1000}s · state=${CFG.stateFile}`);
if (!CFG.tg.token || !CFG.tg.chat) log("⚠ TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set — running without alerts.");
loadState();
await tg(`🛰️ <b>SENTRY worker online</b> (Mac)\nTimeframes: ${CFG.timeframes.join(", ")} · paper ${CFG.paper ? "ON" : "off"}`);
loop();
