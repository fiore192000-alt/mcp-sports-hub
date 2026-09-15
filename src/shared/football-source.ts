/**
 * Which source a league-season's results and fixtures come from, and the
 * fallback between them.
 *
 * football-data.co.uk is the better source — it carries bookmaker odds, which
 * is what lets a prediction be measured against the market. openfootball is a
 * keyless GitHub-hosted mirror with no odds: it keeps ratings, predictions and
 * scoring working when the archive is unreachable (blocked network, outage),
 * at the cost of the market benchmark and any pick.
 *
 * Lives outside the provider so the tools, the tests and the season-tracker
 * script all resolve a source the same way.
 */

import { type Book, type FdFixture, type FdMatch, fetchLeagueSeason, toMatches } from "./football-csv.js";
import { type SeasonCoverage, fetchOpenFootballSeason } from "./openfootball.js";

export type Source = "auto" | "footballdata" | "openfootball";

export interface SeasonData {
  played: FdMatch[];
  /** Remaining fixtures — only openfootball carries them per season. */
  fixtures: FdFixture[];
  used: "footballdata" | "openfootball";
  note?: string;
  /** Only the mirror can report this: the CSV archive holds played matches only. */
  coverage?: SeasonCoverage;
}

export function short(err: unknown): string {
  return err instanceof Error ? err.message.slice(0, 90) : String(err).slice(0, 90);
}

export async function loadSeasonData(
  league: string,
  season: string,
  source: Source = "auto",
  book: Book = "avg",
): Promise<SeasonData> {
  if (source !== "openfootball") {
    try {
      const rows = await fetchLeagueSeason(league, season);
      const played = toMatches(rows, league, season, book);
      if (played.length || source === "footballdata") {
        return { played, fixtures: [], used: "footballdata" };
      }
      // Empty file and we are allowed to look elsewhere — fall through.
      const of = await fetchOpenFootballSeason(league, season, book);
      return { ...of, used: "openfootball", note: `football-data.co.uk had no matches for ${league} ${season}; used openfootball (no odds).` };
    } catch (err) {
      if (source === "footballdata") throw err;
      const of = await fetchOpenFootballSeason(league, season, book);
      return { ...of, used: "openfootball", note: `football-data.co.uk unreachable for ${league} ${season} (${short(err)}) — used openfootball, which carries no odds, so there is no market comparison.` };
    }
  }
  const of = await fetchOpenFootballSeason(league, season, book);
  return { ...of, used: "openfootball" };
}

/** Played matches across several seasons, newest source note kept per season. */
export async function loadSeasons(
  league: string,
  seasons: string[],
  source: Source = "auto",
  book: Book = "avg",
): Promise<{ played: FdMatch[]; notes: string[]; used: Set<string> }> {
  const played: FdMatch[] = [];
  const notes: string[] = [];
  const used = new Set<string>();
  for (const season of seasons) {
    try {
      const data = await loadSeasonData(league, season, source, book);
      used.add(data.used);
      if (data.note) notes.push(data.note);
      played.push(...data.played);
    } catch (err) {
      notes.push(`${league} ${season}: no data (${short(err)})`);
    }
  }
  played.sort((a, b) => a.ts - b.ts);
  return { played, notes, used };
}
