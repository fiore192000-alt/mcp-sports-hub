#!/usr/bin/env node
/**
 * Fill data/football-data/ from a public GitHub mirror of football-data.co.uk.
 *
 *   npm run fetch:archive -- [--leagues E0,I1] [--from 2015] [--dir data/football-data]
 *
 * Why this exists: odds are the input no keyless source carries, and the site
 * that has them is one host a network policy or an outage can take away. The
 * mirror at xgabora/Club-Football-Match-Data-2000-2025 republishes the same
 * data — 238k matches, 38 divisions, 2000 to the present — as one CSV on
 * GitHub, which is reachable from places the original is not.
 *
 * This downloads it once and writes it back out in football-data.co.uk's own
 * per-league-season layout, so everything downstream (the market benchmark,
 * edges, backtests, closing-line value) works from the local drop-in with no
 * new source type and no runtime cost.
 *
 * Two things the mirror is not: it carries the market AVERAGE price and the
 * best price, but no separate closing line, so closing-line value cannot be
 * computed from it; and its Elo column after mid-2025 is the maintainer's own
 * continuation rather than ClubElo's. Neither affects the odds themselves.
 */

import { mkdir, writeFile, access } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { parseCsv } = await import(join(root, "dist", "shared", "football-csv.js"));

const SOURCE = "https://raw.githubusercontent.com/xgabora/Club-Football-Match-Data-2000-2025/main/data/Matches.csv";

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
};
const leagues = flag("leagues", "E0,I1,SP1,D1,F1").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
const from = Number(flag("from", "2015"));
const outDir = join(root, flag("dir", "data/football-data"));

/** Mirror column -> football-data.co.uk column. Anything unmapped is dropped. */
const COLUMNS = [
  ["Division", "Div"], ["HomeTeam", "HomeTeam"], ["AwayTeam", "AwayTeam"],
  ["FTHome", "FTHG"], ["FTAway", "FTAG"], ["FTResult", "FTR"],
  ["HTHome", "HTHG"], ["HTAway", "HTAG"], ["HTResult", "HTR"],
  ["HomeShots", "HS"], ["AwayShots", "AS"], ["HomeTarget", "HST"], ["AwayTarget", "AST"],
  ["HomeCorners", "HC"], ["AwayCorners", "AC"], ["HomeFouls", "HF"], ["AwayFouls", "AF"],
  ["HomeYellow", "HY"], ["AwayYellow", "AY"], ["HomeRed", "HR"], ["AwayRed", "AR"],
  ["OddHome", "AvgH"], ["OddDraw", "AvgD"], ["OddAway", "AvgA"],
  ["MaxHome", "MaxH"], ["MaxDraw", "MaxD"], ["MaxAway", "MaxA"],
  ["Over25", "Avg>2.5"], ["Under25", "Avg<2.5"],
  ["MaxOver25", "Max>2.5"], ["MaxUnder25", "Max<2.5"],
  ["HomeElo", "HomeElo"], ["AwayElo", "AwayElo"],
];
const HEADER = ["Date", ...COLUMNS.map(([, to]) => to)];

const seasonOf = (iso) => {
  const [y, m] = iso.split("-").map(Number);
  const start = m >= 7 ? y : y - 1;
  const two = (n) => String(n % 100).padStart(2, "0");
  return { code: `${two(start)}${two(start + 1)}`, startYear: start };
};
const ddmmyyyy = (iso) => { const [y, m, d] = iso.split("-"); return `${d}/${m}/${y}`; };
const csvCell = (v) => (v === undefined || v === null ? "" : /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

console.log(`fetching ${SOURCE}`);
const response = await fetch(SOURCE);
if (!response.ok) {
  console.error(`the mirror answered ${response.status}. It is a third-party repository and can move or disappear; download football-data.co.uk's own CSVs into ${outDir} instead (see its README).`);
  process.exit(1);
}
const text = await response.text();
console.log(`${(text.length / 1e6).toFixed(1)} MB, parsing`);
const rows = parseCsv(text);
console.log(`${rows.length} matches in the mirror\n`);

const buckets = new Map();
let skipped = 0;
for (const row of rows) {
  const div = (row.Division ?? "").toUpperCase();
  if (!leagues.includes(div)) continue;
  if (!row.MatchDate || !row.FTResult) { skipped++; continue; }
  const { code, startYear } = seasonOf(row.MatchDate);
  if (startYear < from) continue;
  const key = `${code}|${div}`;
  if (!buckets.has(key)) buckets.set(key, []);
  buckets.get(key).push([ddmmyyyy(row.MatchDate), ...COLUMNS.map(([src]) => row[src])]);
}

const exists = async (path) => { try { await access(path); return true; } catch { return false; } };
const force = argv.includes("--force");
const written = [];
const kept = [];
for (const [key, lines] of [...buckets].sort()) {
  const [code, div] = key.split("|");
  const target = join(outDir, code, `${div}.csv`);
  // A file already here may be football-data.co.uk's own, which carries the
  // closing line this mirror does not. Never clobber that silently.
  if (!force && await exists(target)) { kept.push(`${code}/${div}.csv`); continue; }
  const withOdds = lines.filter((l) => l[HEADER.indexOf("AvgH")]).length;
  await mkdir(join(outDir, code), { recursive: true });
  const body = [HEADER.join(","), ...lines.map((l) => l.map(csvCell).join(","))].join("\n");
  await writeFile(join(outDir, code, `${div}.csv`), `${body}\n`);
  written.push({ season: code, div, matches: lines.length, withOdds });
}

for (const w of written) {
  console.log(`${w.season}/${w.div}.csv  ${String(w.matches).padStart(4)} matches, ${w.withOdds} with odds`);
}
console.log(`\n${written.length} files written to ${outDir}${skipped ? ` (${skipped} rows without a result skipped)` : ""}`);
if (kept.length) {
  console.log(`${kept.length} left untouched because a file is already there: ${kept.join(", ")}`);
  console.log("Those may be football-data.co.uk's own, which carry the closing line this mirror lacks. Pass --force to replace them anyway.");
}
console.log("These carry the market average and best price, but no closing line — closing-line value needs football-data.co.uk's own files.");
