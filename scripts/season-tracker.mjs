#!/usr/bin/env node
/**
 * Season tracker — predict a round, log it, score it when the results land.
 *
 * A thin CLI over the `trading_` tools, so the loop runs with nothing but Node
 * and a network connection: no MCP client, no API key.
 *
 *   node scripts/season-tracker.mjs predict  --leagues I1,E0 [--days 10]
 *   node scripts/season-tracker.mjs score    --leagues I1,E0
 *   node scripts/season-tracker.mjs hindcast --leagues I1 [--min-history 4]
 *
 * Predictions are appended to predictions/<LEAGUE>-<SEASON>.json and are never
 * rewritten: a forecast you can edit after the result is not a forecast. New
 * predictions for a fixture already in the log are dropped, and the log says
 * when each one was made.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = (p) => join(root, "dist", p);
const trading = await import(dist("providers/trading.js"));
const { fitRatings, expectedGoals, matchModel } = await import(dist("shared/betting-math.js"));

const tools = new Map();
trading.register({ tool: (name, description, schema, handler) => tools.set(name, handler) });

async function call(name, args) {
  const result = await tools.get(name)(args);
  const text = result.content[0].text;
  if (result.isError) throw new Error(text.replace(/^Error: /, ""));
  return JSON.parse(text);
}

// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
const command = argv[0];
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
};
const leagues = flag("leagues", "I1").split(",").map((l) => l.trim().toUpperCase()).filter(Boolean);
const source = flag("source", "auto");

const logPath = (league, season) => join(root, "predictions", `${league}-${season}.json`);

async function readLog(league, season) {
  try {
    return JSON.parse(await readFile(logPath(league, season), "utf8"));
  } catch {
    return { league, season, created: new Date().toISOString(), predictions: [] };
  }
}

async function writeLog(log) {
  await mkdir(join(root, "predictions"), { recursive: true });
  await writeFile(logPath(log.league, log.season), `${JSON.stringify(log, null, 2)}\n`);
}

const keyOf = (p) => `${p.date}|${p.home}|${p.away}`.toLowerCase();
const pct = (x) => `${(x * 100).toFixed(0)}%`;

// ---------------------------------------------------------------------------

async function predict() {
  for (const league of leagues) {
    const data = await call("trading_predict_fixtures", {
      leagues: league, source, days_ahead: Number(flag("days", 10)), limit: 40,
    });
    const log = await readLog(league, data.season);
    const known = new Set(log.predictions.map(keyOf));
    const made = new Date().toISOString();
    const fresh = (data.predictions ?? [])
      .filter((p) => !known.has(keyOf(p)))
      .map((p) => ({ ...p, predicted_at: made, source: data.source?.[0] ?? source }));

    log.predictions.push(...fresh);
    log.model = data.model;
    await writeLog(log);

    console.log(`\n=== ${league} ${data.season} — ${fresh.length} new prediction(s), ${log.predictions.length} in the log ===`);
    if (data.market_data === false) console.log(`(no odds from this source — probabilities only)`);
    for (const p of fresh) {
      console.log(`${p.date} ${p.time ?? "     "}  ${p.home.padEnd(24)} v ${p.away.padEnd(24)} ` +
        `${pct(p.prob_home)}/${pct(p.prob_draw)}/${pct(p.prob_away)}  O2.5 ${pct(p.prob_over25)}  -> ${p.most_likely}` +
        (p.pick ? `  PICK ${p.pick.outcome} @ ${p.pick.odds} (edge ${p.pick.edge_pct}%)` : ""));
    }
    if (data.already_played_skipped) console.log(`skipped ${data.already_played_skipped} fixture(s) already played but not yet scored upstream`);
    for (const note of data.rating_notes ?? []) console.log(`note: ${note}`);
  }
}

async function score() {
  for (const league of leagues) {
    const season = flag("season", currentSeasonCode());
    const log = await readLog(league, season);
    if (log.predictions.length === 0) {
      console.log(`\n=== ${league} ${season} — nothing logged yet. Run "predict" first. ===`);
      continue;
    }
    const report = await call("trading_score_predictions", {
      predictions: log.predictions.map(({ date, league: lg, home, away, prob_home, prob_draw, prob_away, market_odds, pick }) => ({
        date, league: lg ?? league, home, away, prob_home, prob_draw, prob_away,
        ...(market_odds ? { market_odds } : {}), ...(pick ? { pick } : {}),
      })),
      season, source, sample: 60,
    });
    render(`${league} ${season} — logged predictions`, report);
    log.last_scored = { at: new Date().toISOString(), scored: report.scored, pending: report.pending_count, rps: report.probability_scores?.rps };
    await writeLog(log);
  }
}

/**
 * Walk-forward check on matches already played this season: rate each match
 * using only what was known before it, predict, then score. No lookahead, so
 * it answers "how would this model have done so far" honestly — the one
 * question you can ask before the next round is played.
 */
async function hindcast() {
  const minHistory = Number(flag("min-history", 4));
  for (const league of leagues) {
    const season = flag("season", currentSeasonCode());
    const { loadSeasons } = await import(dist("shared/football-source.js"));
    const previous = `${String((Number(season.slice(0, 2)) + 99) % 100).padStart(2, "0")}${season.slice(0, 2)}`;
    const { played, notes } = await loadSeasons(league, [previous, season], source);
    for (const note of notes) console.log(`note: ${note}`);
    const rows = [];
    const counts = new Map();
    const historyPool = [];
    for (const m of played) {
      const ready = (counts.get(m.home) ?? 0) >= minHistory && (counts.get(m.away) ?? 0) >= minHistory;
      // Only score the current season: the earlier one is what trains it.
      if (ready && m.season === season) {
        const fit = fitRatings(historyPool, { half_life_days: 240, as_of: m.ts });
        const xg = expectedGoals(fit, m.home, m.away);
        if (xg) {
          const model = matchModel(xg.home, xg.away, { rho: -0.1 });
          rows.push({
            date: m.date, league, home: m.home, away: m.away,
            prob_home: model.probabilities.home,
            prob_draw: model.probabilities.draw,
            prob_away: model.probabilities.away,
          });
        }
      }
      historyPool.push({ home: m.home, away: m.away, homeGoals: m.homeGoals, awayGoals: m.awayGoals, ts: m.ts });
      counts.set(m.home, (counts.get(m.home) ?? 0) + 1);
      counts.set(m.away, (counts.get(m.away) ?? 0) + 1);
    }
    if (rows.length === 0) {
      console.log(`\n=== ${league} ${season} — too few matches played to hindcast (need both sides to have ${minHistory}) ===`);
      continue;
    }
    render(`${league} ${season} — walk-forward hindcast on ${rows.length} played match(es)`, await call("trading_score_predictions", { predictions: rows, season, source, sample: 60 }));
  }
}

function render(title, r) {
  console.log(`\n=== ${title} ===`);
  if (!r.scored) {
    console.log(r.note ?? "nothing scored yet");
    if (r.pending?.length) console.log(`pending: ${r.pending.length}`);
    return;
  }
  console.log(`scored ${r.scored}, pending ${r.pending_count}   [source: ${(r.source ?? []).join(",")}]`);
  console.log(`hit rate ${r.accuracy.hit_rate_pct}%` + (r.accuracy.market_hit_rate_pct !== undefined ? `  (market ${r.accuracy.market_hit_rate_pct}%)` : ""));
  console.log(`RPS ${r.probability_scores.rps}  Brier ${r.probability_scores.brier}  log loss ${r.probability_scores.log_loss}`);
  if (r.benchmarks?.market) console.log(`market RPS ${r.benchmarks.market.rps}  ->  skill ${r.benchmarks.skill_vs_market_pct}%`);
  console.log(`base rates RPS ${r.benchmarks.base_rates.rps}  ->  ${r.probability_scores.rps < r.benchmarks.base_rates.rps ? "model beats" : "model loses to"} predicting 44/26/30 every match`);
  if (r.picks) console.log(`picks ${r.picks.wins}/${r.picks.bets}  P&L ${r.picks.profit}  ROI ${r.picks.roi_pct}%`);
  console.log("calibration (predicted -> actual):");
  for (const b of r.calibration) console.log(`  ${b.predicted_range.padStart(8)}  n=${String(b.predictions).padStart(4)}  said ${b.average_predicted_pct}%  happened ${b.actual_pct}%`);
  for (const m of (r.sample_matches ?? []).slice(0, 12)) {
    console.log(`  ${m.date} ${m.match.padEnd(46)} ${m.score}  said ${m.predicted} ${(m.predicted_probability * 100).toFixed(0)}%  -> ${m.hit ? "hit " : "miss"}  RPS ${m.rps}`);
  }
  console.log(`verdict: ${r.verdict}`);
}

function currentSeasonCode() {
  const now = new Date();
  const start = now.getUTCMonth() >= 6 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
  const two = (y) => String(y % 100).padStart(2, "0");
  return `${two(start)}${two(start + 1)}`;
}

const commands = { predict, score, hindcast };
if (!commands[command]) {
  console.error("usage: season-tracker.mjs <predict|score|hindcast> [--leagues I1,E0] [--days 10] [--season 2627] [--source auto]");
  process.exit(1);
}
await commands[command]();
