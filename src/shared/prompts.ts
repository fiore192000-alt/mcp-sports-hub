/**
 * MCP Prompts — curated, user-selectable entry points (usually surfaced as
 * slash commands) that pre-wire multi-step workflows over the 400+ tools. With
 * so many tools, users don't know which to call; a handful of good prompts turn
 * the sprawl into a guided UX. Pure UX — no upstream API cost.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { completable } from "@modelcontextprotocol/sdk/server/completable.js";

const LEAGUES = ["nfl", "nba", "mlb", "nhl", "premier-league", "la-liga", "bundesliga", "serie-a", "ligue-1", "euroleague", "ncaaf"];
const SERIES = ["all", "f1", "motogp", "formulae", "nascar"];
const FD_LEAGUE_CODES = ["E0", "E1", "E2", "E3", "EC", "SC0", "D1", "D2", "I1", "I2", "SP1", "SP2", "F1", "F2", "N1", "B1", "P1", "T1", "G1"];

function userText(text: string) {
  return { messages: [{ role: "user" as const, content: { type: "text" as const, text } }] };
}

export function registerPrompts(server: McpServer): void {
  // 1. what's on today
  server.registerPrompt(
    "whats-on-today",
    {
      title: "What's on today",
      description: "Multi-sport rundown of today's games across the major leagues.",
    },
    async () =>
      userText(
        "Show me what major sports are on today. Use `espn_get_scoreboard` for in-season leagues " +
        "(NFL/NBA/MLB/NHL/soccer), plus `nhl_get_scores`, `mlb_get_schedule`, and " +
        "`openliga_get_current_matchday`. Group live and upcoming games by sport, with scores and start times.",
      ),
  );

  // 2. compare odds for an event
  server.registerPrompt(
    "compare-odds",
    {
      title: "Compare betting odds",
      description: "Fan out to the odds providers and compare prices for an event.",
      argsSchema: { event: z.string().describe("Event/match, e.g. 'Lakers vs Celtics'") },
    },
    async ({ event }) =>
      userText(
        `Compare betting odds for "${event}". Call \`odds_get_odds\`, \`oddsio_get_odds\` and \`sgo_get_odds\` ` +
        "(these need their API keys set), locate the matching event in each, then present the best available " +
        "price per outcome across bookmakers and flag the sharpest line. Note any provider that returned nothing.",
      ),
  );

  // 3. motorsport weekend
  server.registerPrompt(
    "motorsport-weekend",
    {
      title: "Motorsport weekend",
      description: "Current weekend picture across F1, MotoGP, Formula E and NASCAR.",
      argsSchema: {
        series: completable(
          z.string().optional().describe("Series to focus on: all, f1, motogp, formulae, nascar"),
          (value) => SERIES.filter((s) => s.startsWith((value ?? "").toLowerCase())),
        ),
      },
    },
    async ({ series }) => {
      const focus = series && series !== "all" ? series : "all four series";
      return userText(
        `Give me the current motorsport weekend picture for ${focus}. ` +
        "For F1 use `openf1_*` (live sessions/laps) and `f1_get_race_results`; MotoGP use " +
        "`motogp_get_events` → `motogp_get_sessions` → `motogp_get_session_classification` and `motogp_get_standings`; " +
        "Formula E use `formulae_get_races` + `formulae_get_driver_standings`; NASCAR use `nascar_get_schedule` + `nascar_get_live`. " +
        "Summarize who's racing, latest results, and championship standings.",
      );
    },
  );

  // 4. league standings
  server.registerPrompt(
    "league-standings",
    {
      title: "League standings",
      description: "Pull the current standings/table for a league.",
      argsSchema: {
        league: completable(
          z.string().describe("League, e.g. nba, premier-league, euroleague"),
          (value) => LEAGUES.filter((l) => l.startsWith((value ?? "").toLowerCase())),
        ),
      },
    },
    async ({ league }) =>
      userText(
        `Show the current standings for ${league}. Choose the right tool: \`espn_get_standings\` (most leagues), ` +
        "`nhl_get_standings`, `mlb_get_standings`, `euroleague_get_games` (derive the table) for EuroLeague, or " +
        "`apifootball_get_standings` / `footballdata_get_standings` for soccer. Present a clean ranked table.",
      ),
  );

  // 5. team deep dive
  server.registerPrompt(
    "team-deep-dive",
    {
      title: "Team deep dive",
      description: "Find a team and summarize its form, fixtures and key players.",
      argsSchema: { team: z.string().describe("Team name, e.g. 'Arsenal' or 'Boston Celtics'") },
    },
    async ({ team }) =>
      userText(
        `Do a deep dive on ${team}. First find it via \`sportsdb_search_teams\` or \`espn_get_teams\`, then pull its ` +
        "recent results and upcoming schedule and key player stats from the most relevant provider. " +
        "Summarize current form, next fixtures, and standout players.",
      ),
  );

  // 6. f1 race summary
  server.registerPrompt(
    "f1-race",
    {
      title: "F1 race summary",
      description: "Summarize an F1 race and its championship impact.",
      argsSchema: {
        season: z.string().describe("Season year, e.g. 2024"),
        round: z.string().optional().describe("Round number (optional; omit for the latest)"),
      },
    },
    async ({ season, round }) =>
      userText(
        `Summarize the F1 race for season ${season}${round ? `, round ${round}` : " (latest round)"}. ` +
        "Use `f1_get_race_results` for the classification, `openf1_get_laps`/`openf1_get_pit` if it's recent, " +
        "and `f1_get_driver_standings` for the championship impact. Give the podium, key moments, and standings change.",
      ),
  );

  // 7. build a football trade
  server.registerPrompt(
    "build-football-trade",
    {
      title: "Build a football trade",
      description: "Price a match with a model, compare it to the market and size the position.",
      argsSchema: {
        match: z.string().describe("Match, e.g. 'Inter vs Milan'"),
        bankroll: z.string().optional().describe("Bankroll for stake sizing (optional, default 100)"),
      },
    },
    async ({ match, bankroll }) =>
      userText(
        `Build a trade on "${match}". Work in this order and show your numbers at each step:\n` +
        "1. Market: get current prices with `odds_get_odds` / `oddsio_get_odds` (or ask me for them if no key is set).\n" +
        "2. Fair price: `trading_devig_odds` on the full 1X2 market, method shin, to strip the margin.\n" +
        "3. Own estimate: `trading_team_ratings` for the league (league code + season, e.g. I1/2526) with `home` and `away` set, " +
        "which fits attack/defence strengths and prices the fixture with Poisson.\n" +
        "4. Edge: `trading_evaluate_bet` with the model probabilities against the best available price" +
        `${bankroll ? `, bankroll ${bankroll}` : ""}. Report edge, EV and a quarter-Kelly stake.\n` +
        "5. Sanity check: `trading_backtest` with strategy value_model on that league's recent seasons, to show whether this " +
        "model has actually made money there.\n" +
        "Finish with the position (selection, price, stake) or a clear 'no bet' if nothing clears the margin, and say which step " +
        "carries the most uncertainty.",
      ),
  );

  // 8. backtest a football strategy
  server.registerPrompt(
    "backtest-football-strategy",
    {
      title: "Backtest a football strategy",
      description: "Test a betting strategy on historical results + closing odds, then stress it.",
      argsSchema: {
        idea: z.string().describe("Strategy idea, e.g. 'back the draw in Serie A when both sides are mid-table'"),
        leagues: completable(
          z.string().optional().describe("League codes, e.g. E0,I1,SP1"),
          (value) => FD_LEAGUE_CODES.filter((l) => l.startsWith((value ?? "").toUpperCase())),
        ),
      },
    },
    async ({ idea, leagues }) =>
      userText(
        `Backtest this idea: "${idea}"${leagues ? ` on ${leagues}` : ""}.\n` +
        "1. `trading_list_strategies` — map the idea onto the closest built-in strategy and its filters.\n" +
        "2. `trading_backtest` — run it on at least 3 seasons with book avg and flat staking (the honest baseline). " +
        "Report bets, ROI, max drawdown and closing-line value.\n" +
        "3. Stress it: re-run split by season and by league, and once with book pinnacle. An edge that only exists in one " +
        "season, one league, or only at best-price-anywhere is not an edge.\n" +
        "4. Compare against the relevant baseline (home/favourite/draw flat betting on the same data).\n" +
        "Conclude with whether the result survives, and state the sample size plainly — under a few hundred bets, say so.",
      ),
  );
}
