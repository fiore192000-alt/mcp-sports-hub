/**
 * openfootball/football.json — a keyless, community-maintained mirror of
 * league calendars and results, served as static JSON from GitHub.
 *
 * Why a second source at all: football-data.co.uk is the better one (it
 * carries bookmaker odds, which is what makes a prediction measurable against
 * the market), but it is a single origin that can be down, rate-limited, or
 * unreachable from a restricted network. This source has no odds, so no
 * market benchmark and no picks — but ratings, predictions and scoring all
 * still work, which is the difference between a degraded loop and no loop.
 *
 * Data shape: one file per league-season, every fixture of the season, with
 * `score` present only once a match has been played.
 */

import { fetchJson } from "./http.js";
import type { Book, FdFixture, FdMatch } from "./football-csv.js";

export const OF_BASE = "https://raw.githubusercontent.com/openfootball/football.json/master";

/** openfootball league keys, and the football-data.co.uk codes they answer to. */
export const OF_LEAGUES: Record<string, { key: string; name: string }> = {
  E0:  { key: "en.1", name: "England — Premier League" },
  E1:  { key: "en.2", name: "England — Championship" },
  I1:  { key: "it.1", name: "Italy — Serie A" },
  I2:  { key: "it.2", name: "Italy — Serie B" },
  SP1: { key: "es.1", name: "Spain — La Liga" },
  SP2: { key: "es.2", name: "Spain — La Liga 2" },
  D1:  { key: "de.1", name: "Germany — Bundesliga" },
  D2:  { key: "de.2", name: "Germany — 2. Bundesliga" },
  F1:  { key: "fr.1", name: "France — Ligue 1" },
  F2:  { key: "fr.2", name: "France — Ligue 2" },
};

/** "2627" -> "2026-27", the directory name this source uses. */
export function seasonPath(code: string): string {
  const start = Number.parseInt(code.slice(0, 2), 10);
  const end = Number.parseInt(code.slice(2), 10);
  const century = start >= 70 ? 1900 : 2000;
  return `${century + start}-${String(end).padStart(2, "0")}`;
}

interface OfScore { ft?: [number, number]; ht?: [number, number] }
interface OfMatch { round?: string; date?: string; time?: string; team1?: string; team2?: string; score?: OfScore }

/**
 * Fetch one league-season and split it into played matches and remaining
 * fixtures, in the same shapes the football-data.co.uk loader produces so the
 * rest of the toolkit does not need to know which source it got.
 *
 * Prices are empty: this source has no odds. Callers must handle that rather
 * than assume a market price is always there.
 */
export async function fetchOpenFootballSeason(
  league: string,
  season: string,
  _book: Book = "avg",
): Promise<{ played: FdMatch[]; fixtures: FdFixture[]; url: string }> {
  const entry = OF_LEAGUES[league.toUpperCase()];
  if (!entry) {
    throw new Error(`openfootball has no mapping for league "${league}". Supported: ${Object.keys(OF_LEAGUES).join(", ")}`);
  }
  const url = `${OF_BASE}/${seasonPath(season)}/${entry.key}.json`;
  const data = (await fetchJson(url, { cacheTtl: 3600 })) as { matches?: OfMatch[] };
  const matches = Array.isArray(data?.matches) ? data.matches : [];

  const played: FdMatch[] = [];
  const fixtures: FdFixture[] = [];
  for (const m of matches) {
    if (!m.date || !m.team1 || !m.team2) continue;
    const ts = Date.parse(`${m.date}T00:00:00Z`);
    if (!Number.isFinite(ts)) continue;
    const ft = m.score?.ft;
    if (ft && Number.isInteger(ft[0]) && Number.isInteger(ft[1])) {
      played.push({
        league: league.toUpperCase(), season,
        date: m.date, ts,
        home: m.team1, away: m.team2,
        homeGoals: ft[0], awayGoals: ft[1],
        result: ft[0] > ft[1] ? "H" : ft[0] === ft[1] ? "D" : "A",
        totalGoals: ft[0] + ft[1],
        prices: { open: {}, close: {} },
      });
    } else {
      fixtures.push({
        league: league.toUpperCase(),
        date: m.date, ts,
        ...(m.time ? { time: m.time } : {}),
        home: m.team1, away: m.team2,
        prices: {},
      });
    }
  }
  played.sort((a, b) => a.ts - b.ts);
  fixtures.sort((a, b) => a.ts - b.ts);
  return { played, fixtures, url };
}
