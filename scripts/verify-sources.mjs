#!/usr/bin/env node
/**
 * Verify the live data sources still look the way the code expects.
 *
 * The offline suite proves the code is correct against data it already has.
 * This proves the data is still there and still shaped that way — the failure
 * mode no unit test can catch, because it happens upstream, on someone else's
 * server, after you shipped.
 *
 *   npm run verify:sources
 *
 * FAIL means real drift: a source answered, but not in the shape the code
 * parses. SKIP means the host could not be reached from here (blocked egress,
 * outage) — an environment fact, not a defect, so it does not fail the run.
 * WARN means the data is reachable and parseable but incomplete or
 * inconsistent, which is worth knowing before you trust a number from it.
 */

import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = (p) => join(root, "dist", p);
const { fetchOpenFootballSeason, OF_LEAGUES, seasonPath } = await import(dist("shared/openfootball.js"));
const { parseCsv, priceFor, toFixtures, toMatches, FD_BASE, FD_FIXTURES_PATH } = await import(dist("shared/football-csv.js"));

const results = [];
const record = (status, name, detail) => {
  results.push({ status, name, detail });
  const mark = { PASS: "  ok  ", FAIL: " FAIL ", SKIP: " skip ", WARN: " warn " }[status];
  console.log(`[${mark}] ${name}${detail ? ` — ${detail}` : ""}`);
};

async function check(name, fn) {
  try {
    const detail = await fn();
    record("PASS", name, detail);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // A blocked or down host is an environment fact, not drift in our parsing.
    if (/403|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|not in allowlist|fetch failed|socket hang up/i.test(message)) {
      record("SKIP", name, `unreachable: ${message.slice(0, 110)}`);
    } else {
      record("FAIL", name, message.slice(0, 300));
    }
  }
}

const currentSeason = () => {
  const now = new Date();
  const start = now.getUTCMonth() >= 6 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
  const two = (y) => String(y % 100).padStart(2, "0");
  return `${two(start)}${two(start + 1)}`;
};
const season = process.argv.includes("--season")
  ? process.argv[process.argv.indexOf("--season") + 1]
  : currentSeason();
const previous = `${String((Number(season.slice(0, 2)) + 99) % 100).padStart(2, "0")}${season.slice(0, 2)}`;

console.log(`Verifying sources for season ${season} (previous ${previous})\n`);

// ---------------------------------------------------------------------------
// openfootball — the keyless fallback
// ---------------------------------------------------------------------------

console.log("openfootball/football.json");

if (seasonPath(season) !== `20${season.slice(0, 2)}-${season.slice(2)}`) {
  record("FAIL", "season path mapping", `seasonPath("${season}") = ${seasonPath(season)}`);
} else {
  record("PASS", "season path mapping", `${season} -> ${seasonPath(season)}`);
}

for (const league of ["I1", "E0"]) {
  await check(`${league} ${season} (${OF_LEAGUES[league].key})`, async () => {
    const { played, fixtures, coverage } = await fetchOpenFootballSeason(league, season);
    if (played.length + fixtures.length === 0) throw new Error("season file parsed to zero matches — shape changed?");
    for (const m of played.slice(0, 5)) {
      if (!m.home || !m.away) throw new Error("a played match is missing a team name");
      if (!Number.isInteger(m.homeGoals) || !Number.isInteger(m.awayGoals)) throw new Error("a played match has non-integer goals");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(m.date)) throw new Error(`unexpected date format: ${m.date}`);
      if (!["H", "D", "A"].includes(m.result)) throw new Error(`unexpected result: ${m.result}`);
    }
    const detail = `${coverage.total} fixtures, ${coverage.played} played, ${coverage.upcoming} upcoming, last result ${coverage.last_result_date ?? "none"}`;
    if (coverage.missing_results > 0) {
      record("WARN", `${league} ${season} coverage`,
        `${coverage.missing_results} match(es) played but never recorded, e.g. ${coverage.missing_examples[0]}`);
    }
    return detail;
  });
}

await check(`${previous} history available for ratings`, async () => {
  const { played, coverage } = await fetchOpenFootballSeason("I1", previous);
  if (played.length < 100) throw new Error(`only ${played.length} matches — too thin to rate a league on`);
  if (coverage.missing_results > 0) {
    record("WARN", `I1 ${previous} coverage`, `${coverage.missing_results} result(s) missing from a finished season`);
  }
  return `${played.length} played matches`;
});

// ---------------------------------------------------------------------------
// football-data.co.uk — the source with odds
// ---------------------------------------------------------------------------

console.log("\nfootball-data.co.uk");

await check("upcoming fixtures file", async () => {
  const { fetchFixtures } = await import(dist("shared/football-csv.js"));
  const rows = await fetchFixtures();
  if (rows.length === 0) throw new Error("fixtures.csv is empty (normal during a break, suspicious otherwise)");
  const fixtures = toFixtures(rows, "avg");
  const priced = fixtures.filter((f) => f.prices.H && f.prices.D && f.prices.A);
  if (fixtures.length && priced.length === 0) throw new Error("no fixture carries a 1X2 price — odds columns renamed?");
  return `${rows.length} rows, ${fixtures.length} fixtures, ${priced.length} priced`;
});

await check("season archive + odds columns", async () => {
  const { fetchLeagueSeason } = await import(dist("shared/football-csv.js"));
  const rows = await fetchLeagueSeason("E0", season);
  if (rows.length === 0) throw new Error("season CSV parsed to zero rows");
  const matches = toMatches(rows, "E0", season, "avg");
  if (matches.length === 0) throw new Error("no completed matches parsed — column names changed?");
  const withOpen = matches.filter((m) => m.prices.open.H).length;
  const withClose = matches.filter((m) => m.prices.close.H).length;
  if (withOpen === 0) throw new Error("not one opening price parsed — the odds columns moved");
  const sample = rows[0];
  const book = priceFor(sample, "open", "avg", "H");
  return `${matches.length} matches, ${withOpen} with opening odds, ${withClose} with closing odds, first price from "${book?.book}"`;
});

// ---------------------------------------------------------------------------
// Polymarket — written from the documented API shape, never called from the
// session that wrote it. This check is the one that would catch that.
// ---------------------------------------------------------------------------

console.log("\npolymarket");

await check("markets endpoint and field mapping", async () => {
  const polymarket = await import(dist("providers/polymarket.js"));
  const tools = new Map();
  polymarket.register({ tool: (name, description, schema, handler) => tools.set(name, handler) });
  const result = await tools.get("polymarket_get_markets")({ limit: 5 });
  if (result.isError) throw new Error(result.content[0].text.replace(/^Error: /, ""));
  const data = JSON.parse(result.content[0].text);
  if (!Array.isArray(data.markets)) throw new Error("no markets array — response shape changed");
  if (data.markets.length === 0) throw new Error("zero markets returned; the filter or the endpoint has moved");
  const priced = data.markets.filter((m) => m.outcomes.some((o) => o.probability !== undefined));
  if (priced.length === 0) throw new Error("no market carried a price — outcomePrices is no longer where it was");
  const withTokens = data.markets.filter((m) => m.outcomes.some((o) => o.token_id));
  return `${data.markets.length} markets, ${priced.length} priced, ${withTokens.length} with token ids`;
});

// ---------------------------------------------------------------------------
// Cross-source agreement — the check neither source can do alone
// ---------------------------------------------------------------------------

console.log("\ncross-source agreement");

const MIRROR = "https://raw.githubusercontent.com/datasets/football-datasets/main/datasets";
const MIRROR_LEAGUES = { I1: "serie-a", E0: "premier-league", SP1: "la-liga", D1: "bundesliga", F1: "ligue-1" };

await check(`I1 ${previous}: openfootball vs datasets/football-datasets`, async () => {
  const response = await fetch(`${MIRROR}/${MIRROR_LEAGUES.I1}/season-${previous}.csv`);
  if (!response.ok) throw new Error(`mirror responded ${response.status}`);
  const rows = parseCsv(await response.text());
  const mirror = rows.filter((r) => r.FTR);
  const { played } = await fetchOpenFootballSeason("I1", previous);

  const tally = (list, get) => list.reduce((acc, r) => {
    const key = get(r);
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});
  const a = tally(played, (m) => m.result);
  const b = tally(mirror, (r) => r.FTR);
  const goalsA = played.reduce((n, m) => n + m.totalGoals, 0);
  const goalsB = mirror.reduce((n, r) => n + Number(r.FTHG) + Number(r.FTAG), 0);

  if (played.length !== mirror.length) {
    record("WARN", "match counts differ",
      `openfootball ${played.length} vs mirror ${mirror.length} — the mirror is the more complete of the two`);
    return `H/D/A ${a.H}/${a.D}/${a.A} vs ${b.H}/${b.D}/${b.A}, goals ${goalsA} vs ${goalsB} (on different match counts)`;
  }
  if (a.H !== b.H || a.D !== b.D || a.A !== b.A || goalsA !== goalsB) {
    throw new Error(`same match count but different results: H/D/A ${a.H}/${a.D}/${a.A} vs ${b.H}/${b.D}/${b.A}, goals ${goalsA} vs ${goalsB}`);
  }
  return `identical on ${played.length} matches: H/D/A ${a.H}/${a.D}/${a.A}, ${goalsA} goals`;
});

// ---------------------------------------------------------------------------

const counts = results.reduce((acc, r) => ({ ...acc, [r.status]: (acc[r.status] ?? 0) + 1 }), {});
console.log(`\n${counts.PASS ?? 0} passed, ${counts.WARN ?? 0} warnings, ${counts.SKIP ?? 0} skipped, ${counts.FAIL ?? 0} failed`);
if (counts.FAIL) {
  console.log("\nA FAIL means a source answered in a shape this code does not parse. Fix the parser or pin the source.");
  process.exit(1);
}
if (counts.SKIP) console.log("Skipped checks could not reach their host from here — rerun where the network allows it.");
