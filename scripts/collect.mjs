#!/usr/bin/env node
/**
 * Collector v1 — deliberately stupid.
 *
 *   npm run collect -- backfill [--leagues E0,I1] [--seasons 2425,2526]
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

const ODDS_MIRROR = "https://raw.githubusercontent.com/xgabora/Club-Football-Match-Data-2000-2025/main/data/Matches.csv";

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
  if (cmd === "backfill") {
    await backfill(list(flag("leagues", "E0,I1,SP1,D1,F1")), list(flag("seasons", "2425,2526")));
  } else if (cmd === "snapshot") {
    await snapshot(list(flag("leagues", "E0")));
  } else if (cmd === "status" || cmd === undefined) {
    status();
  } else {
    console.error(`Unknown command "${cmd}". Use backfill, snapshot or status.`);
    process.exit(1);
  }
}
