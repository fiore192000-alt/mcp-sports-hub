#!/usr/bin/env node
/**
 * Season tracker — predict a round, log it, score it when the results land.
 *
 * A thin CLI over the `trading_` tools, so the loop runs with nothing but Node
 * and a network connection: no MCP client, no API key.
 *
 *   node scripts/season-tracker.mjs predict  --leagues I1,E0 [--days 10]
 *                                            [--supersede "why the old ones are wrong"]
 *   node scripts/season-tracker.mjs score    --leagues I1,E0
 *   node scripts/season-tracker.mjs hindcast --leagues I1,E0 [--seasons 2324,2425] [--min-history 4]
 *   node scripts/season-tracker.mjs review   --leagues I1 [--last 10]
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
  const supersede = flag("supersede", null);
  for (const league of leagues) {
    const data = await call("trading_predict_fixtures", {
      leagues: league, source, days_ahead: Number(flag("days", 10)), limit: 40,
    });
    const log = await readLog(league, data.season);

    // Superseding is for a broken model or broken input, never for a result
    // you did not like: only predictions on matches still ahead of us can be
    // retired, the old row stays in the log, and the reason is recorded.
    let retired = 0;
    if (supersede) {
      const stillAhead = new Set((data.predictions ?? []).map(keyOf));
      const at = new Date().toISOString();
      for (const p of log.predictions) {
        if (!p.superseded_at && stillAhead.has(keyOf(p))) {
          p.superseded_at = at;
          p.superseded_reason = supersede;
          retired++;
        }
      }
    }

    const known = new Set(log.predictions.filter((p) => !p.superseded_at).map(keyOf));
    const made = new Date().toISOString();
    const fresh = (data.predictions ?? [])
      .filter((p) => !known.has(keyOf(p)))
      .map((p) => ({ ...p, predicted_at: made, source: data.source?.[0] ?? source }));

    log.predictions.push(...fresh);
    log.model = data.model;
    await writeLog(log);

    console.log(`\n=== ${league} ${data.season} — ${fresh.length} new prediction(s), ${log.predictions.length} in the log ===`);
    if (retired) console.log(`superseded ${retired} earlier prediction(s), kept in the log: ${supersede}`);
    if (data.data_quality) console.log(`data quality: ${JSON.stringify(data.data_quality)}`);
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
      predictions: log.predictions.filter((p) => !p.superseded_at).map(({ date, league: lg, home, away, prob_home, prob_draw, prob_away, market_odds, pick }) => ({
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
 * Walk-forward check on matches already played: rate each match using only
 * what was known before it, predict, then score. No lookahead, so it answers
 * "how would this model have done" honestly — across as many seasons and
 * leagues as you point it at.
 *
 * Each league-season is trained on the season before it and scored on its own
 * matches, then the summaries are pooled by match count. Pooling weighted
 * means rather than re-deriving the metrics keeps one implementation of the
 * maths, in the tool.
 */
async function hindcast() {
  const minHistory = Number(flag("min-history", 4));
  const seasons = (flag("seasons", null) ?? currentSeasonCode()).split(",").map((x) => x.trim()).filter(Boolean);
  const { loadSeasons } = await import(dist("shared/football-source.js"));
  const rowsOf = [];

  for (const league of leagues) {
    for (const season of seasons) {
      const previous = `${String((Number(season.slice(0, 2)) + 99) % 100).padStart(2, "0")}${season.slice(0, 2)}`;
      let played, notes;
      try {
        ({ played, notes } = await loadSeasons(league, [previous, season], source));
      } catch (err) {
        console.log(`${league} ${season}: skipped (${err.message.slice(0, 80)})`);
        continue;
      }
      for (const note of notes) if (!/unreachable/.test(note)) console.log(`note: ${note}`);

      const predictions = [];
      const counts = new Map();
      const pool = [];
      for (const m of played) {
        const ready = (counts.get(m.home) ?? 0) >= minHistory && (counts.get(m.away) ?? 0) >= minHistory;
        if (ready && m.season === season) {
          const fit = fitRatings(pool, { half_life_days: 240, as_of: m.ts });
          const xg = expectedGoals(fit, m.home, m.away);
          if (xg) {
              const model = matchModel(xg.home, xg.away, { rho: -0.1 });
            // Attach the prices this match actually carried, so the scorer can
            // put the model next to the market instead of next to base rates.
            // Closing where the season has it, opening otherwise.
            const priced = (outcome) => m.prices.close[outcome]?.odds ?? m.prices.open[outcome]?.odds;
            const market = { home: priced("H"), draw: priced("D"), away: priced("A") };
            predictions.push({
              date: m.date, league, home: m.home, away: m.away,
              prob_home: model.probabilities.home,
              prob_draw: model.probabilities.draw,
              prob_away: model.probabilities.away,
              ...(market.home && market.draw && market.away ? { market_odds: market } : {}),
            });
          }
        }
        pool.push({ home: m.home, away: m.away, homeGoals: m.homeGoals, awayGoals: m.awayGoals, ts: m.ts });
        counts.set(m.home, (counts.get(m.home) ?? 0) + 1);
        counts.set(m.away, (counts.get(m.away) ?? 0) + 1);
      }
      if (predictions.length === 0) {
        console.log(`${league} ${season}: nothing to score (needs the previous season for history)`);
        continue;
      }
      const report = await call("trading_score_predictions", { predictions, season, source, sample: 0 });
      rowsOf.push({ league, season, report });
      const skill = 1 - report.probability_scores.rps / report.benchmarks.base_rates.rps;
      console.log(
        `${league} ${season}  n=${String(report.scored).padStart(4)}  ` +
        `hit ${String(report.accuracy.hit_rate_pct).padStart(6)}%  ` +
        `RPS ${report.probability_scores.rps.toFixed(4)}  base ${report.benchmarks.base_rates.rps.toFixed(4)}  ` +
        `skill ${(skill * 100).toFixed(1)}%`,
      );
    }
  }

  if (rowsOf.length === 0) { console.log("nothing hindcast"); return; }
  if (rowsOf.length === 1) { render(`${rowsOf[0].league} ${rowsOf[0].season}`, rowsOf[0].report); return; }

  // Pool by match count.
  const total = rowsOf.reduce((n, r) => n + r.report.scored, 0);
  const weighted = (get) => rowsOf.reduce((n, r) => n + get(r.report) * r.report.scored, 0) / total;
  const buckets = new Map();
  for (const { report } of rowsOf) {
    for (const b of report.calibration) {
      const acc = buckets.get(b.predicted_range) ?? { n: 0, predicted: 0, observed: 0 };
      acc.n += b.predictions;
      acc.predicted += (b.average_predicted_pct / 100) * b.predictions;
      acc.observed += (b.actual_pct / 100) * b.predictions;
      buckets.set(b.predicted_range, acc);
    }
  }
  const rps = weighted((r) => r.probability_scores.rps);
  const base = weighted((r) => r.benchmarks.base_rates.rps);
  const worst = [...rowsOf].sort((a, b) =>
    (1 - a.report.probability_scores.rps / a.report.benchmarks.base_rates.rps) -
    (1 - b.report.probability_scores.rps / b.report.benchmarks.base_rates.rps))[0];

  console.log(`\n=== pooled over ${rowsOf.length} league-seasons, ${total} matches ===`);
  console.log(`hit rate ${(weighted((r) => r.accuracy.hit_rate_pct)).toFixed(2)}%`);
  console.log(`RPS ${rps.toFixed(4)}  vs base rates ${base.toFixed(4)}  ->  skill ${((1 - rps / base) * 100).toFixed(1)}%`);
  console.log(`Brier ${(weighted((r) => r.probability_scores.brier)).toFixed(4)}  log loss ${(weighted((r) => r.probability_scores.log_loss)).toFixed(4)}`);
  console.log(`worst league-season: ${worst.league} ${worst.season} (skill ${((1 - worst.report.probability_scores.rps / worst.report.benchmarks.base_rates.rps) * 100).toFixed(1)}%)`);
  console.log("calibration (predicted -> actual):");
  for (const [range, b] of [...buckets.entries()].sort()) {
    if (b.n < 30) continue;
    console.log(`  ${range.padStart(8)}  n=${String(b.n).padStart(5)}  said ${(b.predicted / b.n * 100).toFixed(1)}%  happened ${(b.observed / b.n * 100).toFixed(1)}%`);
  }
}

/**
 * Look at the last N played matches one by one: what the model said before each
 * one, what happened, and how wrong it was.
 *
 * Deliberately not a verdict. Ten matches cannot tell you whether a model is
 * good — the report prints the confidence interval so that is visible rather
 * than assumed. What a review this short IS good for is the process: whether
 * every fixture got priced, whether the data had holes, and which misses share
 * a mechanism worth testing on a real sample.
 */
async function review() {
  const last = Number(flag("last", 10));
  const { loadSeasons } = await import(dist("shared/football-source.js"));
  const { rankedProbabilityScore, scoreForecasts, devig, BASE_RATES } = await import(dist("shared/betting-math.js"));
  const idx = (r) => (r === "H" ? 0 : r === "D" ? 1 : 2);
  const label = ["1", "X", "2"];

  for (const league of leagues) {
    const season = flag("season", currentSeasonCode());
    const previous = `${String((Number(season.slice(0, 2)) + 99) % 100).padStart(2, "0")}${season.slice(0, 2)}`;
    const { played } = await loadSeasons(league, [previous, season], source);
    const current = played.filter((m) => m.season === season);
    const window = current.slice(-last);
    if (window.length === 0) { console.log(`${league}: nessuna partita giocata in ${season}`); continue; }

    const rows = [];
    let unrated = 0;
    for (const m of window) {
      const before = played.filter((x) => x.ts < m.ts);
      const fit = fitRatings(before.map((x) => ({ home: x.home, away: x.away, homeGoals: x.homeGoals, awayGoals: x.awayGoals, ts: x.ts })),
        { half_life_days: 240, prior_matches: 4, as_of: m.ts });
      const xg = expectedGoals(fit, m.home, m.away, { fallback: { attack: 0.85, defence: 1.15 } });
      if (!xg) { unrated++; continue; }
      const model = matchModel(xg.home, xg.away, { rho: -0.1 });
      const p = [model.probabilities.home, model.probabilities.draw, model.probabilities.away];
      const actual = idx(m.result);
      const priced = ["H", "D", "A"].map((k) => m.prices.open[k]?.odds ?? m.prices.close[k]?.odds);
      const odds = priced.every(Boolean) ? priced : undefined;
      // Where the prices exist, score the market on the same match: it is the
      // only benchmark that means anything, and ten matches is already enough
      // to see whether the model is in the same postcode.
      const marketP = odds ? devig(odds, "shin").probabilities : undefined;
      rows.push({
        m, p, actual, odds, marketP,
        rps: rankedProbabilityScore(p, actual),
        marketRps: marketP ? rankedProbabilityScore(marketP, actual) : undefined,
      });
    }

    const s = scoreForecasts(rows.map((r) => ({ p: r.p, actual: r.actual })));
    const base = scoreForecasts(rows.map((r) => ({ p: BASE_RATES, actual: r.actual })));
    const sd = rows.length > 1
      ? Math.sqrt(rows.reduce((a, r) => a + (r.rps - s.rps) ** 2, 0) / (rows.length - 1))
      : 0;
    const margin = 2 * sd / Math.sqrt(rows.length || 1);

    console.log(`\n=== ${league} ${season} — ultime ${rows.length} giocate (${rows[0].m.date} -> ${rows[rows.length-1].m.date}) ===`);
    const pc = (x) => `${(x * 100).toFixed(0)}%`.padStart(4);
    for (const r of rows) {
      const best = r.p.indexOf(Math.max(...r.p));
      const versus = r.marketRps !== undefined
        ? `  mercato ${pc(r.marketP[0])}/${pc(r.marketP[1])}/${pc(r.marketP[2])} RPS ${r.marketRps.toFixed(3)} ${r.rps < r.marketRps ? "(meglio noi)" : "(meglio il mercato)"}`
        : "";
      console.log(`${r.m.date}  ${(r.m.home + " v " + r.m.away).padEnd(40)} ${pc(r.p[0])}/${pc(r.p[1])}/${pc(r.p[2])}  ` +
        `-> ${label[r.actual]} ${r.m.homeGoals}-${r.m.awayGoals}  RPS ${r.rps.toFixed(3)}${versus}`);
    }
    console.log(`\nazzeccate ${s.hits}/${s.n}  |  RPS ${s.rps.toFixed(4)} contro ${base.rps.toFixed(4)} dei tassi base`);
    console.log(`intervallo a due sigma: ${(s.rps - margin).toFixed(3)} - ${(s.rps + margin).toFixed(3)}`);
    console.log(`  → ${rows.length} partite non dicono se il modello sia buono: l'intervallo è largo quanto la differenza fra un modello utile e uno inutile.`);
    if (unrated) console.log(`  ${unrated} partita/e non valutabile/i (squadra senza storico)`);
    const withOdds = rows.filter((r) => r.odds).length;
    const priced = rows.filter((r) => r.marketRps !== undefined);
    if (priced.length) {
      const ours = scoreForecasts(priced.map((r) => ({ p: r.p, actual: r.actual })));
      const theirs = scoreForecasts(priced.map((r) => ({ p: r.marketP, actual: r.actual })));
      const beaten = priced.filter((r) => r.rps < r.marketRps).length;
      console.log(`  contro il mercato su ${priced.length}: noi ${ours.rps.toFixed(4)}, mercato ${theirs.rps.toFixed(4)} ` +
        `(${((1 - ours.rps / theirs.rps) * 100).toFixed(1)}%), battuto in ${beaten}/${priced.length} partite`);
      console.log("  \u2192 questo è il confronto che conta; su dieci partite resta rumore, ma è rumore attorno alla cosa giusta.");
    }
    if (withOdds < rows.length) {
      console.log(`  quote mancanti su ${rows.length - withOdds}/${rows.length}: senza prezzi non c'è confronto col mercato, che è l'unico metro che converge in fretta`);
    }

    const worstMissed = rows.filter((r) => r.p.indexOf(Math.max(...r.p)) !== r.actual).sort((a, b) => b.rps - a.rps).slice(0, 3);
    if (worstMissed.length) {
      console.log("\nerrori da cui vale la pena partire (sbagliati, ordinati per gravità):");
      for (const r of worstMissed) {
        const best = r.p.indexOf(Math.max(...r.p));
        console.log(`  ${r.m.date} ${r.m.home} v ${r.m.away}: dava ${label[best]} al ${(r.p[best] * 100).toFixed(0)}%, uscito ${label[r.actual]} (${r.m.homeGoals}-${r.m.awayGoals})`);
      }
      console.log("  cerca un meccanismo comune (espulsioni, coppe infrasettimanali, neopromosse), non un pattern: con questi numeri un pattern è rumore.");
    }
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

const commands = { predict, score, hindcast, review };
if (!commands[command]) {
  console.error("usage: season-tracker.mjs <predict|score|hindcast|review> [--leagues I1,E0] [--days 10] [--last 10] [--season 2627] [--source auto]");
  process.exit(1);
}
await commands[command]();
