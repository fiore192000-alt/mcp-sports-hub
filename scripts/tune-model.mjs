#!/usr/bin/env node
/**
 * Search for a better forecasting model, honestly.
 *
 * Every candidate is evaluated walk-forward — each match rated only on results
 * that preceded it — and parameters are CHOSEN on the training seasons and
 * REPORTED on validation seasons the search never saw. Tuning and reporting on
 * the same data is how a model that has learned nothing comes to look good.
 *
 *   npm run tune -- [--leagues I1,E0] [--train 1516,…] [--validate 2223,…] [--grid basic|full]
 *
 * Scoring comes from shared/betting-math.ts, the same code the scoring tool
 * uses, so a number here means what it means there.
 */

import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = (p) => join(root, "dist", p);
const { loadSeasons } = await import(dist("shared/football-source.js"));
const { fitRatings, expectedGoals, matchModel, scoreForecasts, BASE_RATES } = await import(dist("shared/betting-math.js"));

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
};
const list = (s) => s.split(",").map((x) => x.trim()).filter(Boolean);

const leagues = list(flag("leagues", "I1,E0,SP1,D1,F1"));
const train = list(flag("train", "1617,1718,1819,1920,2021"));
const validate = list(flag("validate", "2122,2223,2324,2425,2526"));
const minHistory = Number(flag("min-history", 4));

// ---------------------------------------------------------------------------
// Data, loaded once and reused across every candidate.
// ---------------------------------------------------------------------------

const prevOf = (s) => `${String((Number(s.slice(0, 2)) + 99) % 100).padStart(2, "0")}${s.slice(0, 2)}`;
const cache = new Map();

async function seasonMatches(league, season) {
  const key = `${league}|${season}`;
  if (!cache.has(key)) {
    const { played } = await loadSeasons(league, [season], "auto");
    cache.set(key, played);
  }
  return cache.get(key);
}

async function corpus(seasons) {
  const out = [];
  for (const league of leagues) {
    for (const season of seasons) {
      const history = await seasonMatches(league, prevOf(season));
      const current = await seasonMatches(league, season);
      if (current.length === 0) continue;
      out.push({ league, season, matches: [...history, ...current].sort((a, b) => a.ts - b.ts) });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// One candidate model
// ---------------------------------------------------------------------------

const outcomeIndex = (result) => (result === "H" ? 0 : result === "D" ? 1 : 2);

/** Pull the model's probabilities toward the base rates, a cheap regularizer. */
function blend(p, weight) {
  if (!weight) return p;
  return p.map((x, i) => (1 - weight) * x + weight * BASE_RATES[i]);
}

function evaluate(groups, params) {
  const forecasts = [];
  for (const group of groups) {
    const counts = new Map();
    const pool = [];
    for (const m of group.matches) {
      const seen = { home: counts.get(m.home) ?? 0, away: counts.get(m.away) ?? 0 };
      const rateable = params.promoted
        ? true
        : seen.home >= minHistory && seen.away >= minHistory;
      if (rateable && m.season === group.season) {
        const fit = fitRatings(pool, {
          half_life_days: params.half_life,
          prior_matches: params.prior,
          as_of: m.ts,
          home_away_split: params.split,
        });
        const xg = expectedGoals(fit, m.home, m.away, params.promoted ? { fallback: params.promoted } : undefined);
        if (xg) {
          const model = matchModel(xg.home, xg.away, { rho: params.rho });
          const p = blend([model.probabilities.home, model.probabilities.draw, model.probabilities.away], params.blend);
          forecasts.push({ p, actual: outcomeIndex(m.result) });
        }
      }
      pool.push({ home: m.home, away: m.away, homeGoals: m.homeGoals, awayGoals: m.awayGoals, ts: m.ts });
      counts.set(m.home, seen.home + 1);
      counts.set(m.away, seen.away + 1);
    }
  }
  return scoreForecasts(forecasts);
}

const label = (p) =>
  `hl=${p.half_life ?? "off"} prior=${p.prior} rho=${p.rho}` +
  (p.blend ? ` blend=${p.blend}` : "") +
  (p.split ? " split" : "") +
  (p.promoted ? ` promoted=${p.promoted.attack}/${p.promoted.defence}` : "");

// ---------------------------------------------------------------------------

const BASELINE = { half_life: 240, prior: 4, rho: -0.1, blend: 0, split: false, promoted: null };

function grid(kind) {
  const out = [];
  const halfLives = [120, 180, 240, 365, 540, null];
  const priors = [2, 4, 8, 16];
  const rhos = [0, -0.05, -0.1, -0.15];
  for (const half_life of halfLives) {
    for (const prior of priors) {
      for (const rho of rhos) out.push({ ...BASELINE, half_life, prior, rho });
    }
  }
  if (kind === "full") {
    for (const blend of [0.05, 0.1, 0.2]) out.push({ ...BASELINE, blend });
    out.push({ ...BASELINE, split: true });
    for (const attack of [0.85, 0.95]) {
      for (const defence of [1.05, 1.15]) out.push({ ...BASELINE, promoted: { attack, defence } });
    }
  }
  return out;
}

console.log(`leagues ${leagues.join(",")}`);
console.log(`train    ${train.join(",")}`);
console.log(`validate ${validate.join(",")}\n`);

const trainSet = await corpus(train);
const validateSet = await corpus(validate);
console.log(`loaded ${trainSet.length} training and ${validateSet.length} validation league-seasons\n`);

const baseTrain = evaluate(trainSet, BASELINE);
const baseValidate = evaluate(validateSet, BASELINE);
console.log(`baseline  ${label(BASELINE)}`);
console.log(`  train    n=${baseTrain.n} RPS ${baseTrain.rps.toFixed(5)} hit ${(baseTrain.hit_rate * 100).toFixed(2)}%`);
console.log(`  validate n=${baseValidate.n} RPS ${baseValidate.rps.toFixed(5)} hit ${(baseValidate.hit_rate * 100).toFixed(2)}%\n`);

// --compare evaluates named variants on BOTH splits, which answers "does this
// idea help?" rather than "which cell of a grid won a lottery".
if (argv.includes("--compare")) {
  const variants = [
    ["baseline", BASELINE],
    ["no decay", { ...BASELINE, half_life: null }],
    ["fast decay (120d)", { ...BASELINE, half_life: 120 }],
    ["slow decay (540d)", { ...BASELINE, half_life: 540 }],
    ["weak shrinkage (2)", { ...BASELINE, prior: 2 }],
    ["strong shrinkage (16)", { ...BASELINE, prior: 16 }],
    ["no Dixon-Coles", { ...BASELINE, rho: 0 }],
    ["strong Dixon-Coles", { ...BASELINE, rho: -0.15 }],
    ["blend 5% to base rates", { ...BASELINE, blend: 0.05 }],
    ["blend 10% to base rates", { ...BASELINE, blend: 0.1 }],
    ["blend 20% to base rates", { ...BASELINE, blend: 0.2 }],
    ["home/away split", { ...BASELINE, split: true }],
    ["promoted prior 0.85/1.15", { ...BASELINE, promoted: { attack: 0.85, defence: 1.15 } }],
    ["promoted prior 0.95/1.05", { ...BASELINE, promoted: { attack: 0.95, defence: 1.05 } }],
    ["promoted + slow decay", { ...BASELINE, half_life: 365, promoted: { attack: 0.9, defence: 1.1 } }],
  ];
  console.log("variant                        train RPS   validate RPS   vs baseline   n(val)");
  for (const [name, params] of variants) {
    const t = evaluate(trainSet, params);
    const v = evaluate(validateSet, params);
    const delta = (1 - v.rps / baseValidate.rps) * 100;
    console.log(
      `${name.padEnd(28)}  ${t.rps.toFixed(5)}     ${v.rps.toFixed(5)}     ` +
      `${(delta >= 0 ? "+" : "") + delta.toFixed(2)}%`.padStart(10) +
      `   ${v.n}`,
    );
  }
  process.exit(0);
}

const candidates = grid(flag("grid", "basic"));
const scored = [];
for (const params of candidates) {
  const s = evaluate(trainSet, params);
  scored.push({ params, train: s });
}
scored.sort((a, b) => a.train.rps - b.train.rps);

console.log(`top 10 of ${scored.length} candidates, by TRAINING RPS:`);
for (const { params, train: s } of scored.slice(0, 10)) {
  console.log(`  ${s.rps.toFixed(5)}  ${label(params)}`);
}

const best = scored[0];
const bestValidate = evaluate(validateSet, best.params);
const improvement = (1 - bestValidate.rps / baseValidate.rps) * 100;

console.log(`\nbest on training: ${label(best.params)}`);
console.log(`  train    RPS ${best.train.rps.toFixed(5)} (baseline ${baseTrain.rps.toFixed(5)})`);
console.log(`  VALIDATE RPS ${bestValidate.rps.toFixed(5)} (baseline ${baseValidate.rps.toFixed(5)})  ->  ${improvement >= 0 ? "+" : ""}${improvement.toFixed(2)}% vs baseline`);
console.log(`  validate hit ${(bestValidate.hit_rate * 100).toFixed(2)}% (baseline ${(baseValidate.hit_rate * 100).toFixed(2)}%)`);
if (improvement <= 0.5) {
  console.log("\n  An improvement this small on held-out data is not an improvement. Keep the simpler model.");
}
