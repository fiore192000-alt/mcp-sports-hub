#!/usr/bin/env node
/**
 * Which flat strategy would have returned the most — chosen honestly.
 *
 *   npm run sweep -- [--leagues …] [--train 0506,…] [--validate 1920,…] [--stake-unit 1]
 *
 * Every strategy is run on a training period and on a validation period it was
 * not chosen on, because with a dozen strategies and two price sources, the
 * best training result is the luckiest one about as often as it is the best.
 * Both columns are printed for all of them, so the winner can be judged
 * against the field rather than announced.
 *
 * Settlement runs through trading_backtest, the tested engine, rather than a
 * second implementation of the same arithmetic.
 */

import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const trading = await import(join(root, "dist", "providers", "trading.js"));
const tools = new Map();
trading.register({ tool: (name, description, schema, handler) => tools.set(name, handler) });

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
};
const list = (s) => s.split(",").map((x) => x.trim()).filter(Boolean);

const leagues = list(flag("leagues", "E0,E1,E2,E3,EC,SC0,D1,D2,I1,I2,SP1,SP2,F1,F2,N1,B1,P1,T1,G1"));
const train = list(flag("train", "0506,0607,0708,0809,0910,1011,1112,1213,1314,1415,1516,1617,1718,1819"));
const validate = list(flag("validate", "1920,2021,2122,2223,2324,2425,2526,2627"));
const STRATEGIES = ["home", "draw", "away", "favourite", "underdog", "over25", "under25"];
const BOOKS = ["avg", "max"];
const CHUNK = 10;   // the tool caps a call at 20 league-seasons; one league at a time, in chunks

async function run(strategy, book, seasons) {
  let bets = 0, staked = 0, pnl = 0, wins = 0, oddsSum = 0, worstDrawdown = 0;
  for (const league of leagues) {
    for (let i = 0; i < seasons.length; i += CHUNK) {
      const slice = seasons.slice(i, i + CHUNK);
      const result = await tools.get("trading_backtest")({
        strategy, leagues: league, seasons: slice.join(","),
        source: "footballdata", phase: "open", book, sample_bets: 0,
      });
      if (result.isError) continue;
      const data = JSON.parse(result.content[0].text);
      if (!data.results) continue;
      bets += data.results.bets;
      staked += data.results.total_staked;
      pnl += data.results.profit;
      wins += data.results.wins;
      oddsSum += data.results.average_odds * data.results.bets;
      worstDrawdown = Math.max(worstDrawdown, data.results.max_drawdown_pct);
    }
  }
  const strike = bets ? wins / bets : 0;
  const avgOdds = bets ? oddsSum / bets : 0;
  // Standard error of ROI for flat stakes: a won bet returns (odds-1), a lost
  // one -1, so the per-bet variance is about p(1-p)*odds^2. Without it, a
  // small number looks like a result when it is the width of the noise.
  const sd = Math.sqrt(strike * (1 - strike)) * avgOdds;
  return {
    bets, pnl: Math.round(pnl * 100) / 100,
    roi: staked ? (pnl / staked) * 100 : 0,
    se: bets ? (sd / Math.sqrt(bets)) * 100 : 0,
    strike: strike * 100,
    avgOdds,
    worstDrawdown,
  };
}

console.log(`${leagues.length} leagues`);
console.log(`train    ${train[0]}-${train[train.length - 1]} (${train.length} seasons)`);
console.log(`validate ${validate[0]}-${validate[validate.length - 1]} (${validate.length} seasons)\n`);

const rows = [];
for (const book of BOOKS) {
  for (const strategy of STRATEGIES) {
    const t = await run(strategy, book, train);
    const v = await run(strategy, book, validate);
    rows.push({ strategy, book, t, v });
    console.log(
      `${strategy.padEnd(10)} ${book.padEnd(4)}  train ${t.roi.toFixed(2).padStart(6)}% ±${t.se.toFixed(2)} (n=${String(t.bets).padStart(6)})` +
      `   validate ${v.roi.toFixed(2).padStart(6)}% ±${v.se.toFixed(2)} (n=${String(v.bets).padStart(5)})` +
      `   quota ${v.avgOdds.toFixed(2)}`,
    );
  }
}

const bestTrain = [...rows].sort((a, b) => b.t.roi - a.t.roi)[0];
const bestValidate = [...rows].sort((a, b) => b.v.roi - a.v.roi)[0];
const positiveBoth = rows.filter((r) => r.t.roi > 0 && r.v.roi > 0);

console.log(`\nbest on training:   ${bestTrain.strategy} @ ${bestTrain.book}  ${bestTrain.t.roi.toFixed(2)}%`);
console.log(`  its validation:   ${bestTrain.v.roi.toFixed(2)}% over ${bestTrain.v.bets} bets, worst drawdown ${bestTrain.v.worstDrawdown.toFixed(1)}%`);
console.log(`best on validation: ${bestValidate.strategy} @ ${bestValidate.book}  ${bestValidate.v.roi.toFixed(2)}% (training ${bestValidate.t.roi.toFixed(2)}%)`);
console.log(`positive in BOTH periods: ${positiveBoth.length ? positiveBoth.map((r) => `${r.strategy}@${r.book}`).join(", ") : "none"}`);
const beyondNoise = rows.filter((r) => r.v.roi - 2 * r.v.se > 0);
console.log(`validation ROI more than two standard errors above zero: ${beyondNoise.length ? beyondNoise.map((r) => `${r.strategy}@${r.book}`).join(", ") : "none"}`);
console.log(`\n${rows.length} strategy/book combinations were tried. The best of ${rows.length} is expected to look good by chance alone;`);
console.log("only a combination that holds up on the period it was not chosen on is worth a second look.");
