// lib.js — pure logic for Hedge Check. No DOM, no network. Unit-tested in tests/lib.test.mjs.
//
// Units, verified against the live API and the Lighter UI (2026-09-13 / 2026-10-03):
//  * /api/v1/funding-rates `rate` is a fraction per 8 hours (0.000032 = 0.0004%/h in the UI).
//  * orderBookDetails `maintenance_margin_fraction` is in 1/10000 (120 = 1.2%).
//  * account positions `initial_margin_fraction` is a percent string ("33.33" = 3x).
//  * account positions `sign`: 1 = long, -1 = short.
//  * Core `strategy_index` groups markets (2 crypto, 3 commodities, 4 FX, 5 US equities/ETFs,
//    6 Asian equities, 7 pre-IPO). The RH instance reports 0 for everything, so categories
//    come from Core.

export const FUNDING_PERIOD_HOURS = 8;

export const num = (s) => {
  const v = typeof s === "number" ? s : parseFloat(s);
  return Number.isFinite(v) ? v : null;
};

// ---------------------------------------------------------------------------
// Markets
// ---------------------------------------------------------------------------

const ETFS = new Set(["SPY", "QQQ", "IWM", "DIA", "SOXL", "SOXS", "SOXX", "EWY", "URA", "BOTZ",
  "MAGS", "KORU", "DRAM", "SGOV", "SLV", "USO", "GLD", "US500", "US100", "US10Y"]);

export const CATEGORY_LABELS = {
  crypto: "Crypto", stock: "Stock", etf: "ETF / index", preipo: "Pre-IPO",
  commodity: "Commodity", fx: "FX", other: "Other",
};

export function categorize(symbol, strategyIndex) {
  const s = String(symbol).toUpperCase();
  if (ETFS.has(s)) return "etf";
  switch (strategyIndex) {
    case 2: return "crypto";
    case 3: return "commodity";
    case 4: return "fx";
    case 5: case 6: return "stock";
    case 7: return "preipo";
    default: return "other";
  }
}

function side(d, fundingRate) {
  if (!d) return null;
  return {
    id: d.market_id,
    status: d.status,
    active: d.status === "active" && !(d.market_config && d.market_config.force_reduce_only),
    mark: num(d.mark_price),
    index: num(d.index_price),
    vol24: num(d.daily_quote_token_volume) || 0,
    oiBase: num(d.open_interest) || 0,
    oiUsd: (num(d.open_interest) || 0) * (num(d.mark_price) || 0),
    mmf: (num(d.maintenance_margin_fraction) || 0) / 10000,
    maxLev: d.min_initial_margin_fraction ? Math.floor(10000 / d.min_initial_margin_fraction) : null,
    sizeDecimals: d.supported_size_decimals ?? d.size_decimals,
    minBase: num(d.min_base_amount) || 0,
    minQuote: num(d.min_quote_amount) || 0,
    takerFee: num(d.taker_fee),
    makerFee: num(d.maker_fee),
    fundingRate: fundingRate ?? null,             // per 8h, null if unknown
  };
}

/**
 * Merge both instances into one list keyed by symbol.
 * rhDetails/coreDetails: order_book_details arrays (perps only).
 * rhFunding/coreFunding: funding_rates arrays (all exchanges; only exchange=lighter used).
 */
export function buildMarkets(rhDetails, coreDetails, rhFunding, coreFunding) {
  const fmap = (arr) => {
    const m = {};
    for (const f of arr || []) if (f.exchange === "lighter" && num(f.rate) != null) m[String(f.symbol).toUpperCase()] = num(f.rate);
    return m;
  };
  const rf = fmap(rhFunding), cf = fmap(coreFunding);
  const perps = (arr) => (arr || []).filter((d) => !d.market_type || d.market_type === "perp");
  const core = Object.fromEntries(perps(coreDetails).map((d) => [String(d.symbol).toUpperCase(), d]));
  const rh = Object.fromEntries(perps(rhDetails).map((d) => [String(d.symbol).toUpperCase(), d]));
  const symbols = new Set([...Object.keys(rh), ...Object.keys(core)]);
  const out = [];
  for (const s of symbols) {
    const c = core[s], r = rh[s];
    out.push({
      symbol: s,
      category: categorize(s, c ? c.strategy_index : r ? r.strategy_index : null),
      rh: side(r, rf[s]),
      core: side(c, cf[s]),
    });
  }
  return out;
}

export const onBoth = (m) => !!(m.rh && m.core && m.rh.active && m.core.active);

// ---------------------------------------------------------------------------
// Funding
// ---------------------------------------------------------------------------

export const perDay = (rate) => rate * (24 / FUNDING_PERIOD_HOURS);

/** Daily $ for one leg: longs pay positive funding, shorts receive it. */
export function legFundingDay(rate, sign, notional) {
  if (rate == null || !Number.isFinite(rate)) return null;
  return -Math.sign(sign) * perDay(rate) * Math.abs(notional);
}

/**
 * Daily funding of a delta-neutral pair, as a fraction of one leg's notional.
 * longOn = "rh" -> long RH + short Core; "core" -> long Core + short RH.
 */
export function pairFundingDay(m, longOn) {
  if (!m.rh || !m.core || m.rh.fundingRate == null || m.core.fundingRate == null) return null;
  const longRate = longOn === "rh" ? m.rh.fundingRate : m.core.fundingRate;
  const shortRate = longOn === "rh" ? m.core.fundingRate : m.rh.fundingRate;
  return perDay(shortRate - longRate);
}

// ---------------------------------------------------------------------------
// Positions
// ---------------------------------------------------------------------------

/** Aggregate /api/v1/account `accounts[]` into per-symbol legs (sub-accounts summed). */
export function aggregateLegs(accounts) {
  const legs = {};
  let equity = 0, available = 0, collateral = 0;
  for (const acc of accounts || []) {
    equity += num(acc.total_asset_value) ?? num(acc.collateral) ?? 0;
    available += num(acc.available_balance) || 0;
    collateral += num(acc.collateral) || 0;
    for (const p of acc.positions || []) {
      const size = Math.abs(num(p.position) || 0);
      if (size === 0) continue;
      if (p.sign !== 1 && p.sign !== -1) throw new Error(`Unexpected position sign ${p.sign} for ${p.symbol}`);
      const sym = String(p.symbol).toUpperCase();
      const l = legs[sym] || (legs[sym] = {
        symbol: sym, net: 0, parts: [], upnl: 0, rpnl: 0, funding: 0, value: 0, margin: 0, isolated: false,
      });
      l.net += p.sign * size;
      l.upnl += num(p.unrealized_pnl) || 0;
      l.rpnl += num(p.realized_pnl) || 0;
      l.funding += num(p.total_funding_paid_out) || 0;
      l.value += Math.abs(num(p.position_value) || 0);
      l.margin += num(p.allocated_margin) || 0;
      l.isolated = l.isolated || p.margin_mode === 1;
      const imfPct = num(p.initial_margin_fraction);
      l.parts.push({
        account: acc.account_index ?? acc.index, sign: p.sign, size,
        entry: num(p.avg_entry_price), liq: num(p.liquidation_price),
        leverage: imfPct ? 100 / imfPct : null,
      });
    }
  }
  for (const l of Object.values(legs)) {
    const tot = l.parts.reduce((s, a) => s + a.size, 0);
    l.entry = tot ? l.parts.reduce((s, a) => s + (a.entry || 0) * a.size, 0) / tot : null;
    const liqs = l.parts.map((a) => a.liq).filter((x) => x && x > 0);
    // nearest liquidation for the leg's direction
    l.liq = liqs.length ? (l.net > 0 ? Math.max(...liqs) : Math.min(...liqs)) : null;
    const levs = l.parts.map((a) => a.leverage).filter(Boolean);
    l.leverage = levs.length ? Math.max(...levs) : null;
  }
  return { equity, available, collateral, accounts: (accounts || []).length, legs,
    indices: (accounts || []).map((a) => String(a.account_index ?? a.index)) };
}

/** Distance from mark to liquidation as % of mark, direction-aware. null if unknown. */
export function liqBufferPct(net, liq, mark) {
  if (!liq || !mark || !net) return null;
  return (net > 0 ? (mark - liq) / mark : (liq - mark) / mark) * 100;
}

export const DEFAULT_THRESHOLDS = { deltaWarnPct: 1, deltaBadPct: 25, liqWarnPct: 25, liqBadPct: 12 };

/**
 * Pair RH and Core legs by symbol and grade each pair.
 * Returns rows sorted worst first.
 */
export function analysePairs(rhLegs, coreLegs, marketsBySymbol, t = DEFAULT_THRESHOLDS) {
  const syms = new Set([...Object.keys(rhLegs), ...Object.keys(coreLegs)]);
  const rows = [];
  for (const sym of syms) {
    const r = rhLegs[sym] || null, c = coreLegs[sym] || null;
    const m = marketsBySymbol[sym] || {};
    const mr = m.rh ? m.rh.mark : null, mc = m.core ? m.core.mark : null;
    const rNet = r ? r.net : 0, cNet = c ? c.net : 0;
    const gross = Math.max(Math.abs(rNet), Math.abs(cNet));
    const delta = rNet + cNet;
    const deltaPct = gross ? (Math.abs(delta) / gross) * 100 : 0;
    const mark = mr || mc || 0;
    const deltaUsd = delta * mark;
    const bufR = r ? liqBufferPct(rNet, r.liq, mr) : null;
    const bufC = c ? liqBufferPct(cNet, c.liq, mc) : null;
    const fundR = r && m.rh ? legFundingDay(m.rh.fundingRate, rNet, rNet * (mr || 0)) : r ? null : 0;
    const fundC = c && m.core ? legFundingDay(m.core.fundingRate, cNet, cNet * (mc || 0)) : c ? null : 0;
    const fundPair = (fundR ?? 0) + (fundC ?? 0);
    const upnl = (r ? r.upnl : 0) + (c ? c.upnl : 0);

    let state = "ok";
    const reasons = [];
    const oneLeg = !r || !c;
    const sameDir = !!(r && c && Math.sign(rNet) === Math.sign(cNet));
    let kind = "pair";
    if (oneLeg) {
      kind = "single";
      state = "bad";
      reasons.push(`Only one leg (${r ? "RH" : "Core"}): this is a directional position, not a hedge.`);
    } else if (sameDir) {
      kind = "same";
      state = "bad";
      reasons.push("Both legs point the same way: exposure doubled, not hedged.");
    }
    for (const [name, b] of [["RH", bufR], ["Core", bufC]]) {
      if (b == null) continue;
      if (b < t.liqBadPct) { state = "bad"; reasons.push(`${name} leg is ${b.toFixed(1)}% from liquidation. Add margin.`); }
      else if (b < t.liqWarnPct) { if (state === "ok") state = "warn"; reasons.push(`${name} leg is ${b.toFixed(1)}% from liquidation.`); }
    }
    if (!oneLeg && !sameDir) {
      if (deltaPct > t.deltaBadPct) {
        state = "bad";
        reasons.push(`Legs differ by ${deltaPct.toFixed(1)}%: ${fmtSigned(delta)} ${sym} is unhedged. Match sizes in coins.`);
      } else if (deltaPct > t.deltaWarnPct) {
        if (state === "ok") state = "warn";
        reasons.push(`Legs differ by ${deltaPct.toFixed(2)}%. Match sizes in coins.`);
      }
      if (fundPair < 0) reasons.push(`The pair pays ${Math.abs(fundPair).toFixed(2)} $/day in funding.`);
    }
    if (!reasons.length) reasons.push("Balanced hedge, healthy margin.");
    rows.push({ symbol: sym, kind, r, c, mr, mc, rNet, cNet, delta, deltaPct, deltaUsd,
      bufR, bufC, fundR, fundC, fundPair, upnl, state, reasons, category: m.category || "other" });
  }
  const rank = { bad: 0, warn: 1, ok: 2 };
  rows.sort((a, b) => rank[a.state] - rank[b.state] || Math.abs(b.deltaUsd) - Math.abs(a.deltaUsd));
  return rows;
}

function fmtSigned(x) {
  const s = Math.abs(x) >= 1 ? x.toFixed(4) : x.toPrecision(4);
  return (x > 0 ? "+" : "") + String(parseFloat(s));
}

// ---------------------------------------------------------------------------
// Volume from explorer logs
// ---------------------------------------------------------------------------

const TRADE_TYPES = {
  Trade: "trade_pubdata",
  TradeWithFunding: "trade_pubdata_with_funding",
  LiquidationTrade: "liquidation_trade_pubdata",
  LiquidationTradeWithFunding: "liquidation_trade_pubdata_with_funding",
};

/** First trade-like pubdata object of a log, whatever its key is called. */
export function tradeOf(log) {
  if (!log || !log.pubdata) return null;
  const key = TRADE_TYPES[log.pubdata_type];
  if (key && log.pubdata[key]) return log.pubdata[key];
  if (!/Trade/.test(log.pubdata_type || "")) return null;
  for (const v of Object.values(log.pubdata)) if (v && v.price != null && v.size != null) return v;
  return null;
}

/**
 * Sum the user's traded notional.
 * logs: explorer logs (newest first, any order works).
 * myIdx: Set of the user's account indices as strings.
 * symbolOf: (market_index) => symbol | undefined
 */
export function tradeVolume(logs, myIdx, symbolOf, sinceMs) {
  const res = { total: 0, maker: 0, taker: 0, trades: 0, bySymbol: {}, oldestMs: null };
  const seen = new Set();
  for (const log of logs || []) {
    const t = Date.parse(log.time);
    if (Number.isFinite(t)) res.oldestMs = res.oldestMs == null ? t : Math.min(res.oldestMs, t);
    if (sinceMs && Number.isFinite(t) && t < sinceMs) continue;
    const tr = tradeOf(log);
    if (!tr) continue;
    const key = `${log.hash}:${tr.maker_account_index}:${tr.taker_account_index}:${tr.price}:${tr.size}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const notional = (num(tr.price) || 0) * (num(tr.size) || 0);
    const isMaker = myIdx.has(String(tr.maker_account_index));
    const isTaker = myIdx.has(String(tr.taker_account_index));
    if (!isMaker && !isTaker) continue;
    // a self-match would be counted from both sides by the exchange; count it once here
    res.total += notional;
    if (isMaker) res.maker += notional; else res.taker += notional;
    res.trades += 1;
    const sym = symbolOf(tr.market_index) || `#${tr.market_index}`;
    res.bySymbol[sym] = (res.bySymbol[sym] || 0) + notional;
  }
  return res;
}

// ---------------------------------------------------------------------------
// Pair calculator
// ---------------------------------------------------------------------------

const floorTo = (x, d) => { const f = 10 ** d; return Math.floor(x * f + 1e-9) / f; };

/** Isolated-margin liquidation estimate at entry, ignoring fees and funding. */
export function estLiq(entry, leverage, mmf, isLong) {
  if (!entry || !leverage) return null;
  return isLong ? (entry * (1 - 1 / leverage)) / (1 - mmf) : (entry * (1 + 1 / leverage)) / (1 + mmf);
}

/**
 * Size a delta-neutral pair.
 * notionalUsd: size of EACH leg in $. longOn: "rh" | "core".
 * Returns sizes in coins rounded down to a precision accepted by BOTH markets.
 */
export function pairCalc(m, notionalUsd, leverage, longOn = "rh") {
  if (!m || !m.rh || !m.core) return { error: "This market is not listed on both venues." };
  const price = m.rh.mark && m.core.mark ? (m.rh.mark + m.core.mark) / 2 : (m.rh.mark || m.core.mark);
  if (!price) return { error: "No mark price." };
  const dec = Math.min(m.rh.sizeDecimals ?? 4, m.core.sizeDecimals ?? 4);
  const size = floorTo(notionalUsd / price, dec);
  const minBase = Math.max(m.rh.minBase || 0, m.core.minBase || 0);
  const minQuote = Math.max(m.rh.minQuote || 0, m.core.minQuote || 0);
  const tooSmall = size <= 0 || size < minBase || size * price < minQuote;
  const maxLev = Math.min(m.rh.maxLev || Infinity, m.core.maxLev || Infinity);
  const lev = Math.min(leverage, Number.isFinite(maxLev) ? maxLev : leverage);
  const longVenue = longOn, shortVenue = longOn === "rh" ? "core" : "rh";
  const legs = {
    [longVenue]: { side: "long", mark: m[longVenue].mark, liq: estLiq(m[longVenue].mark, lev, m[longVenue].mmf, true) },
    [shortVenue]: { side: "short", mark: m[shortVenue].mark, liq: estLiq(m[shortVenue].mark, lev, m[shortVenue].mmf, false) },
  };
  for (const v of ["rh", "core"]) {
    legs[v].notional = size * (legs[v].mark || price);
    legs[v].margin = legs[v].notional / lev;
    legs[v].bufferPct = legs[v].liq ? Math.abs(legs[v].mark - legs[v].liq) / legs[v].mark * 100 : null;
  }
  const pf = pairFundingDay(m, longOn);
  return {
    size, decimals: dec, price, leverage: lev, leverageCapped: lev < leverage, minBase, minQuote, tooSmall,
    legs, fundingDayUsd: pf == null ? null : pf * size * price,
    totalMargin: legs.rh.margin + legs.core.margin,
  };
}

// ---------------------------------------------------------------------------
// Weekly notes
// ---------------------------------------------------------------------------

/** Newest week entry and whether it is older than 7 days. */
export function latestWeek(weekly, nowMs = Date.now()) {
  const weeks = [...((weekly && weekly.weeks) || [])].sort((a, b) => b.week_of.localeCompare(a.week_of));
  if (!weeks.length) return null;
  const w = weeks[0];
  const start = Date.parse(w.week_of + "T00:00:00Z");
  return { week: w, stale: nowMs - start > 7 * 86400e3, rest: weeks.slice(1) };
}

/** Does a weekly boost apply to this market? */
export function boostFor(week, m) {
  if (!week) return null;
  for (const b of week.boosts || []) {
    const symOk = !b.symbols || b.symbols.map((s) => s.toUpperCase()).includes(m.symbol);
    const catOk = !b.categories || b.categories.includes(m.category);
    if (symOk && catOk) return b;
  }
  return null;
}

export const isAddress = (s) => /^0x[0-9a-fA-F]{40}$/.test(String(s || "").trim());
