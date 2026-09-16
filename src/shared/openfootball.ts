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

interface OfMatch { round?: string; date?: string; time?: string; team1?: string; team2?: string; score?: unknown }

/**
 * The full-time score, whichever way this file spells it.
 *
 * The mirror is not schema-stable: most matches carry `{"ft":[h,a],"ht":[…]}`,
 * but some carry a bare `[h,a]`. In Serie A 2025-26 that bare form is used for
 * 36 matches — every single 0-0 of the season. Reading only `.ft` silently
 * dropped all of them, which biased ratings against goalless football and
 * showed up as a model that under-predicted draws. Accept both shapes.
 */
function fullTime(score: unknown): [number, number] | undefined {
  const pair = Array.isArray(score)
    ? score
    : score && typeof score === "object"
      ? (score as { ft?: unknown }).ft
      : undefined;
  if (Array.isArray(pair) && pair.length === 2 && Number.isInteger(pair[0]) && Number.isInteger(pair[1])) {
    return [pair[0] as number, pair[1] as number];
  }
  return undefined;
}

/**
 * Fetch one league-season and split it into played matches and remaining
 * fixtures, in the same shapes the football-data.co.uk loader produces so the
 * rest of the toolkit does not need to know which source it got.
 *
 * Prices are empty: this source has no odds. Callers must handle that rather
 * than assume a market price is always there.
 */
export interface SeasonCoverage {
  total: number;
  played: number;
  /** Dated ahead of the cutoff — genuinely still to come. */
  upcoming: number;
  /** Dated in the past with no score: the source never recorded the result. */
  missing_results: number;
  missing_examples?: string[];
  last_result_date?: string;
}

/**
 * How long after kick-off a missing result is still just lag rather than a
 * hole. The mirrors run a few days behind; beyond that the result is not
 * coming on its own.
 */
const LAG_DAYS = 3;

export async function fetchOpenFootballSeason(
  league: string,
  season: string,
  _book: Book = "avg",
): Promise<{ played: FdMatch[]; fixtures: FdFixture[]; url: string; coverage: SeasonCoverage }> {
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
    const ft = fullTime(m.score);
    if (ft) {
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

  // A volunteer-maintained mirror can simply stop: Serie A 2024-25 is missing
  // its entire final matchday. Ratings quietly fitted on an incomplete season,
  // and predictions that stay "pending" forever, are the symptoms — so count
  // the holes and hand them to the caller rather than assuming completeness.
  const cutoff = Date.now() - LAG_DAYS * 86_400_000;
  const missing = fixtures.filter((f) => f.ts < cutoff);
  const coverage: SeasonCoverage = {
    total: played.length + fixtures.length,
    played: played.length,
    upcoming: fixtures.length - missing.length,
    missing_results: missing.length,
    ...(missing.length ? { missing_examples: missing.slice(0, 5).map((f) => `${f.date} ${f.home} v ${f.away}`) } : {}),
    ...(played.length ? { last_result_date: played[played.length - 1].date } : {}),
  };
  return { played, fixtures, url, coverage };
}
