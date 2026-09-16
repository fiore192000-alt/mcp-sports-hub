#!/usr/bin/env node
/**
 * Collector v1 — deliberately stupid.
 *
 *   npm run collect -- backfill [--leagues E0,I1] [--seasons 2425,2526]
 *   npm run collect -- closing  [--leagues E0,SP1,I1,D1,F1] [--seasons 1920,..,2526]
 *   npm run collect -- snapshot [--leagues E0,I1]
 *   npm run collect -- status
 *
 * It records what a price WAS at a moment. It does not decide whether that
 * price is interesting, does not compute an edge, does not de-vig, does not
 * rank anything. Every judgement an agent makes on the way in is a judgement
 * that cannot later be re-made differently, and the whole value of the archive
 * is that it can be re-read by a question nobody has asked yet.
 *
 * Append-only NDJSON under data/collected/, one file per stream per UTC day.
 * Never rewrites a line. NDJSON rather than Parquet because appending is the
 * only write this thing does and it needs no dependency to do it — DuckDB reads
 * it directly:
 *
 *   SELECT * FROM read_json_auto('data/collected/odds/*.ndjson');
 *
 * A failed collection is written too, to collection_log. A gap you cannot see
 * is a gap you will silently treat as an absence of events.
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = () => process.env.SPORTS_HUB_COLLECT_DIR ?? join(root, "data", "collected");

const argv = process.argv.slice(2);
const cmd = argv[0];
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d; };
const list = (s) => s.split(",").map((x) => x.trim()).filter(Boolean);

const day = (iso) => iso.slice(0, 10);

/** Append-only. One file per stream per UTC day, never reopened for rewrite. */
export function write(stream, rows) {
  if (rows.length === 0) return 0;
  const dir = join(outDir(), stream);
  mkdirSync(dir, { recursive: true });
  const byDay = new Map();
  for (const r of rows) {
    const d = day(r.observed_at ?? new Date().toISOString());
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d).push(JSON.stringify(r));
  }
  for (const [d, lines] of byDay) appendFileSync(join(dir, `${d}.ndjson`), lines.join("\n") + "\n");
  return rows.length;
}

function logCollection(entry) {
  write("collection_log", [{ observed_at: new Date().toISOString(), ...entry }]);
}

/**
 * A stable id for a fixture, so two sources that spell a team differently still
 * land on the same row. Deliberately built from things that do not change:
 * competition, kickoff date, and the two team names reduced to a slug.
 */
export function matchId(league, dateIso, home, away) {
  return `${league}-${day(dateIso)}-${teamSlug(home)}-${teamSlug(away)}`;
}

/**
 * Letters NFD will not decompose, because they are letters in their own right
 * rather than a base plus a diacritic. Without this, stripping non-ASCII turns
 * Bodo/Glimt and Bodoe/Glimt into different clubs — the identity bug that
 * quietly corrupts every join downstream.
 */
const TRANSLITERATE = {
  "\u00f8": "o", "\u00d8": "o", "\u00e6": "ae", "\u00c6": "ae", "\u0153": "oe", "\u0152": "oe",
  "\u00e5": "a", "\u00c5": "a", "\u0142": "l", "\u0141": "l", "\u0111": "d", "\u0110": "d",
  "\u00f0": "d", "\u00d0": "d", "\u00fe": "th", "\u00de": "th", "\u00df": "ss",
  "\u0131": "i", "\u0130": "i",
};

export function teamSlug(name) {
  return String(name ?? "")
    .replace(/[\u00f8\u00d8\u00e6\u00c6\u0153\u0152\u00e5\u00c5\u0142\u0141\u0111\u0110\u00f0\u00d0\u00fe\u00de\u00df\u0131\u0130]/g,
             (c) => TRANSLITERATE[c] ?? c)
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toUpperCase().replace(/[^A-Z0-9]/g, "")
    .slice(0, 6) || "UNK";
}


async function getText(url) {
  const res = await fetch(url, { headers: { "user-agent": "mcp-sports-hub collector" } });
  const body = await res.text();
  if (!res.ok) {
    const blocked = res.status === 403 && /not in allowlist|egress/i.test(body);
    throw new Error(blocked
      ? `${new URL(url).host} is not in this environment's egress allowlist`
      : `HTTP ${res.status} from ${new URL(url).host}`);
  }
  return body;
}

export function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const hdr = lines[0].split(",").map((h) => h.trim());
  return lines.slice(1).map((l) => {
    const c = l.split(",");
    const o = {};
    hdr.forEach((h, i) => (o[h] = (c[i] ?? "").trim()));
    return o;
  });
}

const MIRROR_BASE = "https://raw.githubusercontent.com/xgabora/Club-Football-Match-Data-2000-2025/main/data";
const ODDS_MIRROR = `${MIRROR_BASE}/Matches.csv`;
const ELO_MIRROR = `${MIRROR_BASE}/EloRatings.csv`;

/**
 * A GitHub mirror of football-data.co.uk's own CSVs, kept whole. Unlike every
 * other free source found, it preserves the CLOSING columns — so the opening
 * and closing price of the same match are both available without reaching the
 * origin host, which this environment blocks.
 *
 * Verified rather than trusted: its 2023-24 Premier League file matches a copy
 * downloaded from football-data.co.uk directly on 380 of 380 fixtures, with
 * zero differing cells across 4,560 closing-odds values and identical
 * full-time scores throughout. Row counts also reproduce the real anomalies —
 * Ligue 1 truncated to 279 in 2019-20 by the pandemic, and 306 once it and the
 * Bundesliga settled at eighteen clubs.
 */
const CLOSING_MIRROR = "https://raw.githubusercontent.com/huhao930422-debug/football-odds-mirror/main/data";

/** Only these five are mirrored, and only from 2019-20 do closing columns exist. */
export const CLOSING_LEAGUES = { E0: "premier-league", SP1: "la-liga", I1: "serie-a", D1: "bundesliga", F1: "ligue-1" };

/** [venue, market, selection, opening column, closing column] */
export const CLOSING_COLUMNS = [
  ["bet365", "1X2", "HOME", "B365H", "B365CH"], ["bet365", "1X2", "DRAW", "B365D", "B365CD"], ["bet365", "1X2", "AWAY", "B365A", "B365CA"],
  ["pinnacle", "1X2", "HOME", "PSH", "PSCH"], ["pinnacle", "1X2", "DRAW", "PSD", "PSCD"], ["pinnacle", "1X2", "AWAY", "PSA", "PSCA"],
  ["best_of_panel", "1X2", "HOME", "MaxH", "MaxCH"], ["best_of_panel", "1X2", "DRAW", "MaxD", "MaxCD"], ["best_of_panel", "1X2", "AWAY", "MaxA", "MaxCA"],
  ["market_average", "1X2", "HOME", "AvgH", "AvgCH"], ["market_average", "1X2", "DRAW", "AvgD", "AvgCD"], ["market_average", "1X2", "AWAY", "AvgA", "AvgCA"],
  ["bet365", "OU25", "OVER", "B365>2.5", "B365C>2.5"], ["bet365", "OU25", "UNDER", "B365<2.5", "B365C<2.5"],
  ["pinnacle", "OU25", "OVER", "P>2.5", "PC>2.5"], ["pinnacle", "OU25", "UNDER", "P<2.5", "PC<2.5"],
  ["best_of_panel", "OU25", "OVER", "Max>2.5", "MaxC>2.5"], ["best_of_panel", "OU25", "UNDER", "Max<2.5", "MaxC<2.5"],
  ["market_average", "OU25", "OVER", "Avg>2.5", "AvgC>2.5"], ["market_average", "OU25", "UNDER", "Avg<2.5", "AvgC<2.5"],
];

const fdDate = (s) => {
  const m = /^(\d{2})\/(\d{2})\/(\d{2,4})$/.exec(s ?? "");
  if (!m) return null;
  return `${m[3].length === 2 ? `20${m[3]}` : m[3]}-${m[2]}-${m[1]}`;
};

/**
 * The one stream that makes closing-line value measurable without waiting for a
 * live snapshotter: every price twice, once as posted and once at the off.
 *
 * `phase` carries the distinction, and `price_taken_at` stays null for both —
 * the archive says WHICH price it is, never WHEN it was taken.
 */
async function closing(leagues, seasons) {
  const now = new Date().toISOString();
  const rows = [], results = [];
  let missingCols = new Set();
  for (const league of leagues) {
    const path = CLOSING_LEAGUES[league];
    if (!path) { console.log(`  ${league}: not in this mirror (it carries ${Object.keys(CLOSING_LEAGUES).join(", ")})`); continue; }
    for (const season of seasons) {
      const url = `${CLOSING_MIRROR}/${path}/season-${season}.csv`;
      try {
        const parsed = parseCsv(await getText(url));
        if (parsed.length === 0) throw new Error("empty file");
        let n = 0, prices = 0;
        for (const r of parsed) {
          const date = fdDate(r.Date);
          if (!date || !r.HomeTeam || !r.AwayTeam) continue;
          const id = matchId(league, date, r.HomeTeam, r.AwayTeam);
          n++;
          for (const [venue, market, selection, openCol, closeCol] of CLOSING_COLUMNS) {
            if (!(openCol in r)) missingCols.add(openCol);
            if (!(closeCol in r)) missingCols.add(closeCol);
            for (const [phase, col] of [["open", openCol], ["close", closeCol]]) {
              const price = Number(r[col]);
              if (!Number.isFinite(price) || price <= 1) continue;
              rows.push({
                match_id: id, league, season, kickoff_date: date, home: r.HomeTeam, away: r.AwayTeam,
                source: "football-data-mirror", venue, market, selection, price,
                available_stake: null, price_taken_at: null, observed_at: now, phase,
              });
              prices++;
            }
          }
          if (r.FTHG !== "" && r.FTAG !== "") {
            results.push({
              match_id: id, league, season, kickoff_date: date, home: r.HomeTeam, away: r.AwayTeam,
              ft_home: Number(r.FTHG), ft_away: Number(r.FTAG),
              ht_home: r.HTHG === "" ? null : Number(r.HTHG), ht_away: r.HTAG === "" ? null : Number(r.HTAG),
              result: r.FTR || null, source: "football-data-mirror", observed_at: now,
            });
          }
        }
        console.log(`  ${league} ${season}: ${n} matches, ${prices} prices`);
        logCollection({ stream: "closing", league, season, status: "ok", matches: n, prices });
      } catch (err) {
        console.log(`  ${league} ${season}: FAILED — ${err.message}`);
        logCollection({ stream: "closing", league, season, status: "failed", error: err.message });
      }
    }
  }
  write("odds", rows);
  write("results", results);
  const opens = rows.filter((r) => r.phase === "open").length;
  console.log(`\n${rows.length} price observations (${opens} open, ${rows.length - opens} close), ${results.length} results.`);
  if (missingCols.size) console.log(`Columns absent from some seasons (older files are narrower): ${[...missingCols].sort().join(", ")}`);
  console.log("Both phases carry price_taken_at: null — the archive says which price it is, never when it was taken.");
}



/** Season code 2425 -> the Aug..May window it covers. */
export function seasonWindow(code) {
  const a = 2000 + Number(code.slice(0, 2));
  const b = 2000 + Number(code.slice(2, 4));
  return [`${a}-07-01`, `${b}-06-30`];
}

/**
 * Historical backfill from the keyless mirror of football-data.co.uk.
 *
 * One observation per price column. Every row carries `price_taken_at: null`
 * because the archive does not record when the price was taken — recording that
 * absence is the point. A timestamp invented here would be indistinguishable
 * later from one that was real.
 */
async function backfill(leagues, seasons) {
  const now = new Date().toISOString();
  const wanted = new Set(leagues);
  const windows = seasons.map(seasonWindow);
  const inSeason = (d) => windows.some(([from, to]) => d >= from && d <= to);

  console.log(`Fetching the archive (one file, all divisions, 2000-2025)...`);
  let rows;
  try {
    rows = parseCsv(await getText(ODDS_MIRROR));
  } catch (err) {
    logCollection({ stream: "backfill", status: "failed", error: err.message });
    console.log(`FAILED — ${err.message}`);
    process.exitCode = 1;
    return;
  }
  console.log(`${rows.length} matches in the archive. Filtering to ${[...wanted].join(",")} over ${seasons.join(",")}.\n`);

  const MARKETS = [
    { market: "1X2", venue: "market_average", cols: [["OddHome", "HOME"], ["OddDraw", "DRAW"], ["OddAway", "AWAY"]] },
    { market: "1X2", venue: "best_of_panel", cols: [["MaxHome", "HOME"], ["MaxDraw", "DRAW"], ["MaxAway", "AWAY"]] },
    { market: "OU25", venue: "market_average", cols: [["Over25", "OVER"], ["Under25", "UNDER"]] },
    { market: "OU25", venue: "best_of_panel", cols: [["MaxOver25", "OVER"], ["MaxUnder25", "UNDER"]] },
  ];

  const oddsRows = [], resultRows = [], per = new Map();
  for (const r of rows) {
    const league = r.Division;
    const date = (r.MatchDate ?? "").slice(0, 10);
    if (!wanted.has(league) || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !inSeason(date)) continue;
    if (!r.HomeTeam || !r.AwayTeam) continue;
    const id = matchId(league, date, r.HomeTeam, r.AwayTeam);
    per.set(league, (per.get(league) ?? 0) + 1);

    for (const m of MARKETS) {
      for (const [col, selection] of m.cols) {
        const price = Number(r[col]);
        if (!Number.isFinite(price) || price <= 1) continue;
        oddsRows.push({
          match_id: id, league, kickoff_date: date, home: r.HomeTeam, away: r.AwayTeam,
          source: "club-football-match-data", venue: m.venue, market: m.market, selection,
          price, available_stake: null,
          price_taken_at: null,   // the archive does not say. Do not invent it.
          observed_at: now, phase: "archive",
        });
      }
    }
    if (r.FTHome !== "" && r.FTAway !== "") {
      resultRows.push({
        match_id: id, league, kickoff_date: date, home: r.HomeTeam, away: r.AwayTeam,
        ft_home: Number(r.FTHome), ft_away: Number(r.FTAway),
        ht_home: r.HTHome === "" ? null : Number(r.HTHome), ht_away: r.HTAway === "" ? null : Number(r.HTAway),
        result: r.FTResult || null,
        home_elo: r.HomeElo === "" ? null : Number(r.HomeElo), away_elo: r.AwayElo === "" ? null : Number(r.AwayElo),
        source: "club-football-match-data", observed_at: now,
      });
    }
  }

  write("odds", oddsRows);
  write("results", resultRows);
  for (const [league, n] of [...per].sort()) console.log(`  ${league.padEnd(5)} ${String(n).padStart(5)} matches`);
  logCollection({ stream: "backfill", status: "ok", leagues, seasons, odds_rows: oddsRows.length, result_rows: resultRows.length });
  console.log(`\n${oddsRows.length} price observations, ${resultRows.length} results.`);
  if (oddsRows.length) console.log("Every one carries price_taken_at: null — the archive has no timestamps, and that gap is the reason to start snapshotting.");
}

/**
 * Elo snapshots, twice a month since 2000, from the same keyless mirror.
 *
 * This is NOT a substitute for the price series. It carries no market, no
 * liquidity and no closing line. What it does carry is the one thing the odds
 * archive does not: a dated external opinion of team strength, so a match can
 * be joined to what was known BEFORE it rather than to a season-long average.
 */
async function ratings() {
  const now = new Date().toISOString();
  let text;
  try {
    text = await getText(ELO_MIRROR);
  } catch (err) {
    logCollection({ stream: "ratings", status: "failed", error: err.message });
    console.log(`FAILED — ${err.message}`);
    process.exitCode = 1;
    return;
  }
  const rows = parseCsv(text).map((r) => {
    const o = {};
    for (const [k, v] of Object.entries(r)) o[k.replace(/^"|"$/g, "")] = String(v ?? "").replace(/^"|"$/g, "");
    return o;
  });
  const out = [];
  for (const r of rows) {
    const elo = Number(r.elo);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(r.date ?? "") || !r.club || !Number.isFinite(elo)) continue;
    out.push({
      as_of: r.date, club: r.club, club_slug: teamSlug(r.club), country: r.country || null,
      elo, source: "clubelo-via-mirror", observed_at: now,
    });
  }
  write("ratings", out);
  const dates = [...new Set(out.map((r) => r.as_of))].sort();
  logCollection({ stream: "ratings", status: "ok", rows: out.length, first: dates[0], last: dates[dates.length - 1] });
  console.log(`${out.length} rating snapshots, ${dates.length} distinct dates, ${dates[0]} to ${dates[dates.length - 1]}.`);
  console.log(`${new Set(out.map((r) => r.club_slug)).size} distinct clubs after slugging.`);
  console.log("This is a strength series, not a price series. It cannot stand in for the closing line.");
}

/**
 * The rating as of the last snapshot STRICTLY BEFORE a date.
 *
 * Strictly, because a snapshot taken on the day of a match may already reflect
 * it. Getting this wrong is not a rounding error — it is look-ahead, and it
 * makes a model look prescient in backtest and useless in front of a bookmaker.
 */
export function ratingAsOf(snapshots, clubSlug, date) {
  let best = null;
  for (const s of snapshots) {
    if (s.club_slug !== clubSlug || !(s.as_of < date)) continue;
    if (best === null || s.as_of > best.as_of) best = s;
  }
  return best;
}

/**
 * Live snapshot. This is the stream the research programme actually needs and
 * the one no free keyless source provides, so it says so plainly rather than
 * writing an empty file and looking healthy.
 */
async function snapshot(leagues) {
  const key = process.env.THE_ODDS_API_KEY;
  if (!key) {
    console.log("No THE_ODDS_API_KEY set, and no keyless source publishes live prices with timestamps.");
    console.log("Snapshotting is the one stream that cannot be had for free. Without it you can backfill");
    console.log("history but never build the open-to-close series the research depends on.");
    logCollection({ stream: "snapshot", status: "skipped", reason: "no odds provider credentials" });
    return;
  }
  const now = new Date().toISOString();
  const sportKey = "soccer_epl";
  const url = `https://api.the-odds-api.com/v4/sports/${sportKey}/odds/?apiKey=${key}&regions=uk,eu&markets=h2h&oddsFormat=decimal`;
  try {
    const events = JSON.parse(await getText(url));
    const rows = [];
    for (const ev of events) {
      const id = matchId(leagues[0] ?? "E0", ev.commence_time, ev.home_team, ev.away_team);
      for (const bm of ev.bookmakers ?? []) {
        for (const mk of bm.markets ?? []) {
          for (const o of mk.outcomes ?? []) {
            rows.push({
              match_id: id, league: leagues[0] ?? "E0", kickoff_date: day(ev.commence_time),
              home: ev.home_team, away: ev.away_team,
              source: "the-odds-api", venue: bm.key, market: mk.key.toUpperCase(),
              selection: o.name === ev.home_team ? "HOME" : o.name === ev.away_team ? "AWAY" : "DRAW",
              price: o.price, available_stake: null,
              price_taken_at: bm.last_update ?? null, observed_at: now, phase: "live",
            });
          }
        }
      }
    }
    write("odds", rows);
    logCollection({ stream: "snapshot", status: "ok", rows: rows.length, events: events.length });
    console.log(`${rows.length} price observations across ${events.length} events.`);
  } catch (err) {
    logCollection({ stream: "snapshot", status: "failed", error: err.message });
    console.log(`FAILED — ${err.message}`);
    process.exitCode = 1;
  }
}

function status() {
  const OUT = outDir();
  if (!existsSync(OUT)) { console.log(`Nothing collected yet (${OUT} does not exist).`); return; }
  let total = 0;
  for (const stream of readdirSync(OUT)) {
    const dir = join(OUT, stream);
    if (!statSync(dir).isDirectory()) continue;
    const files = readdirSync(dir).filter((f) => f.endsWith(".ndjson")).sort();
    let lines = 0, bytes = 0;
    for (const f of files) {
      const p = join(dir, f);
      bytes += statSync(p).size;
      lines += readFileSync(p, "utf8").split("\n").filter(Boolean).length;
    }
    total += lines;
    console.log(`${stream.padEnd(16)} ${String(lines).padStart(9)} rows  ${(bytes / 1e6).toFixed(1).padStart(7)} MB  ${files.length} day files  ${files[0] ?? ""}${files.length > 1 ? ` .. ${files[files.length - 1]}` : ""}`);
  }
  console.log(`\n${total} observations under ${OUT}`);
  console.log("Read them with DuckDB:  SELECT * FROM read_json_auto('data/collected/odds/*.ndjson');");
}

// Only run the CLI when invoked as a script, so the helpers can be imported
// and tested without the module collecting anything as a side effect.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (cmd === "closing") {
    await closing(list(flag("leagues", "E0,SP1,I1,D1,F1")), list(flag("seasons", "1920,2021,2122,2223,2324,2425,2526")));
  } else if (cmd === "ratings") {
    await ratings();
  } else if (cmd === "backfill") {
    await backfill(list(flag("leagues", "E0,I1,SP1,D1,F1")), list(flag("seasons", "2425,2526")));
  } else if (cmd === "snapshot") {
    await snapshot(list(flag("leagues", "E0")));
  } else if (cmd === "status" || cmd === undefined) {
    status();
  } else {
    console.error(`Unknown command "${cmd}". Use backfill, closing, ratings, snapshot or status.`);
    process.exit(1);
  }
}
