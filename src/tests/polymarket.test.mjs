/**
 * Tests for the Polymarket provider.
 *
 * The live API could not be reached from the session that wrote the provider,
 * so these pin the two things that can be tested without it: that the response
 * parsing survives the shapes Gamma is known to return (arrays sometimes
 * arrive as JSON-encoded strings), and that the cross-venue comparison maths
 * is right. The field mapping itself needs `npm run verify:sources` run
 * somewhere the host answers.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dist = (p) => join(__dirname, "..", "..", "dist", p);
const polymarket = await import(dist("providers/polymarket.js"));

const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? "value"}: expected ~${b}, got ${a}`);

describe("polymarket provider", () => {
  const tools = new Map();
  let realFetch, lastUrl;
  let payload = [];

  before(() => {
    polymarket.register({ tool: (name, description, schema, handler) => tools.set(name, handler) });
    realFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      lastUrl = String(url);
      return { ok: true, status: 200, statusText: "OK", headers: new Headers(), json: async () => payload, text: async () => JSON.stringify(payload) };
    };
  });
  after(() => { globalThis.fetch = realFetch; });

  const call = async (name, args) => {
    const result = await tools.get(name)(args ?? {});
    assert.notEqual(result.isError, true, result.content[0].text);
    return JSON.parse(result.content[0].text);
  };

  it("reads arrays whether they arrive as arrays or as JSON strings", async () => {
    // Gamma has served both forms for these fields.
    payload = [
      { id: "1", slug: "a", question: "Team A to win?", outcomes: '["Yes","No"]', outcomePrices: '["0.62","0.38"]', clobTokenIds: '["t1","t2"]', liquidity: "1500.5", volume: "90000" },
      { id: "2", slug: "b", question: "Team B to win?", outcomes: ["Yes", "No"], outcomePrices: [0.25, 0.75], clobTokenIds: ["t3", "t4"], liquidity: 300, volume: 1200 },
    ];
    const data = await call("polymarket_get_markets", { limit: 2 });
    assert.equal(data.count, 2);
    assert.equal(data.markets[0].outcomes[0].name, "Yes");
    close(data.markets[0].outcomes[0].probability, 0.62, 1e-6);
    close(data.markets[0].outcomes[0].implied_odds, 1 / 0.62, 1e-3, "probability becomes decimal odds");
    assert.equal(data.markets[0].outcomes[0].token_id, "t1");
    close(data.markets[0].booksum, 1.0, 1e-6, "the two sides sum to one on a clean market");
    close(data.markets[1].outcomes[1].implied_odds, 1 / 0.75, 1e-3);
    assert.equal(data.markets[1].liquidity_usd, 300);
  });

  it("survives a market with fields missing entirely", async () => {
    payload = [{ id: "3" }, { id: "4", outcomes: "not json", outcomePrices: null }];
    const data = await call("polymarket_get_markets", {});
    assert.equal(data.count, 2);
    assert.deepEqual(data.markets[0].outcomes, []);
    assert.equal(data.markets[0].booksum, undefined);
  });

  it("reads an order book and prices the round trip", async () => {
    payload = {
      bids: [{ price: "0.60", size: "500" }, { price: "0.59", size: "1200" }],
      asks: [{ price: "0.63", size: "400" }, { price: "0.64", size: "900" }],
    };
    const data = await call("polymarket_get_order_book", { token_id: "t1", depth: 2 });
    assert.match(lastUrl, /clob\.polymarket\.com\/book/);
    close(data.best_bid.price, 0.60, 1e-9);
    close(data.best_ask.price, 0.63, 1e-9);
    close(data.spread, 0.03, 1e-9);
    close(data.cost_to_cross_pct, 5, 0.01, "3 cents on a 60-cent price is a 5% round trip");
    assert.equal(data.depth_usd.bid, 1700);
    assert.equal(data.bids[0].implied_odds > 1, true);
  });

  it("says which venue is offering more, after the fee", async () => {
    // 0.50 on the exchange is 2.00; the book offers 1.95.
    const data = await call("polymarket_compare_to_book", { polymarket_probability: 0.5, bookmaker_odds: 1.95 });
    assert.equal(data.better_price, "polymarket");
    close(data.polymarket.implied_odds, 2.0, 1e-9);
    close(data.difference_pct, (2.0 / 1.95 - 1) * 100, 0.01);
    // A 10% fee turns 2.00 into 1.90 and flips the answer.
    const withFee = await call("polymarket_compare_to_book", { polymarket_probability: 0.5, bookmaker_odds: 1.95, fee_pct: 10 });
    close(withFee.polymarket.after_fee, 1.9, 1e-9);
    assert.equal(withFee.better_price, "bookmaker");
  });

  it("finds a cross-venue arbitrage and names the route", async () => {
    // Exchange has the outcome at 0.40 (2.50); the book pays 1.80 on the other side.
    const data = await call("polymarket_compare_to_book", {
      polymarket_probability: 0.40, bookmaker_odds: 2.20, bookmaker_odds_against: 1.80,
    });
    assert.equal(data.arbitrage.is_arbitrage, true);
    // booksum is reported rounded to 5dp.
    close(data.arbitrage.booksum, 1 / 2.5 + 1 / 1.8, 1e-4);
    assert.match(data.arbitrage.route, /Polymarket|book/);
    assert.ok(data.arbitrage.profit_pct > 0);
    assert.ok(data.caveats.some((c) => /size behind it/.test(c)), "a quoted price without depth is flagged");
  });

  it("reports no arbitrage when the two venues agree", async () => {
    const data = await call("polymarket_compare_to_book", {
      polymarket_probability: 0.5, bookmaker_odds: 1.95, bookmaker_odds_against: 1.95,
    });
    assert.equal(data.arbitrage.is_arbitrage, false);
  });

  it("states plainly that the measured edge does not transfer", async () => {
    const data = await call("polymarket_explain", {});
    assert.match(JSON.stringify(data.what_does_not_change), /does not transfer|disagreement among books/);
    assert.match(data.verification, /could not be called|verify:sources/);
  });

  it("reads the trade tape and weighs it by size", async () => {
    payload = [
      { price: "0.60", size: "100", side: "BUY", outcome: "Yes", match_time: "1" },
      { price: "0.65", size: "900", side: "BUY", outcome: "Yes", match_time: "2" },
      { price: "0.55", size: "0", side: "SELL", outcome: "Yes", match_time: "3" },
      { price: "not a price", size: "50" },
    ];
    const data = await call("polymarket_get_trades", { market: "0xabc", limit: 10 });
    assert.match(lastUrl, /clob\.polymarket\.com\/data\/trades/);
    assert.equal(data.fills, 3, "the unparseable price is dropped, the zero-size fill is kept as a fill");
    assert.equal(data.volume_usd, 1000);
    // 100 @ 0.60 + 900 @ 0.65 = 0.645, not the 0.60 a simple average would give.
    close(data.vwap, 0.645, 1e-6, "volume-weighted, not fill-weighted");
    assert.equal(data.largest_fills[0].size, 900);
  });

  it("needs to be told which market to read the tape of", async () => {
    const result = await tools.get("polymarket_get_trades")({});
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /market condition id or a token id/);
  });

  it("builds a quote out of three calls and tolerates the ones that fail", async () => {
    let call_n = 0;
    const saved = globalThis.fetch;
    globalThis.fetch = async (url) => {
      call_n++;
      const u = String(url);
      // An outcome with no trades yet: midpoint and spread exist, last does not.
      if (u.includes("/last-trade-price")) throw new Error("404 no trades");
      const body = u.includes("/midpoint") ? { mid: "0.42" } : { spread: "0.02" };
      return { ok: true, status: 200, statusText: "OK", headers: new Headers(), json: async () => body, text: async () => JSON.stringify(body) };
    };
    try {
      const data = await call("polymarket_get_quote", { token_id: "t1" });
      assert.equal(call_n, 3, "all three are attempted");
      close(data.midpoint, 0.42, 1e-9);
      close(data.spread, 0.02, 1e-9);
      close(data.cost_to_cross_pct, 100 * 0.02 / 0.42, 0.01);
      assert.equal(data.last_trade, undefined, "no last price, and that is not an error");
      close(data.midpoint_implied_odds, 1 / 0.42, 1e-3);
    } finally {
      globalThis.fetch = saved;
    }
  });
});
