/**
 * Shared access to the football-data.co.uk CSV archive.
 *
 * Two consumers: the `footballdata_uk_` provider (raw rows) and the
 * `trading_` provider (normalized matches + odds for backtesting). Keeping the
 * parsing, the league table and the odds-column fallbacks here means the two
 * can't drift apart — and the column fallbacks are the fiddly part, because
 * the archive changed shape twice: Betbrain aggregates (Bb*) until 2018/19,
 * Max/Avg after, and separate closing-odds columns (*C*) only from 2019/20.
 */

import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fetchText } from "./http.js";

export const FD_BASE = "https://www.football-data.co.uk";

/** Main-division league codes (see notes.txt for the full list). */
export const FD_LEAGUES: Record<string, string> = {
  E0: "England — Premier League", E1: "England — Championship", E2: "England — League One",
  E3: "England — League Two", EC: "England — National League",
  SC0: "Scotland — Premiership", SC1: "Scotland — Championship", SC2: "Scotland — League One", SC3: "Scotland — League Two",
  D1: "Germany — Bundesliga", D2: "Germany — 2. Bundesliga",
  I1: "Italy — Serie A", I2: "Italy — Serie B",
  SP1: "Spain — La Liga", SP2: "Spain — La Liga 2",
  F1: "France — Ligue 1", F2: "France — Ligue 2",
  N1: "Netherlands — Eredivisie", B1: "Belgium — Pro League", P1: "Portugal — Primeira Liga",
  T1: "Turkey — Süper Lig", G1: "Greece — Super League",
};

/** Minimal RFC-4180-ish CSV parser (handles quoted fields and CRLF). */
export function parseCsv(text: string): Array<Record<string, string>> {
  const rows: string[][] = [];
  let field = "", row: string[] = [], inQuotes = false;
  const t = text.replace(/^﻿/, "");
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (inQuotes) {
      if (c === '"') { if (t[i + 1] === '"') { field += '"'; i++; } else inQuotes = false; }
      else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (c !== "\r") field += c;
  }
  if (field.length > 0 || row.length > 1) { row.push(field); rows.push(row); }
  if (rows.length === 0) return [];
  const headers = rows[0].map((h) => h.trim());
  const out: Array<Record<string, string>> = [];
  for (let r = 1; r < rows.length; r++) {
    const vals = rows[r];
    if (vals.every((v) => v.trim() === "")) continue;
    const obj: Record<string, string> = {};
    headers.forEach((h, i) => { if (h && vals[i] !== undefined && vals[i] !== "") obj[h] = vals[i]; });
    if (Object.keys(obj).length) out.push(obj);
  }
  return out;
}

/** Upcoming fixtures across every league, with opening prices attached. */
export const FD_FIXTURES_PATH = "/fixtures.csv";

/**
 * Where to look for football-data.co.uk CSVs on disk before going to the
 * network. Same layout the site itself uses, so a file downloaded in a browser
 * can be dropped in unchanged:
 *
 *   <dir>/<season>/<LEAGUE>.csv   e.g. data/football-data/2627/I1.csv
 *   <dir>/fixtures.csv            the upcoming-fixtures file
 *
 * This exists because the odds are the part of the pipeline that cannot be
 * replaced by the keyless mirrors, and the archive is one host that a network
 * policy, an outage or a rate limit can take away. A local copy is the one
 * source nothing can block.
 */
export const FD_DATA_DIR = process.env.SPORTS_HUB_DATA_DIR ?? "data/football-data";

/** Read a local CSV if it is there. Anything unreadable falls through to the network. */
async function readLocal(...segments: string[]): Promise<string | undefined> {
  try {
    const text = await readFile(resolve(join(FD_DATA_DIR, ...segments)), "utf8");
    return text.trim() ? text : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Fetch and parse one league-season CSV: local copy first, then the archive.
 * Historical data — the network path is cached an hour.
 */
export async function fetchLeagueSeason(league: string, season: string): Promise<Array<Record<string, string>>> {
  const local = await readLocal(season, `${league.toUpperCase()}.csv`);
  if (local) return parseCsv(local);
  const csv = await fetchText(
    `${FD_BASE}/mmz4281/${encodeURIComponent(season)}/${encodeURIComponent(league)}.csv`,
    { cacheTtl: 3600 },
  );
  return parseCsv(csv);
}

/**
 * Fetch the upcoming-fixtures file. One file covers every league, so callers
 * filter by `Div` rather than fetching per league. Cached 15 minutes: prices
 * move, and this is the one football-data file that is not historical.
 */
export async function fetchFixtures(): Promise<Array<Record<string, string>>> {
  const local = await readLocal("fixtures.csv");
  if (local) return parseCsv(local);
  return parseCsv(await fetchText(`${FD_BASE}${FD_FIXTURES_PATH}`, { cacheTtl: 900 }));
}

// ---------------------------------------------------------------------------
// Odds columns
// ---------------------------------------------------------------------------

export type OddsPhase = "open" | "close";
export type Book = "avg" | "max" | "b365" | "pinnacle";
export type FdOutcome = "H" | "D" | "A" | "O25" | "U25";

export const BOOKS: Book[] = ["avg", "max", "b365", "pinnacle"];

const PRICE_COLUMNS: Record<OddsPhase, Record<Book, Record<FdOutcome, string[]>>> = {
  open: {
    avg:      { H: ["AvgH", "BbAvH"], D: ["AvgD", "BbAvD"], A: ["AvgA", "BbAvA"], O25: ["Avg>2.5", "BbAv>2.5"], U25: ["Avg<2.5", "BbAv<2.5"] },
    max:      { H: ["MaxH", "BbMxH"], D: ["MaxD", "BbMxD"], A: ["MaxA", "BbMxA"], O25: ["Max>2.5", "BbMx>2.5"], U25: ["Max<2.5", "BbMx<2.5"] },
    b365:     { H: ["B365H"], D: ["B365D"], A: ["B365A"], O25: ["B365>2.5"], U25: ["B365<2.5"] },
    pinnacle: { H: ["PSH", "PH"], D: ["PSD", "PD"], A: ["PSA", "PA"], O25: ["P>2.5"], U25: ["P<2.5"] },
  },
  close: {
    avg:      { H: ["AvgCH"], D: ["AvgCD"], A: ["AvgCA"], O25: ["AvgC>2.5"], U25: ["AvgC<2.5"] },
    max:      { H: ["MaxCH"], D: ["MaxCD"], A: ["MaxCA"], O25: ["MaxC>2.5"], U25: ["MaxC<2.5"] },
    b365:     { H: ["B365CH"], D: ["B365CD"], A: ["B365CA"], O25: ["B365C>2.5"], U25: ["B365C<2.5"] },
    pinnacle: { H: ["PSCH"], D: ["PSCD"], A: ["PSCA"], O25: ["PC>2.5"], U25: ["PC<2.5"] },
  },
};

function readOdds(row: Record<string, string>, columns: string[]): number | undefined {
  for (const col of columns) {
    const raw = row[col];
    if (raw === undefined) continue;
    const n = Number.parseFloat(raw);
    if (Number.isFinite(n) && n > 1) return n;
  }
  return undefined;
}

/**
 * Price for one outcome, preferring `book` and falling back through the other
 * aggregates. Returns the book actually used so callers can report it rather
 * than quietly mixing sources.
 */
export function priceFor(
  row: Record<string, string>,
  phase: OddsPhase,
  book: Book,
  outcome: FdOutcome,
): { odds: number; book: Book } | undefined {
  const order: Book[] = [book, ...BOOKS.filter((b) => b !== book)];
  for (const b of order) {
    const odds = readOdds(row, PRICE_COLUMNS[phase][b][outcome]);
    if (odds !== undefined) return { odds, book: b };
  }
  return undefined;
}

/** Parse football-data's dd/mm/yy or dd/mm/yyyy into epoch ms (UTC). */
export function parseFdDate(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(raw.trim());
  if (!m) return undefined;
  const day = Number(m[1]), month = Number(m[2]);
  let year = Number(m[3]);
  if (year < 100) year += year < 70 ? 2000 : 1900;
  const ts = Date.UTC(year, month - 1, day);
  return Number.isFinite(ts) ? ts : undefined;
}

export interface FdMatch {
  league: string;
  season: string;
  date: string;
  ts: number;
  home: string;
  away: string;
  homeGoals: number;
  awayGoals: number;
  /** "H" | "D" | "A" as published in FTR. */
  result: string;
  totalGoals: number;
  /** Prices by phase and outcome, with the book each came from. */
  prices: Record<OddsPhase, Partial<Record<FdOutcome, { odds: number; book: Book }>>>;
}

export interface FdFixture {
  league: string;
  date: string;
  ts: number;
  time?: string;
  home: string;
  away: string;
  /** Opening prices; a fixture has no closing line yet by definition. */
  prices: Partial<Record<FdOutcome, { odds: number; book: Book }>>;
}

/** Team names are identical across the archive's files, but guard anyway. */
export function normalizeTeam(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Normalize rows from fixtures.csv into upcoming fixtures. Rows for matches
 * that already have a result are dropped — the file occasionally trails one.
 */
export function toFixtures(
  rows: Array<Record<string, string>>,
  book: Book = "avg",
  leagues?: string[],
): FdFixture[] {
  const wanted = leagues && leagues.length ? new Set(leagues.map((l) => l.toUpperCase())) : undefined;
  const out: FdFixture[] = [];
  for (const row of rows) {
    const league = (row.Div ?? "").toUpperCase();
    const ts = parseFdDate(row.Date);
    const home = row.HomeTeam, away = row.AwayTeam;
    if (ts === undefined || !home || !away) continue;
    if (wanted && !wanted.has(league)) continue;
    if (row.FTR) continue;

    const prices: FdFixture["prices"] = {};
    for (const outcome of ["H", "D", "A", "O25", "U25"] as FdOutcome[]) {
      const p = priceFor(row, "open", book, outcome);
      if (p) prices[outcome] = p;
    }
    out.push({
      league,
      date: new Date(ts).toISOString().slice(0, 10),
      ts,
      ...(row.Time ? { time: row.Time } : {}),
      home, away, prices,
    });
  }
  return out.sort((a, b) => a.ts - b.ts);
}

/**
 * Normalize raw CSV rows into matches with prices attached. Rows without a
 * parseable date, both teams and a full-time result are dropped — they are
 * either fixtures not yet played or the trailing junk rows the archive
 * sometimes carries.
 */
export function toMatches(
  rows: Array<Record<string, string>>,
  league: string,
  season: string,
  book: Book = "avg",
): FdMatch[] {
  const out: FdMatch[] = [];
  for (const row of rows) {
    const ts = parseFdDate(row.Date);
    const home = row.HomeTeam, away = row.AwayTeam;
    const fthg = Number.parseInt(row.FTHG ?? "", 10);
    const ftag = Number.parseInt(row.FTAG ?? "", 10);
    const ftr = row.FTR;
    if (ts === undefined || !home || !away) continue;
    if (!Number.isInteger(fthg) || !Number.isInteger(ftag) || !ftr) continue;

    const prices: FdMatch["prices"] = { open: {}, close: {} };
    for (const phase of ["open", "close"] as OddsPhase[]) {
      for (const outcome of ["H", "D", "A", "O25", "U25"] as FdOutcome[]) {
        const p = priceFor(row, phase, book, outcome);
        if (p) prices[phase][outcome] = p;
      }
    }

    out.push({
      league, season,
      date: new Date(ts).toISOString().slice(0, 10),
      ts, home, away,
      homeGoals: fthg, awayGoals: ftag,
      result: ftr,
      totalGoals: fthg + ftag,
      prices,
    });
  }
  return out.sort((a, b) => a.ts - b.ts);
}
