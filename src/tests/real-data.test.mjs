/**
 * Tests against a real season, kept verbatim in src/tests/fixtures.
 *
 * The stubbed tests check that the code does what it was written to do. These
 * check that it survives data as it actually arrives: real team names, real
 * date spreads, real postponements — and a real hole, since the source is
 * missing the whole final matchday of Serie A 2024-25.
 *
 * Offline and deterministic: the fixture is a file, and the model has no
 * randomness, so the metrics below are exact regression values.
 *
 * Run via: npm test
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dist = (p) => join(__dirname, "..", "..", "dist", p);

// Point the local-CSV drop-in at nothing, so whatever a developer happens to
// have in data/football-data cannot change what these tests see.
process.env.SPORTS_HUB_DATA_DIR = join(__dirname, "fixtures", "no-such-dir");

const { fetchOpenFootballSeason } = await import(dist("shared/openfootball.js"));
const { fitRatings, expectedGoals, matchModel } = await import(dist("shared/betting-math.js"));
const trading = await import(dist("providers/trading.js"));

const SEASON = JSON.parse(await readFile(join(__dirname, "fixtures", "openfootball-it1-2024-25.json"), "utf8"));
const SEASON_2526 = JSON.parse(await readFile(join(__dirname, "fixtures", "openfootball-it1-2025-26.json"), "utf8"));

const close = (actual, expected, tolerance, message) =>
  assert.ok(Math.abs(actual - expected) <= tolerance,
    `${message ?? "value"}: expected ~${expected}, got ${actual}`);

describe("real season — parsing and coverage", () => {
  let realFetch;
  before(() => {
    realFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      assert.match(String(url), /openfootball/, "this suite must not reach anywhere else");
      return { ok: true, status: 200, statusText: "OK", headers: new Headers(), json: async () => SEASON, text: async () => JSON.stringify(SEASON) };
    };
  });
  after(() => { globalThis.fetch = realFetch; });

  it("reads the season the way the file actually is", async () => {
    const { played, fixtures, coverage } = await fetchOpenFootballSeason("I1", "2425");
    assert.equal(coverage.total, 380, "a 20-team league plays 380 matches");
    assert.equal(played.length, 370);
    assert.equal(fixtures.length, 10);
    assert.equal(coverage.last_result_date, "2025-05-18");
  });

  it("calls the missing final matchday a hole, not a fixture list", async () => {
    const { coverage } = await fetchOpenFootballSeason("I1", "2426");
    assert.equal(coverage.missing_results, 10, "the whole of matchday 38 is absent");
    assert.equal(coverage.upcoming, 0, "a season that ended in May 2025 has nothing upcoming");
    assert.equal(coverage.missing_examples.length, 5);
    assert.match(coverage.missing_examples[0], /^2025-05-2[34] /);
  });

  it("settles every real result the way the scoreline says", async () => {
    const { played } = await fetchOpenFootballSeason("I1", "2427");
    let home = 0, draw = 0, away = 0, over = 0, goals = 0;
    for (const m of played) {
      const expected = m.homeGoals > m.awayGoals ? "H" : m.homeGoals === m.awayGoals ? "D" : "A";
      assert.equal(m.result, expected, `${m.date} ${m.home} v ${m.away} ${m.homeGoals}-${m.awayGoals}`);
      assert.equal(m.totalGoals, m.homeGoals + m.awayGoals);
      goals += m.totalGoals;
      if (m.result === "H") home++; else if (m.result === "D") draw++; else away++;
      if (m.totalGoals > 2.5) over++;
    }
    // Cross-checked against the independent football-data.co.uk mirror at
    // datasets/football-datasets, which has the 10 matches this source lacks:
    // 151H/108D/121A and 973 goals over the full 380. Across the 370 here:
    assert.deepEqual({ home, draw, away }, { home: 149, draw: 108, away: 113 });
    assert.equal(goals, 942);
    close(home / played.length, 0.40, 0.02, "home-win rate for a real league season");
    close(over / played.length, 0.53, 0.05, "over-2.5 rate");
    close(goals / played.length, 2.55, 0.15, "goals per match");
  });
});

describe("real season — walk-forward forecasting", () => {
  let realFetch;
  const tools = new Map();

  before(() => {
    trading.register({ tool: (name, description, schema, handler) => tools.set(name, handler) });
    realFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      if (String(url).includes("football-data.co.uk")) throw new Error("archive deliberately unavailable in this suite");
      return { ok: true, status: 200, statusText: "OK", headers: new Headers(), json: async () => SEASON, text: async () => JSON.stringify(SEASON) };
    };
  });
  after(() => { globalThis.fetch = realFetch; });

  /** Predict every match from what was known before it, exactly as the tracker does. */
  async function walkForward(minHistory = 6) {
    const { played } = await fetchOpenFootballSeason("I1", "2428");
    const rows = [];
    const counts = new Map();
    const pool = [];
    let maxTsSeen = 0;
    for (const m of played) {
      const ready = (counts.get(m.home) ?? 0) >= minHistory && (counts.get(m.away) ?? 0) >= minHistory;
      if (ready) {
        // The honesty property: nothing in the pool may be later than this match.
        maxTsSeen = Math.max(maxTsSeen, ...pool.map((h) => h.ts));
        assert.ok(maxTsSeen < m.ts || pool.every((h) => h.ts <= m.ts),
          `lookahead: a match on ${m.date} was rated using a later result`);
        const fit = fitRatings(pool, { half_life_days: 240, as_of: m.ts });
        const xg = expectedGoals(fit, m.home, m.away);
        if (xg) {
          const model = matchModel(xg.home, xg.away, { rho: -0.1 });
          rows.push({
            date: m.date, league: "I1", home: m.home, away: m.away,
            prob_home: model.probabilities.home,
            prob_draw: model.probabilities.draw,
            prob_away: model.probabilities.away,
          });
        }
      }
      pool.push({ home: m.home, away: m.away, homeGoals: m.homeGoals, awayGoals: m.awayGoals, ts: m.ts });
      counts.set(m.home, (counts.get(m.home) ?? 0) + 1);
      counts.set(m.away, (counts.get(m.away) ?? 0) + 1);
    }
    return rows;
  }

  it("never rates a match on a result that came after it", async () => {
    const rows = await walkForward();
    assert.ok(rows.length > 250, `expected most of the season to be predictable, got ${rows.length}`);
  });

  it("produces a proper probability distribution for every match", async () => {
    const rows = await walkForward();
    for (const r of rows) {
      const sum = r.prob_home + r.prob_draw + r.prob_away;
      // Output probabilities are rounded to 6dp, so the sum drifts a little.
      close(sum, 1, 1e-5, `${r.date} ${r.home} v ${r.away}`);
      for (const p of [r.prob_home, r.prob_draw, r.prob_away]) {
        assert.ok(p > 0 && p < 1, `probability out of range: ${p}`);
      }
      // A lopsided real fixture (Napoli 2.6 xG v Lecce 0.4) prices the draw
      // near 13%, so the floor is what a broken model would breach, not what a
      // one-sided one does.
      assert.ok(r.prob_draw > 0.10 && r.prob_draw < 0.40, `implausible draw probability ${r.prob_draw}`);
    }
  });

  it("does not systematically lose the draw, which is where Poisson usually fails", async () => {
    const rows = await walkForward();
    const { played } = await fetchOpenFootballSeason("I1", "2431");
    const byKey = new Map(played.map((m) => [`${m.date}|${m.home}|${m.away}`, m.result]));
    const meanPredicted = rows.reduce((a, r) => a + r.prob_draw, 0) / rows.length;
    const actual = rows.filter((r) => byKey.get(`${r.date}|${r.home}|${r.away}`) === "D").length / rows.length;
    close(meanPredicted, actual, 0.04,
      `mean predicted draw ${meanPredicted.toFixed(4)} vs actual draw rate ${actual.toFixed(4)} over ${rows.length} real matches`);
  });

  it("beats the base rates over a full real season, and says so", async () => {
    const rows = await walkForward();
    const result = await tools.get("trading_score_predictions")({ predictions: rows, season: "2428", source: "openfootball", sample: 0 });
    assert.notEqual(result.isError, true, result.content[0].text);
    const r = JSON.parse(result.content[0].text);

    assert.equal(r.scored, rows.length, "every prediction has a result in this fixture");
    assert.equal(r.pending_count, 0);
    // Deterministic: fixed data, no randomness in the model.
    close(r.probability_scores.rps, 0.1905, 0.0005, "RPS");
    close(r.probability_scores.brier, 0.579, 0.0005, "Brier");
    close(r.probability_scores.log_loss, 0.9692, 0.0005, "log loss");
    close(r.accuracy.hit_rate_pct, 54.516, 0.01, "hit rate");
    close(r.benchmarks.base_rates.rps, 0.2283, 0.0005, "base-rate RPS");

    assert.ok(r.probability_scores.rps < r.benchmarks.base_rates.rps,
      `a season's worth of ratings should beat 44/26/30: ${r.probability_scores.rps} vs ${r.benchmarks.base_rates.rps}`);
    assert.equal(r.benchmarks.market, undefined, "no odds in this source, so no market benchmark is invented");
    assert.match(r.verdict, /Record the market odds/, "and the verdict says what is missing");
  });

  it("is roughly calibrated across the season", async () => {
    const rows = await walkForward();
    const r = JSON.parse((await tools.get("trading_score_predictions")({ predictions: rows, season: "2429", source: "openfootball", sample: 0 })).content[0].text);
    const solid = r.calibration.filter((b) => b.predictions >= 60);
    assert.ok(solid.length >= 3, "a full season should fill several buckets");
    for (const b of solid) {
      close(b.actual_pct, b.average_predicted_pct, 8,
        `bucket ${b.predicted_range} (n=${b.predictions}): said ${b.average_predicted_pct}%, happened ${b.actual_pct}%`);
    }
  });

  it("tells a prediction still to come apart from one the source will never settle", async () => {
    // Matchday 38 is in the file as a fixture, but it was played in May 2025.
    const r = JSON.parse((await tools.get("trading_score_predictions")({
      predictions: [
        { date: "2025-05-25", league: "I1", home: "Venezia FC", away: "Juventus FC", prob_home: 0.2, prob_draw: 0.26, prob_away: 0.54 },
        { date: "2025-05-25", league: "I1", home: "Nowhere FC", away: "Nobody United", prob_home: 0.4, prob_draw: 0.3, prob_away: 0.3 },
      ],
      season: "2430", source: "openfootball",
    })).content[0].text);
    assert.equal(r.scored, 0);
    assert.equal(r.pending_count, 2);
    assert.match(r.pending[0].status, /never recorded a result/, "a hole in the source is named as a hole");
    assert.match(r.pending[1].status, /not in the source at all/);
  });
});

describe("real season — the mirror's two score shapes", () => {
  let realFetch;
  before(() => {
    realFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true, status: 200, statusText: "OK", headers: new Headers(),
      json: async () => SEASON_2526, text: async () => JSON.stringify(SEASON_2526),
    });
  });
  after(() => { globalThis.fetch = realFetch; });

  it("the fixture really does carry both shapes — otherwise this suite proves nothing", () => {
    const shapes = SEASON_2526.matches.reduce((acc, m) => {
      const key = m.score === undefined ? "absent" : Array.isArray(m.score) ? "array" : "object";
      acc[key] = (acc[key] ?? 0) + 1;
      return acc;
    }, {});
    assert.deepEqual(shapes, { object: 344, array: 36 });
    const bare = SEASON_2526.matches.filter((m) => Array.isArray(m.score));
    assert.ok(bare.every((m) => m.score[0] === 0 && m.score[1] === 0),
      "in this file the bare-array form is used for goalless matches only");
  });

  it("reads every match of the season, in either shape", async () => {
    const { played, fixtures, coverage } = await fetchOpenFootballSeason("I1", "2525");
    assert.equal(played.length, 380, "reading only score.ft dropped 36 matches here");
    assert.equal(fixtures.length, 0);
    assert.equal(coverage.missing_results, 0, "a finished season has no holes once both shapes are read");
  });

  it("keeps the goalless draws that the bare-array form hides", async () => {
    const { played } = await fetchOpenFootballSeason("I1", "2524");
    const goalless = played.filter((m) => m.homeGoals === 0 && m.awayGoals === 0);
    assert.equal(goalless.length, 36);
    assert.ok(goalless.every((m) => m.result === "D" && m.totalGoals === 0));
  });

  it("agrees exactly with the independent mirror of the same season", async () => {
    // datasets/football-datasets (derived from football-data.co.uk) reports
    // 380 matches, 148H/99D/133A and 922 goals for Serie A 2025-26.
    // `npm run verify:sources` re-runs this against both live sources.
    const { played } = await fetchOpenFootballSeason("I1", "2523");
    const tally = played.reduce((acc, m) => ({ ...acc, [m.result]: (acc[m.result] ?? 0) + 1 }), {});
    assert.deepEqual(tally, { H: 148, D: 99, A: 133 });
    assert.equal(played.reduce((n, m) => n + m.totalGoals, 0), 922);
  });

  it("drops a score it cannot trust rather than inventing one", async () => {
    const broken = {
      matches: [
        { date: "2025-08-23", team1: "A", team2: "B", score: [1] },
        { date: "2025-08-23", team1: "C", team2: "D", score: [1, "2"] },
        { date: "2025-08-23", team1: "E", team2: "F", score: { ht: [0, 0] } },
        { date: "2025-08-23", team1: "G", team2: "H", score: { ft: [2, 1] } },
        { date: "2025-08-23", team1: "I", team2: "J", score: [0, 0] },
      ],
    };
    const saved = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: true, status: 200, statusText: "OK", headers: new Headers(), json: async () => broken, text: async () => JSON.stringify(broken) });
    try {
      const { played, fixtures } = await fetchOpenFootballSeason("I1", "2522");
      assert.equal(played.length, 2, "only the two well-formed scores count as played");
      assert.deepEqual(played.map((m) => `${m.homeGoals}-${m.awayGoals}`).sort(), ["0-0", "2-1"]);
      assert.equal(fixtures.length, 3, "the malformed ones stay unplayed rather than being guessed at");
    } finally {
      globalThis.fetch = saved;
    }
  });
});
