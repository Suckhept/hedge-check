// node --test tests/
import test from "node:test";
import assert from "node:assert/strict";
import * as L from "../lib.js";

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);

// Shapes copied from live API responses (2026-10-03).
const coreDetail = (o) => ({ market_type: "perp", status: "active", market_config: { force_reduce_only: false },
  maintenance_margin_fraction: 600, min_initial_margin_fraction: 1000, supported_size_decimals: 4,
  min_base_amount: "0.0100", min_quote_amount: "10.000000", daily_quote_token_volume: 1e6, open_interest: 100,
  taker_fee: "0.0000", maker_fee: "0.0000", strategy_index: 5, ...o });

const RH = [
  coreDetail({ symbol: "AAPL", market_id: 10, mark_price: "334.00", strategy_index: 0, supported_size_decimals: 4 }),
  coreDetail({ symbol: "BTC", market_id: 1, mark_price: "84500.0", strategy_index: 0, supported_size_decimals: 5,
    maintenance_margin_fraction: 120, min_initial_margin_fraction: 200, min_base_amount: "0.00020" }),
  coreDetail({ symbol: "SOFI", market_id: 54, mark_price: "20", strategy_index: 0 }),
];
const CORE = [
  coreDetail({ symbol: "AAPL", market_id: 113, mark_price: "334.20", supported_size_decimals: 3, min_base_amount: "0.030" }),
  coreDetail({ symbol: "BTC", market_id: 1, mark_price: "84510.0", strategy_index: 2, supported_size_decimals: 5,
    maintenance_margin_fraction: 120, min_initial_margin_fraction: 200, min_base_amount: "0.00010" }),
  coreDetail({ symbol: "ANTHROPIC", market_id: 193, mark_price: "2132", strategy_index: 7 }),
  coreDetail({ symbol: "SPY", market_id: 128, mark_price: "770", strategy_index: 5 }),
  coreDetail({ symbol: "GME", market_id: 176, mark_price: "21", market_config: { force_reduce_only: true } }),
];
const F = (sym, rate) => ({ exchange: "lighter", symbol: sym, rate });
const RHF = [F("AAPL", 0.000032), F("BTC", 0.000096), { exchange: "binance", symbol: "BTC", rate: 0.0001 }];
const COREF = [F("AAPL", 0.000056), F("BTC", 0.000096)];

const markets = L.buildMarkets(RH, CORE, RHF, COREF);
const bySym = Object.fromEntries(markets.map((m) => [m.symbol, m]));

test("markets merge by symbol, category from Core strategy_index", () => {
  assert.equal(bySym.AAPL.category, "stock");
  assert.equal(bySym.BTC.category, "crypto");
  assert.equal(bySym.ANTHROPIC.category, "preipo");
  assert.equal(bySym.SPY.category, "etf");
  assert.equal(bySym.SOFI.category, "other");            // RH-only: RH reports strategy_index 0
  assert.equal(bySym.AAPL.rh.id, 10);
  assert.equal(bySym.AAPL.core.id, 113);                  // ids differ across venues
  assert.ok(L.onBoth(bySym.AAPL) && !L.onBoth(bySym.SOFI) && !L.onBoth(bySym.ANTHROPIC));
  assert.equal(bySym.GME.core.active, false);              // reduce-only market is not tradable
  close(bySym.BTC.rh.mmf, 0.012);
  assert.equal(bySym.BTC.rh.maxLev, 50);
  assert.equal(bySym.BTC.rh.fundingRate, 0.000096);       // binance row ignored
});

test("funding: 8h rate to daily, leg sign, pair direction", () => {
  close(L.perDay(0.000032), 0.000096);
  close(L.legFundingDay(0.000032, 1, 1000), -0.096);       // long pays
  close(L.legFundingDay(0.000032, -1, 1000), 0.096);       // short receives
  // long RH (pays 0.0032%) + short Core (receives 0.0056%) per 8h
  close(L.pairFundingDay(bySym.AAPL, "rh"), (0.000056 - 0.000032) * 3);
  close(L.pairFundingDay(bySym.AAPL, "core"), (0.000032 - 0.000056) * 3);
  assert.equal(L.pairFundingDay(bySym.SOFI, "rh"), null);
});

const acct = (idx, positions, tav = "1000") => ({ index: idx, account_index: idx, total_asset_value: tav,
  collateral: "10", available_balance: "5", positions });
const pos = (symbol, sign, position, entry, liq, o = {}) => ({ symbol, sign, position, avg_entry_price: entry,
  liquidation_price: liq, unrealized_pnl: "1", realized_pnl: "0", total_funding_paid_out: "-0.1",
  position_value: String(Number(position) * Number(entry)), allocated_margin: "100", margin_mode: 1,
  initial_margin_fraction: "33.33", ...o });

test("aggregateLegs sums sub-accounts, keeps nearest liquidation, reads leverage from percent", () => {
  const a = L.aggregateLegs([
    acct(4724, [pos("AAPL", 1, "20", "330", "225"), pos("BTC", -1, "0.00000", "0", "0")]),
    acct(99, [pos("AAPL", 1, "5", "340", "240")], "500"),
  ]);
  assert.equal(a.equity, 1500);
  assert.equal(a.legs.AAPL.net, 25);
  close(a.legs.AAPL.entry, (20 * 330 + 5 * 340) / 25);
  assert.equal(a.legs.AAPL.liq, 240);                       // nearest for a long = highest
  close(a.legs.AAPL.leverage, 100 / 33.33);
  assert.ok(!("BTC" in a.legs));                             // zero-size rows dropped
  assert.deepEqual(a.indices, ["4724", "99"]);
  assert.throws(() => L.aggregateLegs([acct(1, [pos("X", 0, "1", "1", "0")])]));
});

test("liquidation buffer is direction-aware", () => {
  close(L.liqBufferPct(1, 225, 334), (334 - 225) / 334 * 100);
  close(L.liqBufferPct(-1, 2906.4, 2149), (2906.4 - 2149) / 2149 * 100);
  assert.equal(L.liqBufferPct(1, null, 334), null);
});

test("pairs: real screenshot case (2026-09-13) — XAU ok, ANTHROPIC unhedged", () => {
  const ms = L.buildMarkets(
    [coreDetail({ symbol: "XAU", market_id: 92, mark_price: "4355.34" }), coreDetail({ symbol: "ANTHROPIC", market_id: 5, mark_price: "2116.6" })],
    [coreDetail({ symbol: "XAU", market_id: 92, mark_price: "4353.18", strategy_index: 3 }), coreDetail({ symbol: "ANTHROPIC", market_id: 193, mark_price: "2149.0", strategy_index: 7 })],
    [F("XAU", 0.000032), F("ANTHROPIC", 0.000032)], [F("XAU", 0.000032), F("ANTHROPIC", 0.000032)]);
  const map = Object.fromEntries(ms.map((m) => [m.symbol, m]));
  const rh = L.aggregateLegs([acct(1, [pos("XAU", 1, "0.4156", "4348.53", "2228.54"), pos("ANTHROPIC", 1, "0.05", "2104.1", "1196.6")])]).legs;
  const core = L.aggregateLegs([acct(2, [pos("XAU", -1, "0.4129", "4350.35", "6373.81"), pos("ANTHROPIC", -1, "0.81383", "2139.6", "2906.4")])]).legs;
  const rows = L.analysePairs(rh, core, map);
  const by = Object.fromEntries(rows.map((r) => [r.symbol, r]));
  assert.equal(rows[0].symbol, "ANTHROPIC");                  // worst first
  assert.equal(by.ANTHROPIC.state, "bad");
  close(by.ANTHROPIC.deltaPct, (0.81383 - 0.05) / 0.81383 * 100);
  assert.equal(by.XAU.state, "ok");
  close(by.XAU.bufR, (4355.34 - 2228.54) / 4355.34 * 100);
  close(by.XAU.bufC, (6373.81 - 4353.18) / 4353.18 * 100);
  close(by.XAU.fundPair, -0.000096 * 0.4156 * 4355.34 + 0.000096 * 0.4129 * 4353.18);
});

test("pairs: single leg and same direction are bad", () => {
  const rh = L.aggregateLegs([acct(1, [pos("AAPL", 1, "10", "334", "200"), pos("BTC", 1, "0.01", "84500", "40000")])]).legs;
  const core = L.aggregateLegs([acct(2, [pos("BTC", 1, "0.01", "84500", "40000")])]).legs;
  const by = Object.fromEntries(L.analysePairs(rh, core, bySym).map((r) => [r.symbol, r]));
  assert.equal(by.AAPL.kind, "single"); assert.equal(by.AAPL.state, "bad");
  assert.equal(by.BTC.kind, "same"); assert.equal(by.BTC.state, "bad");
});

test("volume from explorer logs: only my side, maker/taker split, window, dedupe", () => {
  const now = Date.parse("2026-10-03T12:00:00Z");
  const T = (iso, type, key, mk, tk, price, size, hash) => ({ time: iso, hash, pubdata_type: type,
    pubdata: { [key]: { market_index: 113, maker_account_index: mk, taker_account_index: tk, price, size } } });
  const logs = [
    T("2026-10-03T07:05:13Z", "Trade", "trade_pubdata", "999", "741183", "333.543", "1.306", "h1"),
    T("2026-10-03T07:02:05Z", "TradeWithFunding", "trade_pubdata_with_funding", "741183", "723806", "333.545", "0.395", "h2"),
    T("2026-10-03T07:02:05Z", "TradeWithFunding", "trade_pubdata_with_funding", "741183", "723806", "333.545", "0.395", "h2"),
    T("2026-10-03T07:00:00Z", "Trade", "trade_pubdata", "1", "2", "100", "1", "h3"),                  // not mine
    { time: "2026-10-03T06:00:00Z", hash: "h4", pubdata_type: "L1DepositV2", pubdata: { l1_deposit: { amount: "100" } } },
    T("2026-09-20T07:00:00Z", "Trade", "trade_pubdata", "741183", "2", "100", "1", "h5"),           // too old
  ];
  const v = L.tradeVolume(logs, new Set(["741183"]), (id) => (id === 113 ? "AAPL" : undefined), now - 7 * 86400e3);
  close(v.taker, 333.543 * 1.306);
  close(v.maker, 333.545 * 0.395);
  close(v.total, v.maker + v.taker);
  assert.equal(v.trades, 2);
  close(v.bySymbol.AAPL, v.total);
  assert.equal(v.oldestMs, Date.parse("2026-09-20T07:00:00Z"));
});

test("calculator: common size precision, minimums, isolated liquidation estimate", () => {
  const c = L.pairCalc(bySym.AAPL, 1000, 3, "rh");
  assert.equal(c.decimals, 3);                                 // min(4, 3)
  const price = (334 + 334.2) / 2;
  close(c.size, Math.floor((1000 / price) * 1000) / 1000);
  assert.equal(c.tooSmall, false);
  assert.equal(c.legs.rh.side, "long"); assert.equal(c.legs.core.side, "short");
  close(c.legs.rh.liq, (334 * (1 - 1 / 3)) / (1 - 0.06));
  close(c.legs.core.liq, (334.2 * (1 + 1 / 3)) / (1 + 0.06));
  close(c.totalMargin, (c.size * 334 + c.size * 334.2) / 3);
  close(c.fundingDayUsd, L.pairFundingDay(bySym.AAPL, "rh") * c.size * price);
  assert.equal(L.pairCalc(bySym.AAPL, 5, 3).tooSmall, true);   // below $10 min quote
  assert.equal(L.pairCalc(bySym.AAPL, 1000, 50).leverage, 10); // capped by market max leverage
  assert.ok(L.pairCalc(bySym.SOFI, 1000, 3).error);
});

test("weekly: newest first, stale flag, boost matching", () => {
  const w = { weeks: [
    { week_of: "2026-09-07", boosts: [{ scope: "hedge", x: 2.5 }] },
    { week_of: "2026-09-21", boosts: [{ scope: "hedge", categories: ["stock"] }] },
  ] };
  const lw = L.latestWeek(w, Date.parse("2026-10-03T00:00:00Z"));
  assert.equal(lw.week.week_of, "2026-09-21");
  assert.equal(lw.stale, true);
  assert.equal(lw.rest.length, 1);
  assert.ok(L.boostFor(lw.week, bySym.AAPL));
  assert.equal(L.boostFor(lw.week, bySym.BTC), null);
  assert.ok(L.isAddress("0xF12EC92fc728746dCaDfA53bcd18710C7bC1c124"));
  assert.ok(!L.isAddress("0x123"));
});

test("volume: a self-match between two of my accounts counts once", () => {
  const log = { time: "2026-10-03T07:00:00Z", hash: "s1", pubdata_type: "Trade",
    pubdata: { trade_pubdata: { market_index: 113, maker_account_index: 1, taker_account_index: 2, price: "100", size: "2" } } };
  const v = L.tradeVolume([log], new Set(["1", "2"]), () => "AAPL", 0);
  assert.equal(v.total, 200); assert.equal(v.maker, 200); assert.equal(v.taker, 0); assert.equal(v.trades, 1);
});

test("funding: a missing/garbage rate is unknown, not NaN", () => {
  const ms = L.buildMarkets(RH, CORE, [{ exchange: "lighter", symbol: "AAPL", rate: null }, F("BTC", "x")], COREF);
  const m = Object.fromEntries(ms.map((x) => [x.symbol, x]));
  assert.equal(m.AAPL.rh.fundingRate, null);
  assert.equal(m.BTC.rh.fundingRate, null);
  assert.equal(L.pairFundingDay(m.AAPL, "rh"), null);
});

test("calculator: size floors to the common decimals without float drift", () => {
  const m = { rh: { mark: 10, sizeDecimals: 2, mmf: 0.01, maxLev: 10 }, core: { mark: 10, sizeDecimals: 3, mmf: 0.01, maxLev: 10 } };
  assert.equal(L.pairCalc(m, 2.9, 2).size, 0.29);
  assert.equal(L.pairCalc(m, 2.999, 2).size, 0.29);
});

test("drop estimate: pool split pro rata, price from FDV", () => {
  const d = L.dropEstimate(2e9, 2e6, 1000, 11e6, 1e9);
  close(d.price, 2);
  close(d.poolUsd, 22e6);
  close(d.litPerPoint, 5.5);
  close(d.usdPerPoint, 11);
  close(d.myUsd, 11000);
  assert.equal(L.dropEstimate(2e9, 0, 1000, 11e6, 1e9), null);
  assert.equal(L.dropEstimate(2e9, 2e6, "x", 11e6, 1e9).myUsd, 0);
});
