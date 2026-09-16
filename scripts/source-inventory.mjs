#!/usr/bin/env node
/**
 * What can this machine actually reach, and what does it get when it does?
 *
 *   npm run inventory [-- --json out.json] [--timeout 8000] [--only espn,nhl]
 *
 * Before deciding what a collector should gather, find out what is gatherable.
 * Every provider is probed on one cheap endpoint and classified:
 *
 *   LIVE       200 and a parseable body — usable now, no key
 *   NEEDS_KEY  the host answered, and said no without credentials. Reachable:
 *              the difference between this and BLOCKED is the whole point of
 *              the exercise, because one is solved with a free signup and the
 *              other cannot be solved at all from here.
 *   PARTIAL    200, but not the shape the provider expects
 *   BLOCKED    never reached the host: DNS, TLS, egress policy, or timeout
 *   ERROR      reached it and got something unusable
 *
 * It writes nothing but a report. Deciding what to do about a BLOCKED source is
 * not this script's job.
 */

import { writeFileSync } from "node:fs";

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d; };
const TIMEOUT = Number(flag("timeout", 8000));
const only = flag("only", null)?.split(",").map((s) => s.trim());

/** One cheap, side-effect-free endpoint per provider. */
const SOURCES = [
  // --- no key, the ones a collector can lean on ---
  { prefix: "espn", name: "ESPN (unofficial)", key: null, use: "fixtures,results", url: "https://site.api.espn.com/apis/site/v2/sports/soccer/ita.1/scoreboard" },
  { prefix: "nhl", name: "NHL Web API", key: null, use: "results", url: "https://api-web.nhle.com/v1/standings/now" },
  { prefix: "mlb", name: "MLB Stats API", key: null, use: "results", url: "https://statsapi.mlb.com/api/v1/teams?sportId=1" },
  { prefix: "f1", name: "Jolpica F1", key: null, use: "results", url: "https://api.jolpi.ca/ergast/f1/2024/1/results.json" },
  { prefix: "openf1", name: "OpenF1", key: null, use: "telemetry", url: "https://api.openf1.org/v1/sessions?year=2024&session_name=Race" },
  { prefix: "openliga", name: "OpenLigaDB", key: null, use: "fixtures,results", url: "https://api.openligadb.de/getavailableleagues" },
  { prefix: "sportsdb", name: "TheSportsDB", key: "test key 3", use: "identity", url: "https://www.thesportsdb.com/api/v1/json/3/search_all_teams.php?l=Italian%20Serie%20A" },
  { prefix: "ncaa", name: "NCAA API", key: null, use: "results", url: "https://ncaa-api.henrygd.me/scoreboard/football/fbs" },
  { prefix: "sportsrc", name: "SportSRC", key: null, use: "fixtures,live", url: "https://api.sportsrc.org/v1/football/matches" },
  { prefix: "lichess", name: "Lichess", key: null, use: "chess", url: "https://lichess.org/api/puzzle/daily" },
  { prefix: "chesscom", name: "Chess.com", key: null, use: "chess", url: "https://api.chess.com/pub/titled/GM" },
  { prefix: "squiggle", name: "Squiggle (AFL)", key: null, use: "fixtures,results", url: "https://api.squiggle.com.au/?q=teams" },
  { prefix: "motogp", name: "MotoGP (unofficial)", key: null, use: "results", url: "https://api.motogp.pulselive.com/motogp/v1/results/seasons" },
  { prefix: "formulae", name: "Formula E (unofficial)", key: null, use: "results", url: "https://api.formula-e.pulselive.com/formula-e/v1/championships" },
  { prefix: "nascar", name: "NASCAR (unofficial)", key: null, use: "results", url: "https://cf.nascar.com/cacher/2024/1/race_list_basic.json" },
  { prefix: "opendota", name: "OpenDota", key: null, use: "esports", url: "https://api.opendota.com/api/proMatches" },
  { prefix: "sleeper", name: "Sleeper", key: null, use: "nfl-fantasy", url: "https://api.sleeper.app/v1/state/nfl" },
  { prefix: "euroleague", name: "EuroLeague", key: null, use: "results", url: "https://api-live.euroleague.net/v1/results?seasonCode=E2024&gameNumber=1" },
  { prefix: "polymarket", name: "Polymarket Gamma", key: null, use: "ODDS (second venue)", url: "https://gamma-api.polymarket.com/markets?limit=1" },
  { prefix: "polymarket-clob", name: "Polymarket CLOB", key: null, use: "ODDS depth", url: "https://clob.polymarket.com/markets" },

  // --- the archives a collector backfills from ---
  { prefix: "footballdata_uk", name: "Football-Data.co.uk (origin)", key: null, use: "ODDS open+close", url: "https://www.football-data.co.uk/mmz4281/2425/E0.csv" },
  { prefix: "fd-mirror", name: "football-data GitHub mirror", key: null, use: "ODDS avg+max", url: "https://raw.githubusercontent.com/datasets/football-datasets/main/datasets/premier-league/season-2425.csv" },
  { prefix: "openfootball", name: "openfootball/football.json", key: null, use: "fixtures,results", url: "https://raw.githubusercontent.com/openfootball/football.json/master/2024-25/en.1.json" },
  { prefix: "cfmd-matches", name: "Club-Football-Match-Data (matches)", key: null, use: "ODDS avg+max, 38 divisions", url: "https://raw.githubusercontent.com/xgabora/Club-Football-Match-Data-2000-2025/main/data/Matches.csv" },
  { prefix: "cfmd-elo", name: "Club-Football-Match-Data (Elo)", key: null, use: "strength time series", url: "https://raw.githubusercontent.com/xgabora/Club-Football-Match-Data-2000-2025/main/data/EloRatings.csv" },
  { prefix: "fdcache", name: "footballcsv/cache.footballdata", key: null, use: "results only (odds stripped)", url: "https://raw.githubusercontent.com/footballcsv/cache.footballdata/master/2023-24/eng.1.csv" },
  { prefix: "clubelo", name: "ClubElo", key: null, use: "ratings", url: "http://api.clubelo.com/2024-08-15" },

  // --- key required: reachability is still worth knowing ---
  { prefix: "odds", name: "The Odds API", key: "THE_ODDS_API_KEY", use: "ODDS live", url: "https://api.the-odds-api.com/v4/sports/?apiKey=probe" },
  { prefix: "oddsio", name: "Odds-API.io", key: "ODDS_API_IO_KEY", use: "ODDS live", url: "https://api.odds-api.io/v1/sports?apikey=probe" },
  { prefix: "sgo", name: "Sports Game Odds", key: "SPORTS_GAME_ODDS_KEY", use: "ODDS live", url: "https://api.sportsgameodds.com/v2/sports" },
  { prefix: "apifootball", name: "API-Football", key: "API_FOOTBALL_KEY", use: "fixtures,odds", url: "https://v3.football.api-sports.io/status" },
  { prefix: "footballdata", name: "football-data.org", key: "FOOTBALL_DATA_API_KEY", use: "fixtures,results", url: "https://api.football-data.org/v4/competitions" },
  { prefix: "sportmonks", name: "Sportmonks", key: "SPORTMONKS_API_KEY", use: "fixtures,odds", url: "https://api.sportmonks.com/v3/football/leagues" },
  { prefix: "bdl", name: "BallDontLie", key: "BALLDONTLIE_API_KEY", use: "us-sports", url: "https://api.balldontlie.io/v1/teams" },
  { prefix: "pandascore", name: "PandaScore", key: "PANDASCORE_TOKEN", use: "esports", url: "https://api.pandascore.co/leagues" },
  { prefix: "cfbd", name: "College Football Data", key: "CFBD_API_KEY", use: "ncaa", url: "https://apinext.collegefootballdata.com/teams" },
  { prefix: "highlightly", name: "Highlightly", key: "HIGHLIGHTLY_API_KEY", use: "odds,highlights", url: "https://sports.highlightly.net/football/leagues?limit=1" },
];

const list = only ? SOURCES.filter((s) => only.includes(s.prefix)) : SOURCES;

/**
 * An egress proxy can answer 403 to the CONNECT itself, and that arrives here
 * looking exactly like an API saying "no key". The difference decides whether a
 * source is a free signup away or unreachable from this machine at all, so it
 * is worth detecting properly rather than guessing from the status code.
 */
const BLOCKED_BODY = /host not in allowlist|not in the allowlist|egress|connect tunnel failed|proxy denied/i;

function proxyBlocked(res, body) {
  if (res.status !== 403) return false;
  const type = res.headers.get("content-type") ?? "";
  return type.startsWith("text/plain") && BLOCKED_BODY.test(body);
}

/** A proxy or DNS failure never reaches the host; an auth rejection does. */
function classifyError(err) {
  const msg = `${err?.cause?.message ?? ""} ${err?.message ?? ""}`.toLowerCase();
  if (msg.includes("timeout") || err?.name === "AbortError") return ["BLOCKED", "timed out"];
  if (msg.includes("enotfound") || msg.includes("eai_again") || msg.includes("dns")) return ["BLOCKED", "DNS did not resolve"];
  if (msg.includes("403") || msg.includes("tunnel") || msg.includes("proxy")) return ["BLOCKED", "proxy refused CONNECT (network policy)"];
  if (msg.includes("certificate") || msg.includes("tls") || msg.includes("ssl")) return ["BLOCKED", "TLS failure"];
  if (msg.includes("econnrefused") || msg.includes("econnreset")) return ["BLOCKED", "connection refused or reset"];
  return ["ERROR", (err?.message ?? "unknown").slice(0, 80)];
}

async function probe(src) {
  const started = Date.now();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT);
  try {
    const res = await fetch(src.url, { signal: ctl.signal, headers: { "user-agent": "mcp-sports-hub source inventory" } });
    const ms = Date.now() - started;
    const body = (await res.text()).slice(0, 4000);
    if (proxyBlocked(res, body)) {
      const host = new URL(src.url).host;
      return { ...src, status: "BLOCKED", http: 403, ms,
        detail: `${host} is not in this environment's egress allowlist — add it to the network settings, no key will help` };
    }
    if (res.status === 401 || res.status === 403 || res.status === 429) {
      return { ...src, status: src.key ? "NEEDS_KEY" : "ERROR", http: res.status, ms,
        detail: src.key ? `host answered ${res.status} without credentials — reachable, set ${src.key}` : `host answered ${res.status} although no key should be needed` };
    }
    if (!res.ok) return { ...src, status: "ERROR", http: res.status, ms, detail: `HTTP ${res.status}` };
    const looksJson = body.trimStart().startsWith("{") || body.trimStart().startsWith("[");
    const looksCsv = /^[A-Za-z_,"' ]+\r?\n/.test(body) && body.includes(",");
    if (!looksJson && !looksCsv) return { ...src, status: "PARTIAL", http: res.status, ms, detail: `200 but body is neither JSON nor CSV (${body.slice(0, 40).replace(/\s+/g, " ")}…)` };
    if (looksJson) { try { JSON.parse(body); } catch { /* truncated at 4k, fine */ } }
    return { ...src, status: "LIVE", http: res.status, ms, detail: `${looksJson ? "JSON" : "CSV"}, ${body.length >= 4000 ? "4k+" : `${body.length}b`}` };
  } catch (err) {
    const [status, detail] = classifyError(err);
    return { ...src, status, http: null, ms: Date.now() - started, detail };
  } finally {
    clearTimeout(timer);
  }
}

const results = [];
for (let i = 0; i < list.length; i += 6) {
  results.push(...await Promise.all(list.slice(i, i + 6).map(probe)));
}

const ORDER = { LIVE: 0, NEEDS_KEY: 1, PARTIAL: 2, ERROR: 3, BLOCKED: 4 };
results.sort((a, b) => ORDER[a.status] - ORDER[b.status] || a.prefix.localeCompare(b.prefix));

const counts = results.reduce((m, r) => ({ ...m, [r.status]: (m[r.status] ?? 0) + 1 }), {});
console.log(`Probed ${results.length} sources, ${TIMEOUT}ms timeout\n`);
console.log("STATUS      PREFIX             USE                     ms    DETAIL");
console.log("-".repeat(110));
for (const r of results) {
  console.log(`${r.status.padEnd(11)} ${r.prefix.padEnd(18)} ${(r.use ?? "").padEnd(23)} ${String(r.ms).padStart(5)}  ${r.detail}`);
}
console.log("\n" + Object.entries(counts).map(([k, v]) => `${k} ${v}`).join("   "));

const odds = results.filter((r) => (r.use ?? "").toUpperCase().includes("ODDS"));
const oddsLive = odds.filter((r) => r.status === "LIVE");
console.log(`\nOdds sources: ${oddsLive.length} of ${odds.length} usable from here without a key.`);
const blocked = results.filter((r) => r.status === "BLOCKED");
if (blocked.length) {
  console.log(`\n${blocked.length} sources are blocked by network policy, not by anything you can fix with a key:`);
  console.log("  " + [...new Set(blocked.map((r) => new URL(r.url).host))].join("\n  "));
  console.log("\nThey are reachable from an ordinary machine. Run this script there, or add the hosts to the environment's egress allowlist.");
}
if (oddsLive.length === 0) {
  console.log("None. A collector on this machine can gather fixtures and results but cannot snapshot prices,");
  console.log("which is the one series the research programme actually needs. Run this where the odds hosts are reachable.");
}

const out = flag("json", null);
if (out) { writeFileSync(out, JSON.stringify({ probed_at: new Date().toISOString(), counts, results }, null, 2) + "\n"); console.log(`\nWrote ${out}`); }
