/**
 * Tests for the trading toolkit: the betting maths, the football-data.co.uk
 * normalization, and the backtest engine end-to-end against a stubbed CSV.
 *
 * The maths tests use worked examples with known answers — a Kelly stake or a
 * green-up figure that is silently 5% off is worse than one that throws.
 *
 * Run via: npm test
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dist = (p) => join(__dirname, "..", "..", "dist", p);

// Point the local-CSV drop-in at nothing, so whatever a developer happens to
// have in data/football-data cannot change what these tests see.
process.env.SPORTS_HUB_DATA_DIR = join(__dirname, "fixtures", "no-such-dir");

const {
  devig, kelly, arbitrage, hedge, matchModel, fitRatings, expectedGoals, assessSelections,
} = await import(dist("shared/betting-math.js"));
const { fetchLeagueSeason, parseCsv, parseFdDate, priceFor, toFixtures, toMatches } = await import(dist("shared/football-csv.js"));
const trading = await import(dist("providers/trading.js"));
const { seasonPath, fetchOpenFootballSeason } = await import(dist("shared/openfootball.js"));
const { loadSeasonData } = await import(dist("shared/football-source.js"));

const close = (actual, expected, tolerance, message) =>
  assert.ok(Math.abs(actual - expected) <= tolerance,
    `${message ?? "value"}: expected ~${expected}, got ${actual}`);

describe("de-vigging", () => {
  it("multiplicative returns a fair book that sums to 1", () => {
    const r = devig([2.1, 3.4, 3.6], "multiplicative");
    close(r.probabilities.reduce((a, b) => a + b, 0), 1, 1e-6, "probability sum");
    close(r.booksum, 1 / 2.1 + 1 / 3.4 + 1 / 3.6, 1e-6, "booksum");
    assert.ok(r.overround_pct > 0, "a real book has a margin");
  });

  it("every method produces a normalized book", () => {
    for (const method of ["multiplicative", "additive", "power", "shin"]) {
      const r = devig([1.5, 4.5, 7.0], method);
      // Output probabilities are rounded to 6dp, so the sum can drift a little.
      close(r.probabilities.reduce((a, b) => a + b, 0), 1, 1e-5, `${method} sum`);
      r.fair_odds.forEach((o) => assert.ok(o > 1, `${method} fair odds must exceed 1`));
    }
  });

  it("shin and power shift probability toward the favourite", () => {
    const odds = [1.4, 5.0, 9.0];
    const mult = devig(odds, "multiplicative").probabilities[0];
    assert.ok(devig(odds, "shin").probabilities[0] > mult, "shin favours the favourite");
    assert.ok(devig(odds, "power").probabilities[0] > mult, "power favours the favourite");
  });

  it("falls back rather than emitting a negative probability", () => {
    // A book this lopsided drives the additive method's flat deduction below
    // the longshot's own implied probability.
    const r = devig([1.2, 1.2, 100], "additive");
    r.probabilities.forEach((p) => assert.ok(p > 0, "probabilities stay positive"));
    assert.ok(r.note, "the fallback is reported, not hidden");
  });

  it("rejects odds that are not prices", () => {
    assert.throws(() => devig([1.0, 3.0]), /Invalid decimal odds/);
    assert.throws(() => devig([2.0]), /At least 2 outcomes/);
  });
});

describe("value and staking", () => {
  it("kelly matches the worked example", () => {
    // p=0.4 at 3.0: b=2, f = (0.4*2 - 0.6)/2 = 0.10
    close(kelly(3.0, 0.4), 0.1, 1e-9, "kelly fraction");
  });

  it("kelly is zero or negative with no edge", () => {
    close(kelly(2.0, 0.5), 0, 1e-9, "fair price");
    assert.ok(kelly(2.0, 0.45) < 0, "a bad price is not a bet");
  });

  it("commission lowers both edge and stake", () => {
    assert.ok(kelly(3.0, 0.4, 0.05) < kelly(3.0, 0.4, 0));
  });

  it("assessSelections sizes a quarter-Kelly stake and flags the best bet", () => {
    const r = assessSelections(
      [{ name: "value", odds: 3.0, probability: 0.4 }, { name: "no value", odds: 2.0, probability: 0.4 }],
      { bankroll: 1000, kelly_fraction: 0.25 },
    );
    assert.equal(r.assessments[0].bet, true);
    assert.equal(r.assessments[1].bet, false);
    close(r.assessments[0].stake, 25, 0.01, "quarter Kelly of 10% on 1000");
    close(r.assessments[0].edge_pct, 20, 0.001, "0.4*3.0 - 1 = 20%");
    assert.equal(r.best.name, "value");
    assert.equal(r.assessments[1].stake, 0, "no stake on a negative-EV price");
  });
});

describe("arbitrage", () => {
  it("finds the risk-free book and equalises the return", () => {
    const r = arbitrage([{ name: "A", odds: 2.1 }, { name: "B", odds: 2.1 }], 100);
    assert.equal(r.is_arbitrage, true);
    close(r.profit, 5, 0.01, "5% on turnover");
    const [a, b] = r.allocation;
    close(a.stake, 50, 0.01);
    close(a.returns, b.returns, 0.01, "both legs return the same");
  });

  it("reports a normal book as no arbitrage", () => {
    const r = arbitrage([{ name: "A", odds: 1.9 }, { name: "B", odds: 1.9 }], 100);
    assert.equal(r.is_arbitrage, false);
    assert.ok(r.margin_pct > 0);
  });

  it("commission can erase a thin arbitrage", () => {
    const withCommission = arbitrage([{ name: "A", odds: 2.05 }, { name: "B", odds: 2.05 }], 100, 0.05);
    assert.equal(withCommission.is_arbitrage, false);
  });
});

describe("hedging", () => {
  it("green-up locks the same profit either way", () => {
    const r = hedge({ side: "back", stake: 10, odds: 4.0, hedge_odds: 2.0 });
    close(r.green_up.stake, 20, 1e-9, "lay stake = 10*4/2");
    close(r.green_up.locked_profit, 10, 1e-9);
    close(r.applied.profit_if_win, r.applied.profit_if_lose, 0.01, "equalised");
  });

  it("commission reduces the locked profit", () => {
    const plain = hedge({ side: "back", stake: 10, odds: 4.0, hedge_odds: 2.0 });
    const charged = hedge({ side: "back", stake: 10, odds: 4.0, hedge_odds: 2.0, commission: 0.02 });
    assert.ok(charged.green_up.locked_profit < plain.green_up.locked_profit);
    close(charged.applied.profit_if_win, charged.applied.profit_if_lose, 0.01, "still equalised");
  });

  it("handles a lay position hedged with a back bet", () => {
    const r = hedge({ side: "lay", stake: 10, odds: 2.0, hedge_odds: 4.0 });
    close(r.applied.profit_if_win, r.applied.profit_if_lose, 0.01, "equalised");
    assert.equal(r.green_up.hedge_side, "back");
  });

  it("a partial hedge leaves a position open", () => {
    const r = hedge({ side: "back", stake: 10, odds: 4.0, hedge_odds: 2.0, hedge_stake: 10 });
    assert.notEqual(r.applied.profit_if_win, r.applied.profit_if_lose);
    assert.ok(r.applied.worst_case < r.green_up.locked_profit);
  });
});

describe("Poisson match model", () => {
  it("1X2 probabilities sum to 1 and over/under are complementary", () => {
    const m = matchModel(1.6, 1.1);
    const { home, draw, away } = m.probabilities;
    close(home + draw + away, 1, 1e-4, "1X2 sum");
    close(m.probabilities.over["2.5"] + m.probabilities.under["2.5"], 1, 1e-4, "O/U 2.5");
    close(m.probabilities.btts_yes + m.probabilities.btts_no, 1, 1e-4, "BTTS");
  });

  it("is symmetric when both sides have the same expectation", () => {
    const m = matchModel(1.3, 1.3);
    close(m.probabilities.home, m.probabilities.away, 1e-6, "symmetric xG");
  });

  it("more expected goals means more overs", () => {
    assert.ok(matchModel(2.0, 1.8).probabilities.over["2.5"] > matchModel(0.9, 0.8).probabilities.over["2.5"]);
  });

  it("the Dixon-Coles correction lifts the low scores it is meant to lift", () => {
    const plain = matchModel(1.2, 1.1, { rho: 0 });
    const dc = matchModel(1.2, 1.1, { rho: -0.13 });
    const scoreOf = (m, s) => m.top_scorelines.find((x) => x.score === s)?.probability ?? 0;
    assert.ok(scoreOf(dc, "0-0") > scoreOf(plain, "0-0"), "0-0 gets more likely");
    close(dc.probabilities.home + dc.probabilities.draw + dc.probabilities.away, 1, 1e-4, "still normalized");
  });

  it("rejects impossible expectations", () => {
    assert.throws(() => matchModel(0, 1.1), /Expected goals must be positive/);
  });
});

describe("team ratings", () => {
  const league = [];
  // Strong scores 3, concedes 0. Weak is the mirror. Even teams draw 1-1.
  const teams = ["Strong", "Weak", "EvenA", "EvenB"];
  let day = 0;
  const add = (home, away, hg, ag) =>
    league.push({ home, away, homeGoals: hg, awayGoals: ag, ts: Date.UTC(2024, 0, ++day) });
  for (let i = 0; i < 6; i++) {
    add("Strong", "Weak", 3, 0);
    add("Weak", "Strong", 0, 3);
    add("EvenA", "EvenB", 1, 1);
    add("EvenB", "EvenA", 1, 1);
  }

  it("rates a dominant team above an average one", () => {
    const fit = fitRatings(league);
    const strong = fit.teams.get("Strong");
    const weak = fit.teams.get("Weak");
    assert.ok(strong.attack > 1, "scores more than the league average");
    assert.ok(strong.defence < 1, "concedes less than the league average");
    assert.ok(weak.attack < strong.attack && weak.defence > strong.defence);
    assert.equal(fit.matches_used, league.length);
  });

  it("shrinks a small sample toward the league average", () => {
    const long = fitRatings(league).teams.get("Strong").attack;
    const short = fitRatings(league.slice(0, 4)).teams.get("Strong").attack;
    assert.ok(short < long, "four matches should not produce a full-strength rating");
  });

  it("turns ratings into expected goals for a fixture", () => {
    const fit = fitRatings(league);
    const xg = expectedGoals(fit, "Strong", "Weak");
    assert.ok(xg.home > xg.away, "the strong side is expected to score more");
    assert.equal(expectedGoals(fit, "Strong", "Unknown FC"), null);
  });

  it("recency weighting favours recent results", () => {
    const recent = [...league, { home: "Weak", away: "Strong", homeGoals: 5, awayGoals: 0, ts: Date.UTC(2024, 5, 1) }];
    const flat = fitRatings(recent).teams.get("Weak").attack;
    const decayed = fitRatings(recent, { half_life_days: 10 }).teams.get("Weak").attack;
    assert.ok(decayed > flat, "the recent thrashing should count for more");
  });

  it("handles an empty sample without throwing", () => {
    const fit = fitRatings([]);
    assert.equal(fit.matches_used, 0);
    assert.equal(fit.teams.size, 0);
  });
});

describe("football-data.co.uk parsing", () => {
  it("parses quoted fields and skips empty values", () => {
    const rows = parseCsv('Div,HomeTeam,Note\r\nE0,"Man, City","says ""hi"""\r\nE0,Arsenal,\r\n');
    assert.equal(rows.length, 2);
    assert.equal(rows[0].HomeTeam, "Man, City");
    assert.equal(rows[0].Note, 'says "hi"');
    assert.equal(rows[1].Note, undefined, "empty cells are omitted, not stored as ''");
  });

  it("reads both two- and four-digit years", () => {
    assert.equal(parseFdDate("17/08/24"), Date.UTC(2024, 7, 17));
    assert.equal(parseFdDate("17/08/2024"), Date.UTC(2024, 7, 17));
    assert.equal(parseFdDate("not a date"), undefined);
  });

  it("falls back to the Betbrain columns used before 2019", () => {
    const row = { BbAvH: "2.50", BbMxH: "2.70" };
    assert.deepEqual(priceFor(row, "open", "avg", "H"), { odds: 2.5, book: "avg" });
    // No Avg/Max/B365 column for the draw at all.
    assert.equal(priceFor(row, "open", "avg", "D"), undefined);
    // Closing columns simply do not exist in those seasons.
    assert.equal(priceFor(row, "close", "avg", "H"), undefined);
  });

  it("normalizes rows into sorted matches and drops incomplete ones", () => {
    const rows = [
      { Date: "20/08/24", HomeTeam: "B", AwayTeam: "C", FTHG: "2", FTAG: "2", FTR: "D", AvgH: "2.4", AvgD: "3.3", AvgA: "3.0" },
      { Date: "17/08/24", HomeTeam: "A", AwayTeam: "B", FTHG: "1", FTAG: "0", FTR: "H", AvgH: "2.0", AvgD: "3.4", AvgA: "4.0" },
      { Date: "24/08/24", HomeTeam: "C", AwayTeam: "A" }, // fixture not played yet
    ];
    const matches = toMatches(rows, "E0", "2425");
    assert.equal(matches.length, 2, "unplayed fixtures are dropped");
    assert.deepEqual(matches.map((m) => m.home), ["A", "B"], "sorted by date");
    assert.equal(matches[0].totalGoals, 1);
    assert.equal(matches[0].prices.open.H.odds, 2.0);
  });
});

describe("trading provider", () => {
  const tools = new Map();
  before(() => {
    trading.register({ tool: (name, description, schema, handler) => tools.set(name, handler) });
  });

  it("registers the toolkit", () => {
    for (const name of [
      "trading_list_strategies", "trading_devig_odds", "trading_evaluate_bet", "trading_find_arbitrage",
      "trading_hedge_position", "trading_poisson_model", "trading_team_ratings", "trading_backtest",
      "trading_closing_line_value",
    ]) {
      assert.ok(tools.has(name), `${name} should be registered`);
    }
  });

  const call = async (name, args) => {
    const result = await tools.get(name)(args);
    return { isError: result.isError === true, data: JSON.parse(result.content[0].text.replace(/^Error: /, "")) };
  };

  it("de-vigs a market through the tool surface", async () => {
    const { data } = await call("trading_devig_odds", { odds: [2.1, 3.4, 3.6], names: ["Home", "Draw", "Away"], method: "shin" });
    assert.equal(data.outcomes.length, 3);
    close(data.outcomes.reduce((a, o) => a + o.fair_probability, 0), 1, 1e-4);
    assert.equal(data.outcomes[0].name, "Home");
  });

  it("warns when probabilities for one market do not sum to 1", async () => {
    const { data } = await call("trading_evaluate_bet", {
      selections: [{ name: "a", odds: 2.0, probability: 0.6 }, { name: "b", odds: 3.0, probability: 0.6 }],
    });
    assert.ok(data.warning, "a book summing to 1.2 deserves a warning");
  });

  it("refuses Kelly staking for a strategy with no model probability", async () => {
    const result = await tools.get("trading_backtest")({ strategy: "home", staking: "kelly" });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Kelly staking needs a model probability/);
  });

  it("refuses a request that would pull too many files", async () => {
    const result = await tools.get("trading_backtest")({
      strategy: "home", leagues: "E0,E1,E2,E3,SC0", seasons: "2021,2122,2223,2324,2425",
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /over the 20-file cap/);
  });
});

describe("backtest engine (stubbed CSV)", () => {
  const tools = new Map();
  let realFetch;

  // Four matches: home wins two of them. At 2.5 with a 1-unit flat stake that
  // is +1.5 twice and -1 twice = +1 on 4 staked = 25% ROI.
  const CSV = [
    "Date,HomeTeam,AwayTeam,FTHG,FTAG,FTR,AvgH,AvgD,AvgA,Avg>2.5,Avg<2.5,AvgCH,AvgCD,AvgCA",
    "17/08/24,Arsenal,Chelsea,2,0,H,2.50,3.40,3.00,1.90,1.90,2.40,3.40,3.10",
    "18/08/24,Chelsea,Arsenal,0,1,A,2.50,3.40,3.00,1.90,1.90,2.60,3.40,2.90",
    "24/08/24,Arsenal,Everton,3,1,H,2.50,3.40,3.00,1.90,1.90,2.50,3.40,3.00",
    "25/08/24,Everton,Chelsea,0,2,A,2.50,3.40,3.00,1.90,1.90,2.50,3.40,3.00",
    "",
  ].join("\n");

  before(() => {
    trading.register({ tool: (name, description, schema, handler) => tools.set(name, handler) });
    realFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      if (!String(url).includes("football-data.co.uk")) throw new Error(`unexpected fetch: ${url}`);
      return { ok: true, status: 200, statusText: "OK", headers: new Headers(), text: async () => CSV };
    };
  });
  after(() => { globalThis.fetch = realFetch; });

  it("settles flat bets and reports ROI, drawdown and CLV", async () => {
    const result = await tools.get("trading_backtest")({
      strategy: "home", leagues: "E0", seasons: "9901", phase: "open", staking: "flat", unit: 1, bankroll: 100,
    });
    assert.notEqual(result.isError, true, result.content[0].text);
    const data = JSON.parse(result.content[0].text);
    assert.equal(data.coverage.matches_scanned, 4);
    assert.equal(data.results.bets, 4);
    assert.equal(data.results.wins, 2);
    close(data.results.profit, 1, 1e-6, "profit");
    close(data.results.roi_pct, 25, 1e-6, "ROI");
    close(data.results.bankroll_end, 101, 1e-6, "bankroll");
    assert.ok(data.results.max_drawdown_pct >= 0);
    assert.ok(data.results.closing_line_value.bets_measured === 4, "open prices are compared to the close");
    assert.ok(Array.isArray(data.caveats) && data.caveats.length > 0, "results ship with their caveats");
  });

  it("applies the odds filters", async () => {
    const result = await tools.get("trading_backtest")({
      strategy: "home", leagues: "E0", seasons: "9902", min_odds: 3.0,
    });
    const data = JSON.parse(result.content[0].text);
    assert.equal(data.results, null, "no bet clears a 3.0 floor at 2.50");
    assert.equal(data.coverage.bets_placed, 0);
  });

  it("commission comes out of the winners only", async () => {
    const result = await tools.get("trading_backtest")({
      strategy: "home", leagues: "E0", seasons: "9903", phase: "open", commission_pct: 10,
    });
    const data = JSON.parse(result.content[0].text);
    // Two winners at +1.5 less 10% = +1.35 each; two losers at -1.
    close(data.results.profit, 0.7, 1e-6, "profit after commission");
  });

  it("stops and says so when the bankroll goes bust", async () => {
    // The draw loses all four times; a 2-unit bankroll cannot survive that.
    const result = await tools.get("trading_backtest")({
      strategy: "draw", leagues: "E0", seasons: "9905", phase: "open", unit: 1, bankroll: 2,
    });
    const data = JSON.parse(result.content[0].text);
    assert.equal(data.results.bets, 2, "only the bets the bankroll could cover");
    assert.equal(data.results.went_bust, true);
    assert.equal(data.results.bets_skipped_after_bust, 2);
    assert.ok(data.results.bust_note.includes("bankroll hit zero"));
  });

  it("picks the favourite when asked to", async () => {
    const result = await tools.get("trading_backtest")({
      strategy: "favourite", leagues: "E0", seasons: "9904", phase: "open",
    });
    const data = JSON.parse(result.content[0].text);
    assert.equal(data.results.bets, 4);
    assert.ok(data.sample_bets.every((b) => b.selection === "Home"), "2.50 is the shortest price in this fixture list");
  });
});

describe("real archive column shapes", () => {
  // Header subsets taken from the archive itself: modern files (2019/20+)
  // carry Max/Avg plus separate closing columns; older files carry Betbrain
  // aggregates and no closing prices at all.
  const MODERN = [
    "Div,Date,Time,HomeTeam,AwayTeam,FTHG,FTAG,FTR,HTHG,HTAG,HTR,B365H,B365D,B365A,PSH,PSD,PSA,MaxH,MaxD,MaxA,AvgH,AvgD,AvgA,B365>2.5,B365<2.5,Max>2.5,Max<2.5,Avg>2.5,Avg<2.5,B365CH,B365CD,B365CA,PSCH,PSCD,PSCA,MaxCH,MaxCD,MaxCA,AvgCH,AvgCD,AvgCA,AvgC>2.5,AvgC<2.5",
    "I1,17/08/2024,18:30,Inter,Genoa,2,2,D,1,0,H,1.25,6.50,11.0,1.26,6.80,12.5,1.28,7.00,13.0,1.25,6.40,11.5,1.55,2.45,1.60,2.55,1.57,2.40,1.22,7.00,13.0,1.23,7.20,14.0,1.24,7.50,15.0,1.22,6.90,13.5,1.52,2.50",
    "",
  ].join("\n");
  const LEGACY = [
    "Div,Date,HomeTeam,AwayTeam,FTHG,FTAG,FTR,HTHG,HTAG,HTR,B365H,B365D,B365A,PSH,PSD,PSA,Bb1X2,BbMxH,BbAvH,BbMxD,BbAvD,BbMxA,BbAvA,BbOU,BbMx>2.5,BbAv>2.5,BbMx<2.5,BbAv<2.5",
    "I1,20/09/2014,Juventus,Udinese,2,0,H,1,0,H,1.36,4.75,9.50,1.38,5.00,10.5,39,1.40,1.35,5.20,4.80,11.0,9.30,35,1.80,1.72,2.20,2.10",
    "",
  ].join("\n");

  it("reads Max/Avg/B365/Pinnacle and the separate closing columns", () => {
    const [row] = parseCsv(MODERN);
    assert.deepEqual(priceFor(row, "open", "avg", "H"), { odds: 1.25, book: "avg" });
    assert.deepEqual(priceFor(row, "close", "avg", "H"), { odds: 1.22, book: "avg" });
    assert.deepEqual(priceFor(row, "close", "max", "D"), { odds: 7.5, book: "max" });
    assert.deepEqual(priceFor(row, "open", "pinnacle", "A"), { odds: 12.5, book: "pinnacle" });
    assert.deepEqual(priceFor(row, "open", "b365", "O25"), { odds: 1.55, book: "b365" });
    assert.deepEqual(priceFor(row, "close", "avg", "U25"), { odds: 2.5, book: "avg" });
    // Pinnacle has no closing over/under column here — fall back to another book.
    assert.equal(priceFor(row, "close", "pinnacle", "O25").book, "avg");
    const [match] = toMatches(parseCsv(MODERN), "I1", "2425", "avg");
    assert.equal(match.date, "2024-08-17");
    assert.equal(match.totalGoals, 4);
    assert.equal(match.prices.close.H.odds, 1.22);
  });

  it("reads the pre-2019 Betbrain aggregates and reports no closing prices", () => {
    const [row] = parseCsv(LEGACY);
    assert.deepEqual(priceFor(row, "open", "avg", "H"), { odds: 1.35, book: "avg" });
    assert.deepEqual(priceFor(row, "open", "max", "A"), { odds: 11.0, book: "max" });
    assert.deepEqual(priceFor(row, "open", "avg", "O25"), { odds: 1.72, book: "avg" });
    assert.equal(priceFor(row, "close", "avg", "H"), undefined, "no closing columns before 2019/20");
    const [match] = toMatches(parseCsv(LEGACY), "I1", "1415", "avg");
    assert.equal(match.date, "2014-09-20");
    assert.deepEqual(match.prices.close, {}, "the match carries no closing prices");
  });
});

describe("walk-forward value model (stubbed CSV)", () => {
  const tools = new Map();
  let realFetch;

  // A four-team round robin, twice over, with one dominant side. Prices are
  // flat at 2.5/3.4/3.0 so the model — not the market — decides every bet.
  const teams = ["Strong", "MidA", "MidB", "Weak"];
  const goalsFor = { Strong: 3, MidA: 1, MidB: 1, Weak: 0 };
  const rows = ["Date,HomeTeam,AwayTeam,FTHG,FTAG,FTR,AvgH,AvgD,AvgA,Avg>2.5,Avg<2.5"];
  let day = 1;
  for (let leg = 0; leg < 4; leg++) {
    for (const home of teams) {
      for (const away of teams) {
        if (home === away) continue;
        const hg = goalsFor[home], ag = goalsFor[away];
        const ftr = hg > ag ? "H" : hg === ag ? "D" : "A";
        const date = new Date(Date.UTC(2024, 7, 1) + day++ * 86400000).toISOString().slice(0, 10);
        const [y, m, d] = date.split("-");
        rows.push(`${d}/${m}/${y},${home},${away},${hg},${ag},${ftr},2.50,3.40,3.00,1.90,1.90`);
      }
    }
  }
  const CSV = rows.join("\n") + "\n";

  before(() => {
    trading.register({ tool: (name, description, schema, handler) => tools.set(name, handler) });
    realFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: true, status: 200, statusText: "OK", headers: new Headers(), text: async () => CSV });
  });
  after(() => { globalThis.fetch = realFetch; });

  const run = async (args) => {
    const result = await tools.get("trading_backtest")(args);
    assert.notEqual(result.isError, true, result.content[0].text);
    return JSON.parse(result.content[0].text);
  };

  it("bets only once both sides have enough history — no lookahead", async () => {
    const data = await run({ strategy: "value_model", leagues: "E0", seasons: "9910", edge_pct: 5, min_history: 6, sample_bets: 50 });
    assert.ok(data.results.bets > 0, "the model should find edges against a flat price");
    const firstBet = data.sample_bets[0].date;
    const cutoff = new Date(Date.UTC(2024, 7, 1) + 12 * 86400000).toISOString().slice(0, 10);
    assert.ok(firstBet >= cutoff, `first bet ${firstBet} must come after both teams have 6 matches`);
    assert.ok(data.results.average_model_edge_pct >= 5, "every bet cleared the threshold");
  });

  it("a higher edge threshold fires less often", async () => {
    const loose = await run({ strategy: "value_model", leagues: "E0", seasons: "9911", edge_pct: 5, min_history: 6, sample_bets: 0 });
    // This synthetic league is deterministic, so the model's edges are huge —
    // the threshold has to be well past anything a real market would show.
    const strict = await run({ strategy: "value_model", leagues: "E0", seasons: "9912", edge_pct: 100, min_history: 6, sample_bets: 0 });
    assert.ok(strict.coverage.bets_placed < loose.coverage.bets_placed);
  });

  it("settles over/under bets on total goals", async () => {
    const data = await run({ strategy: "over25", leagues: "E0", seasons: "9913", sample_bets: 50 });
    for (const bet of data.sample_bets) {
      const [h, a] = bet.score.split("-").map(Number);
      assert.equal(bet.result, h + a > 2.5 ? "won" : "lost", `${bet.match} ${bet.score}`);
    }
  });

  it("kelly staking compounds off the running bankroll", async () => {
    const data = await run({
      strategy: "value_model", leagues: "E0", seasons: "9914", edge_pct: 5, min_history: 6,
      staking: "kelly", kelly_fraction: 0.25, bankroll: 1000, sample_bets: 50,
    });
    assert.ok(data.results.bets > 0);
    const stakes = new Set(data.sample_bets.map((b) => b.stake));
    assert.ok(stakes.size > 1, "stakes should vary with bankroll and edge");
    close(data.sample_bets[0].stake, 50, 0.01, "first stake is the 5% cap on the opening bankroll");
    // The cap is 5% of the RUNNING bankroll, so absolute stakes grow as it does.
    const peak = Math.max(...data.equity_curve.map((p) => p.bankroll), 1000);
    data.sample_bets.forEach((b) => assert.ok(b.stake <= peak * 0.05 + 0.01, "capped by max_stake_pct"));
    assert.ok(data.results.bankroll_end > 1000, "a winning model compounds");
  });
});

describe("predicting and scoring (stubbed CSVs)", () => {
  const tools = new Map();
  let realFetch;

  const iso = (offsetDays) => new Date(Date.now() + offsetDays * 86400000).toISOString().slice(0, 10);
  const fdDate = (offsetDays) => { const [y, m, d] = iso(offsetDays).split("-"); return `${d}/${m}/${y}`; };

  // History: Strong beats everyone, Weak loses to everyone, the Mids draw.
  const teams = ["Strong", "MidA", "MidB", "Weak"];
  const goalsFor = { Strong: 3, MidA: 1, MidB: 1, Weak: 0 };
  const historyRows = ["Div,Date,HomeTeam,AwayTeam,FTHG,FTAG,FTR,AvgH,AvgD,AvgA,Avg>2.5,Avg<2.5,AvgCH,AvgCD,AvgCA"];
  let back = 200;
  for (let leg = 0; leg < 3; leg++) {
    for (const home of teams) for (const away of teams) {
      if (home === away) continue;
      const hg = goalsFor[home], ag = goalsFor[away];
      historyRows.push(`E0,${fdDate(-back--)},${home},${away},${hg},${ag},${hg > ag ? "H" : hg === ag ? "D" : "A"},2.50,3.40,3.00,1.90,1.90,2.50,3.40,3.00`);
    }
  }
  // Two of those fixtures are also the ones we will "predict" and then score.
  historyRows.push(`E0,${fdDate(-3)},Strong,Weak,3,0,H,1.30,5.00,9.00,1.60,2.30,1.28,5.20,9.50`);
  historyRows.push(`E0,${fdDate(-2)},MidA,MidB,1,1,D,2.60,3.30,2.80,1.95,1.85,2.55,3.30,2.90`);
  const HISTORY = historyRows.join("\n") + "\n";

  // Upcoming: flat prices, so the model's view is what drives every pick.
  const FIXTURES = [
    "Div,Date,Time,HomeTeam,AwayTeam,AvgH,AvgD,AvgA,Avg>2.5,Avg<2.5",
    `E0,${fdDate(2)},15:00,Strong,Weak,2.50,3.40,3.00,1.90,1.90`,
    `E0,${fdDate(3)},17:30,MidA,MidB,2.50,3.40,3.00,1.90,1.90`,
    `I1,${fdDate(2)},20:45,Roma,Lazio,2.20,3.30,3.40,1.85,1.95`,
    `E0,${fdDate(25)},15:00,Strong,MidA,2.50,3.40,3.00,1.90,1.90`,
    `E0,${fdDate(4)},15:00,Strong,Newcomer FC,1.40,4.50,7.00,1.80,2.00`,
    "",
  ].join("\n");

  before(() => {
    trading.register({ tool: (name, description, schema, handler) => tools.set(name, handler) });
    realFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      const body = String(url).includes("/fixtures.csv") ? FIXTURES : HISTORY;
      return { ok: true, status: 200, statusText: "OK", headers: new Headers(), text: async () => body };
    };
  });
  after(() => { globalThis.fetch = realFetch; });

  const call = async (name, args) => {
    const result = await tools.get(name)(args);
    assert.notEqual(result.isError, true, result.content[0].text);
    return JSON.parse(result.content[0].text);
  };

  it("prices the upcoming fixtures and keeps the far-off ones out", async () => {
    const data = await call("trading_predict_fixtures", { leagues: "E0", season: "2627", days_ahead: 10, suggest_picks: true });
    assert.equal(data.predictions.length, 3, "the fixture 25 days out is outside the horizon");
    const strong = data.predictions.find((p) => p.home === "Strong");
    assert.equal(strong.most_likely, "home");
    assert.ok(strong.prob_home > strong.prob_away, "the dominant side should be favoured");
    close(strong.prob_home + strong.prob_draw + strong.prob_away, 1, 1e-4, "1X2 sum");
    assert.ok(strong.expected_goals.home > strong.expected_goals.away);
    assert.ok(strong.market_prob_home > 0 && strong.market_prob_home < 1, "market prices are de-vigged for comparison");
    assert.ok(strong.pick, "a flat 2.50 on a dominant home side is an edge the model should take");
    assert.ok(strong.pick.stake > 0);
  });

  it("declines a fixture where neither side has history", async () => {
    const data = await call("trading_predict_fixtures", { leagues: "I1", season: "2627", days_ahead: 10, suggest_picks: true });
    assert.equal(data.predictions.length, 0, "the promoted-team prior cannot stand in for both sides at once");
    assert.equal(data.unrated.length, 1, "Roma and Lazio have no history in the stubbed archive");
    assert.match(data.unrated[0].reason, /prior playing itself/);
  });

  it("suggests no bets unless asked, and warns when asked", async () => {
    const quiet = await call("trading_predict_fixtures", { leagues: "E0", season: "2627", days_ahead: 10 });
    assert.ok(quiet.predictions.length > 0);
    assert.ok(quiet.predictions.every((p) => p.pick === undefined), "no pick unless suggest_picks is on");
    assert.equal(quiet.picks_suggested, 0);
    assert.equal(quiet.picks_warning, undefined);

    const loud = await call("trading_predict_fixtures", { leagues: "E0", season: "2627", days_ahead: 10, suggest_picks: true });
    assert.ok(loud.predictions.some((p) => p.pick), "picks come back when asked for");
    assert.match(loud.picks_warning, /lost 13.6% of turnover|not tips/,
      "and they carry what betting this model actually did");
  });

  it("prices a fixture with one unknown side, and says which side it assumed", async () => {
    const data = await call("trading_predict_fixtures", { leagues: "E0", season: "2627", days_ahead: 10, limit: 40 });
    const promoted = data.predictions.find((p) => p.away === "Newcomer FC");
    assert.ok(promoted, "a fixture with one unrated side should still be priced");
    assert.deepEqual(promoted.assumed_prior_for, ["Newcomer FC"]);
    assert.deepEqual(promoted.assumed_prior, { attack: 0.85, defence: 1.15 });
    assert.equal(promoted.most_likely, "home", "an unknown side away to a dominant home team");
    assert.ok(data.promoted_prior_note, "and the summary says an assumption was used");
  });

  it("reports the unknown side instead of assuming, when asked to", async () => {
    const data = await call("trading_predict_fixtures", { leagues: "E0", season: "2627", days_ahead: 10, limit: 40, rate_promoted: false });
    assert.ok(!data.predictions.some((p) => p.away === "Newcomer FC"));
    const row = data.unrated.find((u) => u.match.includes("Newcomer FC"));
    assert.ok(row, "it comes back as unrated");
    assert.match(row.reason, /rate_promoted is off/);
  });

  it("says so plainly when nothing is in the window", async () => {
    const data = await call("trading_predict_fixtures", { leagues: "E0", season: "2627", days_ahead: 1 });
    assert.equal(data.predictions.length, 0);
    assert.match(data.note, /none inside the next 1 days/);
  });

  it("scores predictions with RPS, Brier and log loss on known numbers", async () => {
    const data = await call("trading_score_predictions", {
      predictions: [{
        date: iso(-3), league: "E0", home: "Strong", away: "Weak",
        prob_home: 0.6, prob_draw: 0.25, prob_away: 0.15,
      }],
      season: "2627", sample: 5,
    });
    assert.equal(data.scored, 1);
    assert.equal(data.accuracy.hits, 1, "home was both predicted and the result");
    // cumulative: (0.6-1)^2 + (0.85-1)^2 = 0.1825, halved over the 2 boundaries.
    close(data.probability_scores.rps, 0.09125, 1e-4, "RPS");
    close(data.probability_scores.brier, 0.245, 1e-4, "Brier");
    close(data.probability_scores.log_loss, 0.5108, 1e-3, "log loss");
    assert.equal(data.sample_matches[0].score, "3-0");
  });

  it("benchmarks the model against the market and settles picks", async () => {
    const data = await call("trading_score_predictions", {
      predictions: [
        {
          date: iso(-3), league: "E0", home: "Strong", away: "Weak",
          prob_home: 0.8, prob_draw: 0.13, prob_away: 0.07,
          market_odds: { home: 1.30, draw: 5.00, away: 9.00 },
          pick: { outcome: "home", odds: 1.30, stake: 10 },
        },
        {
          date: iso(-2), league: "E0", home: "MidA", away: "MidB",
          prob_home: 0.2, prob_draw: 0.3, prob_away: 0.5,
          market_odds: { home: 2.60, draw: 3.30, away: 2.80 },
          pick: { outcome: "away", odds: 2.80, stake: 10 },
        },
      ],
      season: "2627",
    });
    assert.equal(data.scored, 2);
    assert.equal(data.accuracy.hits, 1, "the Strong win was called, the draw was not");
    assert.ok(data.benchmarks.market.rps > 0, "the market gets scored on the same matches");
    assert.equal(typeof data.benchmarks.skill_vs_market_pct, "number");
    assert.equal(data.picks.bets, 2);
    assert.equal(data.picks.wins, 1);
    // +10 * 0.30 on the winner, -10 on the loser.
    close(data.picks.profit, -7, 0.01, "picks P&L");
    assert.ok(data.picks.average_clv_pct !== undefined, "CLV comes from the archive's closing prices");
    assert.ok(data.calibration.length > 0);
    assert.ok(data.verdict.length > 0);
  });

  it("reports unplayed and unmatched predictions as pending rather than scoring them", async () => {
    const data = await call("trading_score_predictions", {
      predictions: [
        { date: iso(-3), league: "E0", home: "Strong", away: "Weak", prob_home: 0.6, prob_draw: 0.25, prob_away: 0.15 },
        { date: iso(2), league: "E0", home: "Nobody FC", away: "Ghost United", prob_home: 0.4, prob_draw: 0.3, prob_away: 0.3 },
      ],
      season: "2627",
    });
    assert.equal(data.scored, 1);
    assert.equal(data.pending_count, 1);
    assert.match(data.pending[0].status, /not in the source at all/,
      "an unknown fixture is named as such, not lumped in with matches still to come");
  });

  it("the round trip works: predictions feed straight into scoring", async () => {
    const predicted = await call("trading_predict_fixtures", { leagues: "E0", season: "2627", days_ahead: 10 });
    // Re-date them onto matches the archive has results for, leaving every
    // other field exactly as the predict tool emitted it.
    const rows = predicted.predictions.map((p, i) => ({ ...p, date: iso(i === 0 ? -3 : -2) }));
    rows[0].home = "Strong"; rows[0].away = "Weak";
    rows[1].home = "MidA"; rows[1].away = "MidB";
    const scored = await call("trading_score_predictions", { predictions: rows, season: "2627" });
    assert.equal(scored.scored, 2, "the shape predict emits is the shape score accepts");
    assert.ok(scored.probability_scores.rps >= 0);
  });
});

describe("openfootball source", () => {
  let realFetch;
  const SEASON = {
    name: "Italian Serie A 2026/27",
    matches: [
      { round: "Matchday 1", date: "2026-08-22", time: "18:30", team1: "Udinese Calcio", team2: "Como 1907", score: { ht: [1, 0], ft: [1, 1] } },
      { round: "Matchday 1", date: "2026-08-22", time: "20:45", team1: "Genoa CFC", team2: "SSC Napoli", score: { ht: [0, 0], ft: [0, 2] } },
      { round: "Matchday 2", date: "2027-05-30", time: "15:00", team1: "AC Milan", team2: "US Lecce" },
      { date: "2027-05-30", team1: "Broken" },
    ],
  };

  before(() => {
    realFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      if (!String(url).includes("raw.githubusercontent.com/openfootball")) throw new Error(`unexpected fetch: ${url}`);
      return { ok: true, status: 200, statusText: "OK", headers: new Headers(), json: async () => SEASON, text: async () => JSON.stringify(SEASON) };
    };
  });
  after(() => { globalThis.fetch = realFetch; });

  it("maps season codes to the directory names the mirror uses", () => {
    assert.equal(seasonPath("2627"), "2026-27");
    assert.equal(seasonPath("0001"), "2000-01");
    assert.equal(seasonPath("9900"), "1999-00");
  });

  it("splits a season into played matches and remaining fixtures", async () => {
    const { played, fixtures, url } = await fetchOpenFootballSeason("I1", "2627");
    assert.match(url, /2026-27\/it\.1\.json$/);
    assert.equal(played.length, 2);
    assert.equal(fixtures.length, 1, "rows without a usable team pair are dropped");
    assert.equal(played[0].result, "D");
    assert.equal(played[1].result, "A");
    assert.equal(played[0].totalGoals, 2);
    assert.deepEqual(played[0].prices, { open: {}, close: {} }, "this source has no odds");
    assert.equal(fixtures[0].home, "AC Milan");
    assert.equal(fixtures[0].time, "15:00");
  });

  it("refuses a league it has no mapping for", async () => {
    await assert.rejects(() => fetchOpenFootballSeason("XX", "2627"), /no mapping for league/);
  });
});

describe("source fallback", () => {
  let realFetch;
  const OF = { matches: [{ date: "2026-08-22", team1: "A", team2: "B", score: { ft: [2, 0] } }] };
  const CSV = "Date,HomeTeam,AwayTeam,FTHG,FTAG,FTR,AvgH,AvgD,AvgA\n22/08/26,A,B,2,0,H,1.90,3.50,4.00\n";
  let archiveUp = true;
  const seen = [];

  before(() => {
    realFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      const u = String(url);
      seen.push(u);
      if (u.includes("football-data.co.uk")) {
        if (!archiveUp) throw new Error("HTTP 403 Forbidden: Host not in allowlist: www.football-data.co.uk");
        return { ok: true, status: 200, statusText: "OK", headers: new Headers(), text: async () => CSV };
      }
      return { ok: true, status: 200, statusText: "OK", headers: new Headers(), json: async () => OF, text: async () => JSON.stringify(OF) };
    };
  });
  after(() => { globalThis.fetch = realFetch; });

  it("prefers the odds archive when it answers", async () => {
    archiveUp = true;
    const data = await loadSeasonData("I1", "9201", "auto");
    assert.equal(data.used, "footballdata");
    assert.equal(data.played[0].prices.open.H.odds, 1.90, "odds come through");
    assert.equal(data.note, undefined);
  });

  it("falls back to the keyless mirror when the archive is unreachable, and says so", async () => {
    archiveUp = false;
    const data = await loadSeasonData("I1", "9202", "auto");
    assert.equal(data.used, "openfootball");
    assert.equal(data.played.length, 1);
    assert.match(data.note, /unreachable/);
    assert.match(data.note, /no odds/, "the caller is told what it lost");
  });

  it("propagates the failure when the archive is demanded explicitly", async () => {
    archiveUp = false;
    await assert.rejects(() => loadSeasonData("I1", "9203", "footballdata"), /403/);
  });

  it("never touches the archive when the mirror is demanded explicitly", async () => {
    archiveUp = true;
    seen.length = 0;
    const data = await loadSeasonData("I1", "9204", "openfootball");
    assert.equal(data.used, "openfootball");
    assert.ok(!seen.some((u) => u.includes("football-data.co.uk")), "no request to the archive");
  });
});

describe("predicting without odds", () => {
  const tools = new Map();
  let realFetch;
  const day = (o) => new Date(Date.now() + o * 86400000).toISOString().slice(0, 10);
  const SEASON = {
    matches: [
      // enough history for both sides, all in the past
      ...Array.from({ length: 12 }, (_, i) => ({
        date: day(-40 + i), team1: i % 2 ? "Alpha" : "Beta", team2: i % 2 ? "Beta" : "Alpha",
        score: { ft: i % 2 ? [3, 0] : [0, 3] },
      })),
      // one fixture already played but not yet recorded, one genuinely ahead
      { date: day(-2), time: "20:45", team1: "Alpha", team2: "Beta" },
      { date: day(3), time: "20:45", team1: "Alpha", team2: "Beta" },
    ],
  };

  before(() => {
    trading.register({ tool: (name, description, schema, handler) => tools.set(name, handler) });
    realFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      if (String(url).includes("football-data.co.uk")) throw new Error("HTTP 403 Forbidden: Host not in allowlist");
      return { ok: true, status: 200, statusText: "OK", headers: new Headers(), json: async () => SEASON, text: async () => JSON.stringify(SEASON) };
    };
  });
  after(() => { globalThis.fetch = realFetch; });

  it("predicts from the mirror, flags the missing market, and suggests nothing", async () => {
    const result = await tools.get("trading_predict_fixtures")({ leagues: "I1", season: "9301", days_ahead: 10, source: "auto" });
    assert.notEqual(result.isError, true, result.content[0].text);
    const data = JSON.parse(result.content[0].text);
    assert.deepEqual(data.source, ["openfootball"]);
    assert.equal(data.market_data, false);
    assert.match(data.no_market_note, /no market comparison|carries no odds/);
    assert.equal(data.picks_suggested, 0, "no odds means no bet can be evaluated");
    assert.equal(data.predictions.length, 1, "only the fixture still ahead of us");
    assert.equal(data.predictions[0].date, day(3));
    assert.ok(data.predictions[0].prob_home > 0.5, "Alpha has won every meeting 3-0");
  });

  it("refuses to predict a match that has already kicked off", async () => {
    const result = await tools.get("trading_predict_fixtures")({ leagues: "I1", season: "9302", days_ahead: 10, source: "openfootball" });
    const data = JSON.parse(result.content[0].text);
    assert.equal(data.already_played_skipped, 1);
    assert.match(data.already_played_note, /worthless|skipped/);
    assert.ok(!data.predictions.some((p) => p.date === day(-2)));
  });
});

describe("robustness against malformed input", () => {
  const tools = new Map();
  before(() => { trading.register({ tool: (name, description, schema, handler) => tools.set(name, handler) }); });

  const callRaw = async (name, args) => {
    const result = await tools.get(name)(args);
    return { isError: result.isError === true, text: result.content[0].text };
  };

  it("turns a bad price into an error, not a NaN", async () => {
    for (const odds of [[1, 3, 4], [0, 3, 4], [-2, 3, 4], [Number.NaN, 3, 4], [Infinity, 3, 4]]) {
      const r = await callRaw("trading_devig_odds", { odds });
      assert.equal(r.isError, true, `odds ${JSON.stringify(odds)} should be rejected`);
      assert.match(r.text, /Invalid decimal odds|At least 2 outcomes/);
    }
  });

  it("never emits NaN or Infinity anywhere in a result", async () => {
    // JSON.stringify turns NaN and Infinity into null, so scanning the text
    // would miss them. The un-serialized payload is hung off the result under
    // a symbol for exactly this kind of inspection.
    const RAW = Symbol.for("sports-hub.rawPayload");
    const walk = (value, path, seen) => {
      if (typeof value === "number") {
        assert.ok(Number.isFinite(value), `non-finite number at ${path}: ${value}`);
      } else if (value && typeof value === "object") {
        assert.ok(!seen.has(value), `cycle at ${path}`);
        seen.add(value);
        for (const [key, inner] of Object.entries(value)) walk(inner, `${path}.${key}`, seen);
      }
    };
    const cases = [
      ["trading_devig_odds", { odds: [1.001, 500, 1000], method: "shin" }],
      ["trading_evaluate_bet", { selections: [{ name: "longshot", odds: 1000, probability: 0.000001 }] }],
      ["trading_poisson_model", { home_xg: 0.01, away_xg: 9 }],
      ["trading_hedge_position", { side: "back", stake: 0.01, odds: 1.01, hedge_odds: 1000, commission_pct: 99 }],
      ["trading_find_arbitrage", { outcomes: Array.from({ length: 20 }, (_, i) => ({ name: `o${i}`, odds: 1.01 + i })) }],
    ];
    for (const [name, args] of cases) {
      const result = await tools.get(name)(args);
      assert.notEqual(result.isError, true, result.content[0].text);
      walk(result[RAW], name, new Set());
      JSON.parse(result.content[0].text);
    }
  });

  it("survives a CSV that is only a header, or junk", () => {
    assert.deepEqual(parseCsv("Date,HomeTeam,AwayTeam\n"), []);
    assert.deepEqual(parseCsv(""), []);
    assert.deepEqual(parseCsv("\n\n\n"), []);
    assert.deepEqual(toMatches(parseCsv("Date,HomeTeam\n17/08/24,Arsenal\n"), "E0", "2425"), []);
  });

  it("keeps a played match out of the upcoming-fixtures list", () => {
    const rows = parseCsv([
      "Div,Date,HomeTeam,AwayTeam,FTR,AvgH,AvgD,AvgA",
      "E0,17/08/24,Arsenal,Chelsea,H,2.0,3.4,4.0",
      "E0,24/08/99,Arsenal,Everton,,2.0,3.4,4.0",
      "",
    ].join("\n"));
    const fixtures = toFixtures(rows, "avg", ["E0"]);
    assert.equal(fixtures.length, 1, "a row carrying a result is not a fixture");
    assert.equal(fixtures[0].away, "Everton");
  });

  it("scores a duplicated prediction once per copy, without crashing", async () => {
    const one = { date: "2024-08-17", league: "E0", home: "A", away: "B", prob_home: 0.5, prob_draw: 0.25, prob_away: 0.25 };
    const r = await callRaw("trading_score_predictions", { predictions: [one, { ...one }], season: "9401", source: "footballdata" });
    assert.equal(r.isError, false, r.text);
    const data = JSON.parse(r.text);
    assert.equal(data.scored + data.pending_count, 2);
  });

  it("names a league the mirror does not carry", async () => {
    const r = await callRaw("trading_predict_fixtures", { leagues: "ZZ", season: "2627", source: "openfootball" });
    const data = JSON.parse(r.text.replace(/^Error: /, ""));
    const text = JSON.stringify(data);
    assert.match(text, /no mapping for league|no data/i);
  });
});

const { mkdtemp, mkdir, writeFile } = await import("node:fs/promises");
const { tmpdir } = await import("node:os");
const { join: joinPath } = await import("node:path");

describe("local CSV drop-in", () => {
  let dir, realFetch, fetched;
  const CSV = [
    "Div,Date,HomeTeam,AwayTeam,FTHG,FTAG,FTR,AvgH,AvgD,AvgA,AvgCH,AvgCD,AvgCA",
    "I1,17/08/26,Inter,Genoa,3,0,H,1.40,4.80,8.00,1.35,5.00,9.00",
    "I1,18/08/26,Roma,Lazio,1,1,D,2.30,3.30,3.20,2.25,3.35,3.30",
    "",
  ].join("\n");

  before(async () => {
    dir = await mkdtemp(joinPath(tmpdir(), "sportshub-"));
    await mkdir(joinPath(dir, "2627"), { recursive: true });
    await writeFile(joinPath(dir, "2627", "I1.csv"), CSV);
    process.env.SPORTS_HUB_DATA_DIR = dir;
    realFetch = globalThis.fetch;
    fetched = [];
    globalThis.fetch = async (url) => {
      fetched.push(String(url));
      throw new Error("HTTP 403 Forbidden: Host not in allowlist");
    };
  });
  after(() => {
    globalThis.fetch = realFetch;
    delete process.env.SPORTS_HUB_DATA_DIR;
  });

  it("reads a dropped-in season instead of the network, odds and all", async () => {
    const rows = await fetchLeagueSeason("I1", "2627");
    assert.equal(rows.length, 2);
    assert.equal(fetched.length, 0, "a local copy means no request at all");
    const matches = toMatches(rows, "I1", "2627", "avg");
    assert.equal(matches.length, 2);
    assert.equal(matches[0].prices.open.H.odds, 1.40, "the odds the mirrors do not have");
    assert.equal(matches[0].prices.close.H.odds, 1.35);
  });

  it("falls through to the network when the file is not there", async () => {
    // A league-season no other test touches: the HTTP cache is process-wide
    // and keyed by URL, so a combination used elsewhere would resolve from it.
    await assert.rejects(() => fetchLeagueSeason("D1", "9998"), /403/);
    assert.ok(fetched.some((u) => u.includes("football-data.co.uk")), "it did try the archive");
  });
});
