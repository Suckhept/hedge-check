// app.js — UI and network. All math lives in lib.js.
import * as L from "./lib.js";

// ---------------------------------------------------------------------------
// Config: everything a fork would change
// ---------------------------------------------------------------------------
const CONFIG = {
  referralCode: "FREEDOM",
  repoUrl: "https://github.com/Suckhept/hedge-check",
  venues: {
    rh: { key: "rh", name: "Lighter RH", long: "Lighter on Robinhood Chain", quote: "USDG",
      api: "https://api.rh.lighter.xyz", explorer: "https://explorerapi.rh.lighter.xyz/api",
      ui: "https://robinhoodchain.lighter.xyz", ref: true },
    core: { key: "core", name: "Lighter Core", long: "Lighter Core", quote: "USDC",
      api: "https://mainnet.zklighter.elliot.ai", explorer: "https://explorer.elliot.ai/api",
      ui: "https://app.lighter.xyz", ref: false },
  },
  volumeDays: 7,
  volumeMaxPages: 30,      // 100 logs per page
};
const V = CONFIG.venues;
const refUrl = (venue, symbol) => {
  const v = V[venue];
  const path = symbol ? `/trade/${encodeURIComponent(symbol)}` : "/";
  return v.ui + path + (v.ref && CONFIG.referralCode ? `?referral=${encodeURIComponent(CONFIG.referralCode)}` : "");
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const nf = (d) => new Intl.NumberFormat("en-US", { maximumFractionDigits: d, minimumFractionDigits: 0 });
const fmt = (x, d = 2) => (x == null || !Number.isFinite(x) ? "—" : nf(d).format(x));
const usd = (x, d = 2) => (x == null || !Number.isFinite(x) ? "—" : (x < 0 ? "−$" : "$") + new Intl.NumberFormat("en-US", { minimumFractionDigits: d, maximumFractionDigits: d }).format(Math.abs(x)));
const usdc = (x) => {
  if (x == null || !Number.isFinite(x)) return "—";
  const a = Math.abs(x), s = x < 0 ? "−$" : "$";
  if (a >= 1e9) return s + (a / 1e9).toFixed(2) + "B";
  if (a >= 1e6) return s + (a / 1e6).toFixed(2) + "M";
  if (a >= 1e3) return s + (a / 1e3).toFixed(1) + "k";
  return s + a.toFixed(0);
};
const pct = (x, d = 2, signed = false) => (x == null || !Number.isFinite(x) ? "—" : (signed && x > 0 ? "+" : x < 0 ? "−" : "") + Math.abs(x).toFixed(d) + "%");
const cls = (x) => (x > 0 ? "pos" : x < 0 ? "neg" : "");
const price = (x) => (x == null ? "—" : x >= 1000 ? fmt(x, 1) : x >= 1 ? fmt(x, 3) : fmt(x, 6));
const store = {
  get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (e) { /* private mode */ } },
};

const hostOf = (url) => { try { return new URL(url, location.href).host; } catch (e) { return String(url); } };
const accIdx = (a) => (a ? a.account_index ?? a.index : null);

async function getJSON(url, { timeout = 12000, headers, direct = false } = {}) {
  let r;
  try {
    r = await fetch(url, { headers: { accept: "application/json", ...(headers || {}) }, signal: AbortSignal.timeout(timeout) });
  } catch (e) {
    // CORS / network: retry once through the same-origin proxy (Vercel function in api/proxy.js)
    // Never route authenticated requests (read-only tokens) through the proxy.
    if (headers || direct) throw e;
    const p = await fetch(`/api/proxy?url=${encodeURIComponent(url)}`, { signal: AbortSignal.timeout(timeout) }).catch(() => null);
    if (!p || p.status === 404) throw new Error(`Could not reach ${hostOf(url)}. Check your connection or VPN.`);
    r = p;
  }
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    const err = new Error(`${hostOf(url)} answered HTTP ${r.status}${t ? `: ${t.slice(0, 160)}` : ""}`);
    err.status = r.status;
    throw err;
  }
  const j = await r.json();
  if (j && typeof j === "object" && "code" in j && j.code !== 200 && j.code !== 0) {
    throw new Error(`${hostOf(url)}: code ${j.code} ${j.message || ""}`);
  }
  return j;
}

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------
const S = { markets: [], bySym: {}, idToSym: { rh: {}, core: {} }, weekly: null, latest: null, address: null, run: 0 };

async function loadMarkets() {
  const [rhB, coB, rhF, coF] = await Promise.all([
    getJSON(`${V.rh.api}/api/v1/orderBookDetails`), getJSON(`${V.core.api}/api/v1/orderBookDetails`),
    getJSON(`${V.rh.api}/api/v1/funding-rates`), getJSON(`${V.core.api}/api/v1/funding-rates`),
  ]);
  S.markets = L.buildMarkets(rhB.order_book_details, coB.order_book_details, rhF.funding_rates, coF.funding_rates);
  S.bySym = Object.fromEntries(S.markets.map((m) => [m.symbol, m]));
  for (const [k, b] of [["rh", rhB], ["core", coB]]) {
    for (const d of [...(b.order_book_details || []), ...(b.spot_order_book_details || [])]) S.idToSym[k][d.market_id] = d.symbol;
  }
  S.loadedAt = new Date();
}

async function loadWeekly() {
  try {
    S.weekly = await getJSON("weekly.json", { timeout: 8000, direct: true });
  } catch (e) {
    S.weekly = { weeks: [] };
  }
  S.latest = L.latestWeek(S.weekly);
}

// ---------------------------------------------------------------------------
// Team updates
// ---------------------------------------------------------------------------
const dateLong = (iso) => new Date(iso + "T00:00:00Z").toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" });
function boostChip(b) {
  const what = b.scope === "hedge" ? "RH ↔ Core hedge" : b.scope === "wallet" ? "Robinhood Wallet trades" : "Markets";
  const scope = b.symbols ? b.symbols.join(", ") : b.categories ? b.categories.map((c) => L.CATEGORY_LABELS[c] || c).join(", ") : "";
  return `<span class="chip boost">${esc(what)}${scope ? ` · ${esc(scope)}` : ""}${b.x ? ` <b>×${esc(b.x)}</b>` : ""}</span>`;
}
function renderWeek() {
  const card = $("week-card");
  if (!S.latest) { card.innerHTML = `<p class="muted">No team updates recorded yet.</p>`; $("week-list").innerHTML = ""; return; }
  const w = S.latest.week;
  card.innerHTML = `
    <div class="eyebrow"><span>Latest team update · week of ${esc(dateLong(w.week_of))}</span>${w.drop_points ? `<span>${fmt(w.drop_points, 0)} pts drop</span>` : ""}</div>
    <div class="head">${esc(w.headline)}</div>
    <div class="chips">${(w.boosts || []).map(boostChip).join("")}</div>
    ${w.warning ? `<p class="fine" style="margin-top:12px">${esc(w.warning)}</p>` : ""}
    ${S.latest.stale ? `<p class="stale">This is the latest update we recorded. Check Lighter's announcements for this week's rules.</p>` : ""}
    <p class="fine" style="margin-top:10px"><a href="#week">All updates</a></p>`;
  $("week-list").innerHTML = [w, ...S.latest.rest].map((x) => `
    <article class="week-item"><div class="meta">Week of ${esc(dateLong(x.week_of))}${x.drop_points ? ` · ${fmt(x.drop_points, 0)} points distributed` : ""}${x.source ? ` · ${esc(x.source)}` : ""}</div>
    <div class="head">${esc(x.headline)}</div><div class="chips">${(x.boosts || []).map(boostChip).join("")}</div>
    ${(x.boosts || []).filter((b) => b.note).map((b) => `<p class="fine" style="margin:8px 0 0">${esc(b.note)}</p>`).join("")}</article>`).join("");
}
async function renderAnnouncements() {
  const out = [];
  await Promise.all(["rh", "core"].map(async (k) => {
    try {
      const j = await getJSON(`${V[k].api}/api/v1/announcement`, { timeout: 8000 });
      const now = Date.now() / 1000;
      for (const a of j.announcements || []) {
        const exp = a.expired_at > 1e12 ? a.expired_at / 1000 : a.expired_at;
        if (!exp || exp > now) out.push({ ...a, venue: V[k].name });
      }
    } catch (e) { /* optional block */ }
  }));
  out.sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
  $("ann").innerHTML = out.length ? `<div class="ann"><h3>Live notices from the Lighter API</h3>${out.slice(0, 6).map((a) => `
    <div class="ann-item"><div class="v">${esc(a.venue)}</div><div class="t">${esc(a.title)}</div><div class="muted">${esc(a.content)}</div></div>`).join("")}</div>` : "";
}

// ---------------------------------------------------------------------------
// Markets table
// ---------------------------------------------------------------------------
const FILTERS = [["all", "All"], ["boost", "This week"], ["stock", "Stocks"], ["preipo", "Pre-IPO"], ["crypto", "Crypto"], ["etf", "ETF / index"], ["commodity", "Commodities"], ["fx", "FX"]];
const COLS = [
  ["symbol", "Market"], ["pair", "Best pair, %/day"], ["dir", "Direction"],
  ["fr", "RH funding /8h"], ["fc", "Core funding /8h"], ["vr", "RH 24h vol"], ["vc", "Core 24h vol"],
  ["or", "RH OI"], ["oc", "Core OI"], ["lev", "Max lev"],
];
const T = { filter: "all", q: "", sort: "pair", dir: -1 };

function marketRows() {
  const week = S.latest && S.latest.week;
  return S.markets.filter(L.onBoth).map((m) => {
    const lr = L.pairFundingDay(m, "rh"), lc = L.pairFundingDay(m, "core");
    const best = lr == null || lc == null ? null : lr >= lc ? { v: lr, on: "rh" } : { v: lc, on: "core" };
    return { m, boost: L.boostFor(week, m), best,
      k: { symbol: m.symbol, pair: best ? best.v : -Infinity, dir: best ? best.on : "", fr: m.rh.fundingRate ?? -Infinity,
        fc: m.core.fundingRate ?? -Infinity, vr: m.rh.vol24, vc: m.core.vol24, or: m.rh.oiUsd, oc: m.core.oiUsd,
        lev: Math.min(m.rh.maxLev || 0, m.core.maxLev || 0) } };
  });
}
function renderFilters() {
  $("filters").innerHTML = FILTERS.map(([k, l]) => `<button type="button" data-f="${k}" aria-pressed="${T.filter === k}">${esc(l)}</button>`).join("") +
    `<input id="mkt-q" type="search" placeholder="Search market" aria-label="Search market" value="${esc(T.q)}">`;
}
function renderTable() {
  let rows = marketRows();
  if (T.filter === "boost") rows = rows.filter((r) => r.boost);
  else if (T.filter !== "all") rows = rows.filter((r) => r.m.category === T.filter);
  if (T.q) rows = rows.filter((r) => r.m.symbol.includes(T.q.toUpperCase()));
  rows.sort((a, b) => {
    const x = a.k[T.sort], y = b.k[T.sort];
    return (typeof x === "string" ? x.localeCompare(y) : x - y) * T.dir;
  });
  const th = COLS.map(([k, l]) => `<th scope="col" data-k="${k}"${T.sort === k ? ` aria-sort="${T.dir > 0 ? "ascending" : "descending"}"` : ""}>${esc(l)}${T.sort === k ? (T.dir > 0 ? " ↑" : " ↓") : ""}</th>`).join("");
  const thin = (v) => (v < 50000 ? ' class="thin" title="Under $50k traded in 24h: thin book"' : "");
  const body = rows.length ? rows.map(({ m, boost, best }) => `
    <tr data-sym="${esc(m.symbol)}" tabindex="0">
      <td><span class="sym">${esc(m.symbol)}</span><span class="cat">${esc(L.CATEGORY_LABELS[m.category])}</span>${boost ? `<span class="boost-tag">${boost.x ? "×" + esc(boost.x) : "this week"}</span>` : ""}</td>
      <td class="${cls(best && best.v)}">${best ? pct(best.v * 100, 4, true) : "—"}</td>
      <td>${best ? (best.on === "rh" ? "Long RH · short Core" : "Long Core · short RH") : "—"}</td>
      <td>${m.rh.fundingRate == null ? "—" : pct(m.rh.fundingRate * 100, 4, true)}</td>
      <td>${m.core.fundingRate == null ? "—" : pct(m.core.fundingRate * 100, 4, true)}</td>
      <td${thin(m.rh.vol24)}>${usdc(m.rh.vol24)}</td><td${thin(m.core.vol24)}>${usdc(m.core.vol24)}</td>
      <td>${usdc(m.rh.oiUsd)}</td><td>${usdc(m.core.oiUsd)}</td>
      <td>${Math.min(m.rh.maxLev || 0, m.core.maxLev || 0) ? Math.min(m.rh.maxLev, m.core.maxLev) + "x" : "—"}</td>
    </tr>`).join("") : `<tr><td colspan="${COLS.length}" class="muted">No markets match this filter.</td></tr>`;
  $("mkt-table").querySelector("thead").innerHTML = `<tr>${th}</tr>`;
  $("mkt-table").querySelector("tbody").innerHTML = body;
  const total = S.markets.filter(L.onBoth).length;
  $("mkt-note").textContent = `${total} markets are active on both venues. Funding is the rate each venue reports per 8 hours; "best pair" is what a long/short pair earns per day at those rates (negative = it pays). Updated ${S.loadedAt.toLocaleTimeString()}.`;
}
function bindTable() {
  $("filters").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-f]"); if (!b) return;
    T.filter = b.dataset.f; renderFilters(); renderTable();
  });
  $("filters").addEventListener("input", (e) => { if (e.target.id === "mkt-q") { T.q = e.target.value.trim(); renderTable(); } });
  $("mkt-table").querySelector("thead").addEventListener("click", (e) => {
    const th = e.target.closest("th[data-k]"); if (!th) return;
    const k = th.dataset.k;
    if (T.sort === k) T.dir *= -1; else { T.sort = k; T.dir = k === "symbol" || k === "dir" ? 1 : -1; }
    renderTable();
  });
  const pick = (tr) => {
    if (!tr) return;
    $("c-market").value = tr.dataset.sym;
    const r = marketRows().find((x) => x.m.symbol === tr.dataset.sym);
    if (r && r.best) document.querySelector(`input[name=c-dir][value=${r.best.on}]`).checked = true;
    renderCalc();
    $("calc").scrollIntoView({ behavior: "smooth", block: "start" });
  };
  $("mkt-table").querySelector("tbody").addEventListener("click", (e) => pick(e.target.closest("tr[data-sym]")));
  $("mkt-table").querySelector("tbody").addEventListener("keydown", (e) => { if (e.key === "Enter") pick(e.target.closest("tr[data-sym]")); });
}

// ---------------------------------------------------------------------------
// Calculator
// ---------------------------------------------------------------------------
function fillCalcMarkets() {
  const opts = S.markets.filter(L.onBoth).sort((a, b) => (b.rh.vol24 + b.core.vol24) - (a.rh.vol24 + a.core.vol24));
  $("c-market").innerHTML = opts.map((m) => `<option value="${esc(m.symbol)}">${esc(m.symbol)} · ${esc(L.CATEGORY_LABELS[m.category])}</option>`).join("");
}
function renderCalc() {
  const m = S.bySym[$("c-market").value];
  const usdIn = parseFloat($("c-usd").value);
  const lev = parseInt($("c-lev").value, 10);
  $("c-lev-out").textContent = lev + "x";
  const dir = document.querySelector("input[name=c-dir]:checked").value;
  const out = $("calc-out");
  if (!m || !(usdIn > 0)) { out.innerHTML = `<p class="muted">Pick a market and a size.</p>`; return; }
  const c = L.pairCalc(m, usdIn, lev, dir);
  if (c.error) { out.innerHTML = `<p class="err">${esc(c.error)}</p>`; return; }
  const leg = (v) => {
    const x = c.legs[v];
    return `<div class="calc-leg ${v}"><div class="leg-title ${v}">${esc(V[v].name)} · ${x.side}</div>
      <dl class="leg-kv"><dt>Size</dt><dd>${fmt(c.size, c.decimals)} ${esc(m.symbol)}</dd><dt>Mark</dt><dd>${price(x.mark)}</dd>
      <dt>Notional</dt><dd>${usd(x.notional)}</dd><dt>Margin at ${c.leverage}x</dt><dd>${usd(x.margin)}</dd>
      <dt>Est. liquidation</dt><dd>${price(x.liq)}</dd><dt>Buffer</dt><dd>${pct(x.bufferPct, 1)}</dd></dl></div>`;
  };
  out.innerHTML = `
    <div class="muted">Each leg</div>
    <div class="calc-size">${fmt(c.size, c.decimals)} ${esc(m.symbol)}</div>
    <div class="muted">≈ ${usd(c.size * c.price)} per leg · ${usd(c.totalMargin)} total margin · pair funding ${c.fundingDayUsd == null ? "unknown" : `<b class="${cls(c.fundingDayUsd)}">${usd(c.fundingDayUsd)}/day</b>`}</div>
    ${c.tooSmall ? `<div class="note warn">Below the minimum order on one venue: at least ${fmt(c.minBase, c.decimals + 2)} ${esc(m.symbol)} and $${fmt(c.minQuote, 0)}. Increase the size.</div>` : ""}
    ${c.leverageCapped ? `<div class="note warn">Leverage capped at ${c.leverage}x, the lower maximum of the two markets.</div>` : ""}
    <div class="calc-legs">${leg("rh")}${leg("core")}</div>
    <p class="fine">Liquidation is an isolated-margin estimate at today's mark, before fees and funding. Size is rounded down to ${c.decimals} decimals so both venues accept the same amount.</p>
    <div class="calc-actions">
      <a class="btn btn-ink" href="${esc(refUrl("rh", m.symbol))}" target="_blank" rel="noopener">Open ${esc(m.symbol)} on Lighter RH</a>
      <a class="btn btn-line" href="${esc(refUrl("core", m.symbol))}" target="_blank" rel="noopener">Open on Lighter Core</a>
    </div>`;
}

// ---------------------------------------------------------------------------
// Wallet
// ---------------------------------------------------------------------------
async function loadVenue(k, addr) {
  try {
    const j = await getJSON(`${V[k].api}/api/v1/account?by=l1_address&value=${addr}`);
    return { ...L.aggregateLegs(j.accounts || []), raw: j.accounts || [] };
  } catch (e) {
    // no account on this venue yet
    if (e.status === 400 || e.status === 404 || /not found|21100/i.test(e.message)) return { ...L.aggregateLegs([]), raw: [], missing: true };
    throw e;
  }
}

async function loadVolume(k, addr, idx) {
  const since = Date.now() - CONFIG.volumeDays * 86400e3;
  const logs = [];
  let capped = false;
  for (let page = 0; page < CONFIG.volumeMaxPages; page++) {
    const batch = await getJSON(`${V[k].explorer}/accounts/${addr}/logs?limit=100&offset=${page * 100}`, { timeout: 15000 });
    if (!Array.isArray(batch) || !batch.length) break;
    logs.push(...batch);
    const last = Date.parse(batch[batch.length - 1].time);
    if (batch.length < 100 || (Number.isFinite(last) && last < since)) break;
    if (page === CONFIG.volumeMaxPages - 1) capped = true;
  }
  const v = L.tradeVolume(logs, new Set(idx), (id) => S.idToSym[k][id], since);
  return { ...v, capped };
}

const tokenKey = (k, addr) => `hc-ro-${k}-${addr.toLowerCase()}`;
async function loadPoints(k, addr, token, mainIdx) {
  const base = V[k].api;
  const q = `account_index=${mainIdx}`;
  let live = null, lb = null, lastErr = null;
  for (const mode of ["header", "query"]) {
    try {
      const opt = mode === "header" ? { headers: { authorization: token }, direct: true } : { direct: true };
      const t = mode === "query" ? `&auth=${encodeURIComponent(token)}` : "";
      const j = await getJSON(`${base}/api/v1/livePoints/total?${q}${t}`, opt);
      live = L.num(j.total_live_points ?? j.points ?? j.total);
      try {
        const b = await getJSON(`${base}/api/v1/leaderboard?type=all&l1_address=${addr}${t}`, opt);
        lb = (b.entries || []).find((e) => String(e.l1_address).toLowerCase() === addr.toLowerCase()) || null;
      } catch (e) { /* rank is optional */ }
      return { live, rank: lb ? lb.entry : null, lbPoints: lb ? lb.points : null };
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

function venueCard(k, d, vol) {
  const v = V[k];
  const main = d.raw.find((a) => a.account_type === 0) || d.raw[0];
  const legs = Object.values(d.legs);
  const upnl = legs.reduce((s, l) => s + l.upnl, 0);
  const tok = S.address ? store.get(tokenKey(k, S.address)) : null;
  return `<article class="venue ${k}" id="venue-${k}">
    <h3><span>${esc(v.name)}</span><a href="${esc(refUrl(k))}" target="_blank" rel="noopener">Open ↗</a></h3>
    ${d.missing ? `<p class="muted">No account on this venue for this address yet.</p>` : `
    <dl class="kv">
      <dt>Equity</dt><dd>${usd(d.equity)}</dd>
      <dt>Free to trade</dt><dd>${usd(d.available)}</dd>
      <dt>Unrealized PnL</dt><dd class="${cls(upnl)}">${usd(upnl)}</dd>
      <dt>Open positions</dt><dd>${legs.length}</dd>
      <dt>Accounts</dt><dd>${d.accounts}${main ? ` · main #${esc(accIdx(main))}` : ""}</dd>
      <dt>${CONFIG.volumeDays}-day volume</dt><dd id="vol-${k}">${vol ? volText(vol) : '<span class="loading">counting…</span>'}</dd>
      <dt>Points</dt><dd id="pts-${k}">${tok ? '<span class="loading">loading…</span>' : '<span class="muted">add token ↓</span>'}</dd>
    </dl>
    <details class="points-form"${tok ? "" : ""}>
      <summary>${tok ? "Read-only token saved on this device" : "Show points and rank with a read-only token"}</summary>
      <p class="fine" style="margin:8px 0 0">Lighter only shares points with the account owner. Create a <b>read-only</b> token at <a href="${esc(v.ui)}/read-only-tokens" target="_blank" rel="noopener">${esc(new URL(v.ui).host)}/read-only-tokens</a> and paste it here. It cannot trade or withdraw, it is sent only to ${esc(new URL(v.api).host)}, and it stays in this browser.</p>
      <form class="row" data-venue="${k}">
        <input type="password" name="token" placeholder="read-only token" autocomplete="off" aria-label="${esc(v.name)} read-only token" value="${tok ? "••••••••" : ""}">
        <button class="btn btn-ink" type="submit">Save</button>
        ${tok ? `<button class="btn btn-line" type="button" data-forget="${k}">Forget</button>` : ""}
      </form>
    </details>`}
  </article>`;
}
const volText = (v) => {
  if (v.error) return `<span class="muted" title="${esc(v.error)}">unavailable</span>`;
  const share = v.total ? Math.round((v.maker / v.total) * 100) : 0;
  return `${v.capped ? "≥ " : ""}${usdc(v.total)} <span class="muted">· ${share}% maker</span>`;
};

function pairCard(r) {
  const m = S.bySym[r.symbol];
  const nR = r.r ? Math.abs(r.rNet) * (r.mr || 0) : 0, nC = r.c ? Math.abs(r.cNet) * (r.mc || 0) : 0;
  const mx = Math.max(nR, nC) || 1;
  const bar = (leg, net, n, cls2) => leg
    ? `<span style="width:${Math.max(18, (n / mx) * 100)}%">${net > 0 ? "Long" : "Short"} ${fmt(Math.abs(net), 6)}</span>`
    : `<span class="empty ${cls2}">no position</span>`;
  const legKv = (k, leg, mark, buf, fund) => leg ? `
    <div><div class="leg-title ${k}">${esc(V[k].name)}</div><dl class="leg-kv">
      <dt>Size</dt><dd>${usd(Math.abs(leg.net) * (mark || 0))}${leg.leverage ? ` · ${fmt(leg.leverage, 1)}x` : ""}</dd>
      <dt>Entry / mark</dt><dd>${price(leg.entry)} / ${price(mark)}</dd>
      <dt>Liquidation</dt><dd>${price(leg.liq)} <span class="${buf != null && buf < 25 ? "neg" : buf != null && buf < 40 ? "" : "pos"}">(${pct(buf, 1)})</span></dd>
      <dt>Unrealized PnL</dt><dd class="${cls(leg.upnl)}">${usd(leg.upnl)}</dd>
      <dt>Funding now</dt><dd class="${cls(fund)}">${fund == null ? "—" : usd(fund) + "/day"}</dd>
      <dt>Funding since open</dt><dd class="${cls(leg.funding)}">${usd(leg.funding)}</dd>
    </dl></div>` : `<div><div class="leg-title ${k}">${esc(V[k].name)}</div><p class="muted">No position.${m && m[k] && m[k].active ? ` <a href="${esc(refUrl(k, r.symbol))}" target="_blank" rel="noopener">Open the other leg ↗</a>` : m && !m[k] ? " Not listed on this venue." : ""}</p></div>`;
  const label = { ok: "Hedged", warn: "Needs a tweak", bad: r.kind === "single" ? "Unhedged" : r.kind === "same" ? "Same direction" : "Act now" }[r.state];
  const boost = m ? L.boostFor(S.latest && S.latest.week, m) : null;
  return `<article class="pair ${r.state}">
    <div class="pair-top"><div class="pair-sym">${esc(r.symbol)}<small>${esc(L.CATEGORY_LABELS[r.category])}${boost && r.kind === "pair" ? ` · this week's focus` : ""}</small></div><span class="badge ${r.state}">${esc(label)}</span></div>
    <div class="spine" role="img" aria-label="RH ${r.r ? (r.rNet > 0 ? "long" : "short") + " " + fmt(Math.abs(r.rNet), 6) : "none"}, Core ${r.c ? (r.cNet > 0 ? "long" : "short") + " " + fmt(Math.abs(r.cNet), 6) : "none"}">
      <div class="bar-l">${bar(r.r, r.rNet, nR, "")}</div>
      <div class="mid">delta<b>${r.delta === 0 ? "0" : (r.delta > 0 ? "+" : "−") + fmt(Math.abs(r.delta), 6)}</b>${usd(r.deltaUsd, 0)}</div>
      <div class="bar-r">${bar(r.c, r.cNet, nC, "")}</div>
    </div>
    <div class="legs">${legKv("rh", r.r, r.mr, r.bufR, r.fundR)}${legKv("core", r.c, r.mc, r.bufC, r.fundC)}</div>
    <ul class="reasons ${r.state === "ok" ? "" : r.state === "warn" ? "" : ""}">${r.reasons.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>
  </article>`;
}

async function check(addr) {
  const err = $("err"), go = $("go"), res = $("result");
  const run = ++S.run;                       // a newer check() makes this one stale
  const stale = () => run !== S.run;
  err.hidden = true;
  addr = addr.trim();
  if (!L.isAddress(addr)) { err.hidden = false; err.textContent = "That does not look like a wallet address: 0x followed by 40 hex characters."; return; }
  S.address = addr;
  go.disabled = true; go.textContent = "Checking…";
  res.hidden = false;
  res.innerHTML = `<p class="loading" style="padding-top:20px">Reading both venues…</p>`;
  try {
    if (!S.markets.length) await loadMarkets();
    const [rh, core] = await Promise.all([loadVenue("rh", addr), loadVenue("core", addr)]);
    if (stale()) return;
    S.wallet = { rh, core };
    const rows = L.analysePairs(rh.legs, core.legs, S.bySym);
    const fundDay = rows.reduce((s, r) => s + (r.fundPair || 0), 0);
    const netDelta = rows.reduce((s, r) => s + Math.abs(r.deltaUsd || 0), 0); // per-market, no cross-asset netting
    const counts = rows.reduce((c, r) => ((c[r.state] = (c[r.state] || 0) + 1), c), {});
    const health = rows.length ? (counts.bad ? `${counts.bad} need action` : counts.warn ? `${counts.warn} need a tweak` : "All hedged") : "No positions";
    res.innerHTML = `
      <div class="res-head"><h2>Wallet <code>${esc(addr.slice(0, 6))}…${esc(addr.slice(-4))}</code></h2>
        <div class="share-row"><button class="btn btn-line" type="button" id="copy-link">Copy link</button><button class="btn btn-line" type="button" id="refresh">Refresh</button></div></div>
      <div class="stats">
        <div class="stat"><div class="l">Equity, both venues</div><div class="v">${usd(rh.equity + core.equity)}</div><div class="s">RH ${usd(rh.equity, 0)} · Core ${usd(core.equity, 0)}</div></div>
        <div class="stat"><div class="l">Hedge status</div><div class="v ${counts.bad ? "neg" : counts.warn ? "" : rows.length ? "pos" : ""}">${esc(health)}</div><div class="s">${rows.length} market${rows.length === 1 ? "" : "s"} with positions</div></div>
        <div class="stat"><div class="l">Unhedged exposure</div><div class="v ${netDelta > 50 ? "neg" : ""}">${usd(netDelta, 0)}</div><div class="s">sum of |delta| across markets</div></div>
        <div class="stat"><div class="l">Pair funding now</div><div class="v ${cls(fundDay)}">${usd(fundDay)}<span class="muted" style="font-size:14px">/day</span></div><div class="s">at current rates</div></div>
        <div class="stat"><div class="l">${CONFIG.volumeDays}-day volume</div><div class="v" id="vol-total"><span class="loading">counting…</span></div><div class="s" id="vol-split">RH + Core, from the explorers</div></div>
      </div>
      <div class="venues">${venueCard("rh", rh)}${venueCard("core", core)}</div>
      <div class="pairs-head"><h2 style="font-size:22px">Positions by market</h2>
        <div class="legend"><span><i style="background:var(--rh)"></i>Lighter RH</span><span><i style="background:var(--core)"></i>Lighter Core</span></div></div>
      ${rows.length ? rows.map(pairCard).join("") : `<div class="empty-state"><b>No open positions on either venue.</b><p class="muted" style="margin:6px 0 0">If you just opened one, give it a minute and press Refresh. To start a hedge, pick a market <a href="#markets">below</a> and size it in the <a href="#calc">calculator</a>.</p></div>`}`;
    history.replaceState(null, "", "#" + addr);
    $("copy-link").onclick = async () => {
      try { await navigator.clipboard.writeText(location.href); $("copy-link").textContent = "Link copied"; } catch (e) { prompt("Copy this link", location.href); }
    };
    $("refresh").onclick = () => check(addr);
    bindPointsForms(addr, run);
    // slow, optional parts
    loadVolumes(addr, rh, core, run);
    for (const k of ["rh", "core"]) {
      const tok = store.get(tokenKey(k, addr));
      if (tok) showPoints(k, addr, tok, run);
    }
  } catch (e) {
    if (stale()) return;
    res.innerHTML = "";
    err.hidden = false; err.textContent = e.message;
  } finally {
    if (!stale()) { go.disabled = false; go.textContent = "Check"; }
  }
}

async function loadVolumes(addr, rh, core, run) {
  const vols = {};
  await Promise.all([["rh", rh], ["core", core]].map(async ([k, d]) => {
    if (d.missing) { vols[k] = { total: 0, maker: 0, taker: 0 }; $(`vol-${k}`) && ($(`vol-${k}`).innerHTML = "—"); return; }
    try { vols[k] = await loadVolume(k, addr, d.indices); }
    catch (e) { vols[k] = { error: e.message }; }
    if (S.run === run && $(`vol-${k}`)) $(`vol-${k}`).innerHTML = volText(vols[k]);
  }));
  if (S.run !== run || !$("vol-total")) return;
  if (vols.rh.error && vols.core.error) { $("vol-total").innerHTML = '<span class="muted">unavailable</span>'; return; }
  const t = (vols.rh.total || 0) + (vols.core.total || 0), mk = (vols.rh.maker || 0) + (vols.core.maker || 0);
  $("vol-total").textContent = (vols.rh.capped || vols.core.capped ? "≥ " : "") + usdc(t);
  $("vol-split").textContent = `RH ${usdc(vols.rh.total || 0)} · Core ${usdc(vols.core.total || 0)} · ${t ? Math.round((mk / t) * 100) : 0}% maker`;
}

async function showPoints(k, addr, token, run) {
  const el = $(`pts-${k}`); if (!el || S.run !== run) return;
  const d = S.wallet && S.wallet[k];
  const main = d && (d.raw.find((a) => a.account_type === 0) || d.raw[0]);
  if (!main) { el.textContent = "—"; return; }
  el.innerHTML = '<span class="loading">loading…</span>';
  try {
    const p = await loadPoints(k, addr, token, accIdx(main));
    if (S.run !== run) return;
    const pts = p.live ?? L.num(p.lbPoints);
    el.innerHTML = `${pts == null ? "—" : fmt(pts, 2)}${p.rank ? ` <span class="muted">· #${fmt(L.num(p.rank), 0)}</span>` : ""}`;
  } catch (e) {
    if (S.run !== run) return;
    el.innerHTML = `<span class="neg" title="${esc(e.message)}">token rejected</span>`;
  }
}

function bindPointsForms(addr, run) {
  document.querySelectorAll(".points-form form").forEach((f) => {
    f.addEventListener("submit", (e) => {
      e.preventDefault();
      const k = f.dataset.venue;
      const val = f.token.value.trim();
      if (!val || /^•+$/.test(val)) return;
      if (S.run !== run) return;            // a newer check replaced this card
      store.set(tokenKey(k, addr), val);
      f.token.value = "••••••••";
      showPoints(k, addr, val, run);
    });
  });
  document.querySelectorAll("[data-forget]").forEach((b) => b.addEventListener("click", () => {
    store.set(tokenKey(b.dataset.forget, addr), null);
    check(addr);
  }));
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
function initChrome() {
  document.querySelectorAll(".ref-link").forEach((a) => (a.href = refUrl(a.dataset.venue)));
  document.querySelectorAll(".ref-code").forEach((x) => (x.textContent = CONFIG.referralCode));
  $("repo").href = CONFIG.repoUrl;
  $("theme").addEventListener("click", () => {
    const cur = document.documentElement.dataset.theme || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    const next = cur === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    store.set("hc-theme", next);
  });
  $("form").addEventListener("submit", (e) => { e.preventDefault(); check($("addr").value); });
  $("calc-form").addEventListener("input", renderCalc);
  $("calc-form").addEventListener("change", renderCalc);
}

async function boot() {
  initChrome();
  const weekP = loadWeekly().then(renderWeek).catch((e) => console.error(e));
  let hash = "";
  try { hash = decodeURIComponent(location.hash.slice(1)); } catch (e) { /* malformed hash */ }
  try {
    await loadMarkets();
    await weekP;
    renderFilters(); renderTable(); bindTable();
    fillCalcMarkets(); renderCalc();
    $("updated").textContent = `Market data loaded ${S.loadedAt.toLocaleString()}`;
  } catch (e) {
    $("mkt-table").querySelector("tbody").innerHTML = `<tr><td class="err">${esc(e.message)}</td></tr>`;
    $("calc-out").innerHTML = `<p class="err">${esc(e.message)}</p>`;
  }
  renderAnnouncements();
  if (L.isAddress(hash)) { $("addr").value = hash; check(hash); }
}
boot();
