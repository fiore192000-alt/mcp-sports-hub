#!/usr/bin/env node
/**
 * Search situational patterns for the highest return — and measure how much of
 * what it finds is luck.
 *
 *   npm run patterns -- [--train-until 2019] [--min-bets 300]
 *
 * This is deliberate data mining, run properly. A thousand filters over a
 * million bets will always produce winners; the questions that matter are
 * whether the winner survives a period it was not chosen on, and whether its
 * streaks are longer than chance would produce anyway. Both are reported next
 * to every result, along with how many combinations were tried.
 *
 * Reads the archive mirror directly (data/Matches.csv from fetch-archive's
 * source), because it carries Elo and form columns the per-league CSVs drop.
 */

import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { parseCsv } = await import(join(root, "dist", "shared", "football-csv.js"));

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d; };
const SPLIT = Date.parse(`${flag("train-until", "2019")}-07-01T00:00:00Z`);
const MIN_BETS = Number(flag("min-bets", "300"));
const SOURCE = flag("source", "/tmp/claude-0/-home-user-mcp-sports-hub/e2b91aea-3e3e-5b2a-8770-b486ebb779c1/scratchpad/Matches.csv");

const num = (v) => { const n = Number.parseFloat(v); return Number.isFinite(n) ? n : undefined; };
const rows = [];
for (const r of parseCsv(await readFile(SOURCE, "utf8"))) {
  const ts = Date.parse(`${r.MatchDate}T00:00:00Z`);
  const hg = num(r.FTHome), ag = num(r.FTAway);
  if (!Number.isFinite(ts) || hg === undefined || ag === undefined || !r.FTResult) continue;
  const avg = [num(r.OddHome), num(r.OddDraw), num(r.OddAway)];
  const max = [num(r.MaxHome), num(r.MaxDraw), num(r.MaxAway)];
  if (!avg.every((o) => o > 1)) continue;
  rows.push({
    ts, div: r.Division,
    result: r.FTResult === "H" ? 0 : r.FTResult === "D" ? 1 : 2,
    goals: hg + ag,
    avg, max: max.every((o) => o > 1) ? max : avg,
    ou: [num(r.Over25), num(r.Under25)],
    ouMax: [num(r.MaxOver25) ?? num(r.Over25), num(r.MaxUnder25) ?? num(r.Under25)],
    eloDiff: (num(r.HomeElo) ?? 0) - (num(r.AwayElo) ?? 0),
    form5H: num(r.Form5Home), form5A: num(r.Form5Away),
  });
}
rows.sort((a, b) => a.ts - b.ts);
console.log(`${rows.length} matches with prices, ${new Date(rows[0].ts).toISOString().slice(0, 10)} to ${new Date(rows[rows.length - 1].ts).toISOString().slice(0, 10)}\n`);

// --- the search space -------------------------------------------------------
const SIDES = {
  home:      (m) => ({ i: 0, won: m.result === 0 }),
  draw:      (m) => ({ i: 1, won: m.result === 1 }),
  away:      (m) => ({ i: 2, won: m.result === 2 }),
  favourite: (m) => { const i = m.avg.indexOf(Math.min(...m.avg)); return { i, won: m.result === i }; },
  underdog:  (m) => { const i = m.avg.indexOf(Math.max(...m.avg)); return { i, won: m.result === i }; },
};
const ODDS_BANDS = [["any", 1, 99], ["1.0-1.5", 1, 1.5], ["1.5-2.0", 1.5, 2], ["2.0-3.0", 2, 3], ["3.0-5.0", 3, 5], ["5.0+", 5, 99]];
const ELO_BANDS = [["any", -9999, 9999], ["home much stronger", 150, 9999], ["home stronger", 50, 9999], ["close", -50, 50], ["home weaker", -9999, -50]];
const FORM = [["any", () => true], ["backed in form", (m, side) => (side.i === 2 ? m.form5A : m.form5H) >= 10], ["backed out of form", (m, side) => (side.i === 2 ? m.form5A : m.form5H) <= 4]];
const BOOKS = [["avg", (m) => m.avg], ["max", (m) => m.max]];

function evaluate(sideName, band, elo, form, bookName, book, set) {
  let bets = 0, pnl = 0, wins = 0, oddsSum = 0, run = 0, longest = 0;
  for (const m of set) {
    const side = SIDES[sideName](m);
    if (side.i === undefined) continue;
    if (m.eloDiff < elo[1] || m.eloDiff > elo[2]) continue;
    if (!form[1](m, side)) continue;
    const price = book(m)[side.i];
    if (!(price > 1) || price < band[1] || price >= band[2]) continue;
    bets++; oddsSum += price;
    if (side.won) { wins++; pnl += price - 1; run++; longest = Math.max(longest, run); }
    else { pnl -= 1; run = 0; }
  }
  const strike = bets ? wins / bets : 0;
  const avgOdds = bets ? oddsSum / bets : 0;
  const se = bets ? (Math.sqrt(strike * (1 - strike)) * avgOdds) / Math.sqrt(bets) * 100 : 0;
  // What the longest winning run would be by chance alone at this strike rate.
  const expectedRun = bets && strike > 0 && strike < 1 ? Math.log(bets) / Math.log(1 / strike) : 0;
  return { bets, roi: bets ? (pnl / bets) * 100 : 0, se, strike: strike * 100, avgOdds, longest, expectedRun };
}

const train = rows.filter((r) => r.ts < SPLIT);
const valid = rows.filter((r) => r.ts >= SPLIT);
console.log(`train ${train.length} matches, validation ${valid.length}\n`);

const found = [];
for (const sideName of Object.keys(SIDES))
  for (const band of ODDS_BANDS)
    for (const elo of ELO_BANDS)
      for (const form of FORM)
        for (const [bookName, book] of BOOKS) {
          const t = evaluate(sideName, band, elo, form, bookName, book, train);
          if (t.bets < MIN_BETS) continue;
          const v = evaluate(sideName, band, elo, form, bookName, book, valid);
          if (v.bets < MIN_BETS / 3) continue;
          found.push({ label: `${sideName} @${bookName} | quota ${band[0]} | elo ${elo[0]} | ${form[0]}`, t, v });
        }

console.log(`${found.length} combinations tested with enough bets in both periods\n`);
const byTrain = [...found].sort((a, b) => b.t.roi - a.t.roi);
console.log("TOP 10 PER ROI IN TRAINING — e cosa hanno fatto dopo");
console.log("pattern                                                        train ROI      validation ROI");
for (const f of byTrain.slice(0, 10)) {
  console.log(`${f.label.padEnd(60)} ${f.t.roi.toFixed(2).padStart(7)}% (n=${String(f.t.bets).padStart(5)})  ${f.v.roi.toFixed(2).padStart(7)}% ±${f.v.se.toFixed(2)} (n=${String(f.v.bets).padStart(5)})`);
}

const survivors = found.filter((f) => f.t.roi > 0 && f.v.roi > 0);
const significant = survivors.filter((f) => f.v.roi - 2 * f.v.se > 0);
console.log(`\npositive in BOTH periods: ${survivors.length} of ${found.length}`);
console.log(`...and more than two standard errors above zero in validation: ${significant.length}`);
for (const f of significant) console.log(`   ${f.label}  validation ${f.v.roi.toFixed(2)}% ±${f.v.se.toFixed(2)} (n=${f.v.bets})`);

console.log("\nSTREAK PIU' LUNGHE (validation) — contro quanto la sola fortuna produrrebbe");
const byRun = [...found].sort((a, b) => b.v.longest - a.v.longest).slice(0, 8);
console.log("pattern                                                       vinte di fila   attese   strike   ROI");
for (const f of byRun) {
  console.log(`${f.label.padEnd(60)} ${String(f.v.longest).padStart(9)}   ${f.v.expectedRun.toFixed(1).padStart(6)}   ${f.v.strike.toFixed(1).padStart(5)}%  ${f.v.roi.toFixed(2).padStart(7)}%`);
}
