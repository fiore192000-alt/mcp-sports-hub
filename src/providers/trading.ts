import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { errorResult, safe, toolResult } from "../shared/http.js";
import {
  BOOKS, FD_LEAGUES, type Book, type FdMatch, type FdOutcome, type OddsPhase,
  fetchLeagueSeason, toMatches,
} from "../shared/football-csv.js";
import {
  type DevigMethod, type RatedMatch, type RatingsFit,
  arbitrage, assessSelections, asOdds, asPct, asProb, devig, expectedGoals,
  fitRatings, hedge, kelly, matchModel, round,
} from "../shared/betting-math.js";

// ---------------------------------------------------------------------------
// Trading toolkit — 9 tools
// Auth: none. No upstream API except football-data.co.uk (already keyless),
//   reached through the shared CSV loader.
//
// Everything else is local computation over numbers the caller already has:
//   margin removal, expected value, Kelly, arbitrage, back/lay hedging, a
//   Poisson match model, team strength ratings, and a walk-forward backtest
//   over 25 years of historical results + closing odds.
//
// Why this lives in the hub: the odds providers (odds_, oddsio_, sgo_,
// lumify_) return prices, not decisions. These tools turn prices into a
// position — and, crucially, let you test the idea on history before staking
// anything on it.
//
// Reality check: a backtest is a measurement of the past under assumptions
// (you got the listed price, you staked every qualifying game, nothing moved).
// It is evidence, not a forecast. Every result here ships with that caveat.
// ---------------------------------------------------------------------------

const STRATEGIES = [
  "home", "draw", "away", "favourite", "underdog", "over25", "under25",
  "value_model", "clv_steam",
] as const;
type Strategy = (typeof STRATEGIES)[number];

const STRATEGY_DOCS: Record<Strategy, string> = {
  home: "Back the home side in every qualifying match. The baseline every other result should be compared against.",
  draw: "Back the draw in every qualifying match. Tests the well-known draw bias at longer prices.",
  away: "Back the away side in every qualifying match.",
  favourite: "Back the shortest price of the three.",
  underdog: "Back the longest price of the three.",
  over25: "Back over 2.5 goals.",
  under25: "Back under 2.5 goals.",
  value_model: "Walk-forward Poisson model: fit attack/defence strengths on matches ALREADY PLAYED at that point in the season, price the match, and bet when the model's edge over the offered price clears edge_pct. No lookahead — a team's own future results never inform its rating.",
  clv_steam: "Closing-line value: bet the OPENING price when it beats the de-vigged CLOSING probability by edge_pct. Measures whether taking early prices beats the market's final word. Needs 2019/20+ seasons, which are the ones carrying separate closing columns.",
};

const MARKET_LABEL: Record<FdOutcome, string> = {
  H: "Home", D: "Draw", A: "Away", O25: "Over 2.5", U25: "Under 2.5",
};

/** Season code ("2425") for the season that started in `year`. */
function seasonCode(year: number): string {
  return `${String(year % 100).padStart(2, "0")}${String((year + 1) % 100).padStart(2, "0")}`;
}

/** Last `n` season codes, ending with the one currently in progress. */
function recentSeasons(n: number): string[] {
  const now = new Date();
  const startYear = now.getUTCMonth() >= 6 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
  return Array.from({ length: n }, (_, i) => seasonCode(startYear - (n - 1 - i)));
}

function splitList(raw: string): string[] {
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

function won(match: FdMatch, outcome: FdOutcome): boolean {
  if (outcome === "O25") return match.totalGoals > 2.5;
  if (outcome === "U25") return match.totalGoals < 2.5;
  return match.result === outcome;
}

interface Candidate {
  match: FdMatch;
  outcome: FdOutcome;
  odds: number;
  book: Book;
  phase: OddsPhase;
  probability?: number;
  edge?: number;
  closeOdds?: number;
}

// ---------------------------------------------------------------------------

export function register(server: McpServer): void {
  // 1. strategy reference — what the backtest can run and what each knob does
  server.tool(
    "trading_list_strategies",
    "List the backtest strategies, staking modes and price sources available in trading_backtest, with the data caveats for each. Call this before trading_backtest if unsure which strategy to run.",
    {},
    safe(async () =>
      toolResult({
        strategies: STRATEGY_DOCS,
        staking: {
          flat: "Same unit on every bet. The honest default — it measures the edge, not the staking plan.",
          percent: "Fixed percentage of the running bankroll. Compounds.",
          kelly: "Fractional Kelly on the model's own probability. Only meaningful for value_model and clv_steam, which produce one; capped by max_stake_pct.",
        },
        price_sources: {
          phase: "open = first price published, close = last price before kick-off. Closing columns exist from season 2019/20 onward; earlier seasons fall back to the single published price and the result says so.",
          book: "avg = market average (realistic), max = best price anywhere (optimistic — you must actually have that account and beat the limit), b365 = Bet365, pinnacle = Pinnacle (sharpest, lowest margin).",
        },
        leagues: FD_LEAGUES,
        season_format: '4 digits, e.g. "2425" for 2024-25. Data starts at 2000-01; odds coverage thins out the further back you go.',
        caveats: [
          "A backtest assumes you got the listed price on every qualifying match, with no stake limits and no line movement between reading the price and placing the bet.",
          "Testing many strategies over the same data finds winners by chance. Treat a result as a hypothesis to confirm out-of-sample, not a signal.",
          "Bookmaker average prices already carry a 4-7% margin; a strategy needs to clear that margin before it clears zero.",
        ],
      }),
    ),
  );

  // 2. de-vig — turn a priced market into fair probabilities
  server.tool(
    "trading_devig_odds",
    "Remove the bookmaker margin from a complete market and return fair probabilities and fair odds. Feed it every outcome of one market (e.g. home/draw/away). Methods: multiplicative, additive, power, shin.",
    {
      odds: z.array(z.number().gt(1)).min(2).max(40).describe("Decimal odds for EVERY outcome of one market, e.g. [2.10, 3.40, 3.60]"),
      names: z.array(z.string()).optional().describe('Optional labels aligned with odds, e.g. ["Home","Draw","Away"]'),
      method: z.enum(["multiplicative", "additive", "power", "shin"]).optional().describe("De-vig method (default multiplicative). shin/power shift probability toward favourites, like a sharp book."),
      compare_methods: z.boolean().optional().describe("Also return the other methods side by side (default false)"),
    },
    safe(async ({ odds, names, method, compare_methods }) => {
      const primary = devig(odds, (method ?? "multiplicative") as DevigMethod);
      const labels = names && names.length === odds.length ? names : odds.map((_, i) => `outcome_${i + 1}`);
      const outcomes = labels.map((name, i) => ({
        name,
        odds: asOdds(odds[i]),
        implied_probability: asProb(1 / odds[i]),
        fair_probability: primary.probabilities[i],
        fair_odds: primary.fair_odds[i],
        margin_applied_pct: asPct(1 / odds[i] / primary.probabilities[i] - 1),
      }));
      const comparison = compare_methods
        ? Object.fromEntries((["multiplicative", "additive", "power", "shin"] as DevigMethod[])
            .map((m) => [m, devig(odds, m).probabilities]))
        : undefined;
      return toolResult({
        method: primary.method,
        booksum: primary.booksum,
        overround_pct: primary.overround_pct,
        outcomes,
        ...(primary.z !== undefined ? { shin_z: primary.z } : {}),
        ...(primary.k !== undefined ? { power_k: primary.k } : {}),
        ...(comparison ? { comparison } : {}),
        ...(primary.note ? { note: primary.note } : {}),
      });
    }),
  );

  // 3. evaluate a bet — edge, EV, Kelly stake
  server.tool(
    "trading_evaluate_bet",
    "Score one or more selections against your own probabilities: edge, expected value per unit, fractional Kelly stake and a bet/no-bet verdict. Pair it with trading_devig_odds (fair probs from a sharp book) or trading_poisson_model (probs from a goals model).",
    {
      selections: z.array(z.object({
        name: z.string().describe('Selection label, e.g. "Inter"'),
        odds: z.number().gt(1).describe("Decimal odds on offer"),
        probability: z.number().gt(0).lt(1).describe("YOUR probability for this selection (0-1)"),
      })).min(1).max(30).describe("Selections to score"),
      bankroll: z.number().positive().optional().describe("Bankroll for stake sizing (default 100)"),
      kelly_fraction: z.number().gt(0).lte(1).optional().describe("Fraction of full Kelly to stake (default 0.25)"),
      max_stake_pct: z.number().gt(0).lte(100).optional().describe("Hard cap per bet as % of bankroll (default 5)"),
      min_edge_pct: z.number().min(0).optional().describe("Minimum edge to call it a bet (default 0)"),
      commission_pct: z.number().min(0).lt(100).optional().describe("Exchange commission on net winnings, % (default 0)"),
    },
    safe(async ({ selections, bankroll, kelly_fraction, max_stake_pct, min_edge_pct, commission_pct }) => {
      const result = assessSelections(selections, {
        bankroll, kelly_fraction, max_stake_pct, min_edge_pct,
        commission: (commission_pct ?? 0) / 100,
      });
      const probSum = selections.reduce((a, s) => a + s.probability, 0);
      return toolResult({
        bankroll: bankroll ?? 100,
        kelly_fraction: kelly_fraction ?? 0.25,
        selections: result.assessments,
        best_bet: result.best,
        total_stake: result.total_stake,
        ...(probSum > 1.02 || probSum < 0.98
          ? { warning: `Your probabilities sum to ${round(probSum, 4)}. That is fine for unrelated selections, but if these are the outcomes of ONE market they should sum to 1.` }
          : {}),
      });
    }),
  );

  // 4. arbitrage — risk-free book across bookmakers
  server.tool(
    "trading_find_arbitrage",
    "Check whether best prices from different bookmakers make a risk-free book, and split the stake so every outcome returns the same. Give it every outcome of one market, each at the best price you can actually get.",
    {
      outcomes: z.array(z.object({
        name: z.string().describe('Outcome label, e.g. "Draw"'),
        odds: z.number().gt(1).describe("Best decimal odds available"),
        bookmaker: z.string().optional().describe("Where that price is"),
      })).min(2).max(20).describe("Every outcome of the market, at its best price"),
      total_stake: z.number().positive().optional().describe("Total to invest across all legs (default 100)"),
      commission_pct: z.number().min(0).lt(100).optional().describe("Exchange commission on net winnings, % (default 0)"),
    },
    safe(async ({ outcomes, total_stake, commission_pct }) => {
      const result = arbitrage(outcomes, total_stake ?? 100, (commission_pct ?? 0) / 100);
      return toolResult({
        ...result,
        verdict: result.is_arbitrage
          ? `Arbitrage: ${result.profit_pct}% on turnover, guaranteed across all outcomes.`
          : `No arbitrage — the book is ${result.margin_pct}% over. You need prices ${round((result.booksum - 1) * 100, 2)}% better in total.`,
        caveats: result.is_arbitrage
          ? ["Prices move: place every leg or none.", "Stake limits, voided legs and account restrictions are the real risk here, not the maths."]
          : undefined,
      });
    }),
  );

  // 5. hedge / green-up
  server.tool(
    "trading_hedge_position",
    "Close out an open back or lay position: the stake that locks the same profit whichever way the match goes (green-up), what a partial hedge leaves you with, and what happens if you let it ride. Handles exchange commission.",
    {
      side: z.enum(["back", "lay"]).describe("The position you already hold"),
      stake: z.number().positive().describe("Stake of the position you hold"),
      odds: z.number().gt(1).describe("Decimal odds you took"),
      hedge_odds: z.number().gt(1).describe("Price now available on the opposite side"),
      hedge_stake: z.number().positive().optional().describe("Hedge only this much (default: the full green-up stake)"),
      commission_pct: z.number().min(0).lt(100).optional().describe("Exchange commission on net winnings, % (default 0, e.g. 2 for Betfair)"),
    },
    safe(async ({ side, stake, odds, hedge_odds, hedge_stake, commission_pct }) =>
      toolResult(hedge({
        side, stake, odds, hedge_odds, hedge_stake,
        commission: (commission_pct ?? 0) / 100,
      })),
    ),
  );

  // 6. Poisson match model
  server.tool(
    "trading_poisson_model",
    "Price a football match from expected goals: 1X2, over/under, both-teams-to-score and correct score, as probabilities and fair odds. Optionally compare against market odds to get the edge on every outcome. Dixon-Coles low-score correction supported via rho.",
    {
      home_xg: z.number().positive().describe("Expected goals for the home side, e.g. 1.6"),
      away_xg: z.number().positive().describe("Expected goals for the away side, e.g. 1.1"),
      rho: z.number().gte(-0.3).lte(0.3).optional().describe("Dixon-Coles low-score correction (default 0; -0.1 to -0.15 is typical for football)"),
      market_odds: z.object({
        home: z.number().gt(1).optional(),
        draw: z.number().gt(1).optional(),
        away: z.number().gt(1).optional(),
        over25: z.number().gt(1).optional(),
        under25: z.number().gt(1).optional(),
      }).optional().describe("Optional market prices to compare the model against"),
      commission_pct: z.number().min(0).lt(100).optional().describe("Exchange commission on net winnings, % (default 0)"),
    },
    safe(async ({ home_xg, away_xg, rho, market_odds, commission_pct }) => {
      const model = matchModel(home_xg, away_xg, { rho: rho ?? 0 });
      let comparison;
      if (market_odds) {
        const probs: Record<string, number> = {
          home: model.probabilities.home,
          draw: model.probabilities.draw,
          away: model.probabilities.away,
          over25: model.probabilities.over["2.5"],
          under25: model.probabilities.under["2.5"],
        };
        const selections = Object.entries(market_odds)
          .filter(([key, value]) => typeof value === "number" && probs[key] !== undefined)
          .map(([key, value]) => ({ name: key, odds: value as number, probability: probs[key] }));
        if (selections.length) {
          comparison = assessSelections(selections, { commission: (commission_pct ?? 0) / 100 });
        }
      }
      return toolResult({
        ...model,
        ...(comparison ? { market_comparison: comparison.assessments, best_bet: comparison.best } : {}),
        note: "Independent Poisson with an optional Dixon-Coles correction. It knows nothing about injuries, motivation or red cards — it is a baseline to price against, not a prediction.",
      });
    }),
  );

  // 7. team ratings from historical results (+ optional fixture pricing)
  server.tool(
    "trading_team_ratings",
    "Fit attack/defence strengths for a league from football-data.co.uk results, and optionally price a fixture with them (Poisson) and compare to market odds. Attack/defence are relative to the league venue average: 1.0 = average, 1.3 = 30% better.",
    {
      league: z.string().min(1).max(4).describe('League code, e.g. "I1" (Serie A). See trading_list_strategies.'),
      season: z.string().regex(/^\d{4}$/).describe('Season code, e.g. "2425"'),
      extra_seasons: z.string().optional().describe('Comma-separated earlier seasons to pool in, e.g. "2324,2223" — more data, staler form'),
      half_life_days: z.number().positive().optional().describe("Recency weighting: a result this many days old counts half (default: no decay)"),
      prior_matches: z.number().min(0).max(50).optional().describe("Shrinkage toward league average, in matches of prior weight (default 4)"),
      as_of: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Only use matches played before this date (YYYY-MM-DD) — use it to avoid lookahead"),
      home: z.string().optional().describe("Home team to price (exact name as it appears in the data)"),
      away: z.string().optional().describe("Away team to price"),
      rho: z.number().gte(-0.3).lte(0.3).optional().describe("Dixon-Coles correction for the fixture model (default 0)"),
      market_odds: z.object({
        home: z.number().gt(1).optional(),
        draw: z.number().gt(1).optional(),
        away: z.number().gt(1).optional(),
        over25: z.number().gt(1).optional(),
        under25: z.number().gt(1).optional(),
      }).optional().describe("Market prices for the fixture, to get the edge per outcome"),
    },
    safe(async (args) => {
      const league = args.league.toUpperCase();
      const seasons = [args.season, ...(args.extra_seasons ? splitList(args.extra_seasons) : [])];
      const matches: FdMatch[] = [];
      for (const season of seasons) {
        const rows = await fetchLeagueSeason(league, season);
        matches.push(...toMatches(rows, league, season));
      }
      const cutoff = args.as_of ? Date.parse(`${args.as_of}T00:00:00Z`) : undefined;
      const used: RatedMatch[] = matches
        .filter((m) => cutoff === undefined || m.ts < cutoff)
        .map((m) => ({ home: m.home, away: m.away, homeGoals: m.homeGoals, awayGoals: m.awayGoals, ts: m.ts }));

      if (used.length === 0) {
        return errorResult(`No completed matches for ${league} ${seasons.join(",")}${args.as_of ? ` before ${args.as_of}` : ""}. Check the league and season codes with trading_list_strategies.`);
      }

      const fit = fitRatings(used, {
        half_life_days: args.half_life_days ?? null,
        prior_matches: args.prior_matches,
        as_of: cutoff,
      });
      const table = [...fit.teams.values()].sort((a, b) => b.attack / b.defence - a.attack / a.defence);

      let fixture;
      if (args.home && args.away) {
        const xg = expectedGoals(fit, args.home, args.away);
        if (!xg) {
          const known = table.map((t) => t.team).join(", ");
          return errorResult(`Unknown team in this dataset: "${!fit.teams.has(args.home) ? args.home : args.away}". Teams available: ${known}`);
        }
        const model = matchModel(xg.home, xg.away, { rho: args.rho ?? 0 });
        let comparison;
        if (args.market_odds) {
          const probs: Record<string, number> = {
            home: model.probabilities.home, draw: model.probabilities.draw, away: model.probabilities.away,
            over25: model.probabilities.over["2.5"], under25: model.probabilities.under["2.5"],
          };
          const selections = Object.entries(args.market_odds)
            .filter(([key, value]) => typeof value === "number" && probs[key] !== undefined)
            .map(([key, value]) => ({ name: key, odds: value as number, probability: probs[key] }));
          if (selections.length) comparison = assessSelections(selections, {});
        }
        fixture = {
          home: args.home, away: args.away,
          ...model,
          ...(comparison ? { market_comparison: comparison.assessments, best_bet: comparison.best } : {}),
        };
      }

      return toolResult({
        league,
        league_name: FD_LEAGUES[league] ?? league,
        seasons,
        matches_used: fit.matches_used,
        ...(args.as_of ? { as_of: args.as_of } : {}),
        league_averages: {
          home_goals: fit.home_goal_avg,
          away_goals: fit.away_goal_avg,
          home_advantage: fit.home_advantage,
        },
        half_life_days: fit.half_life_days,
        prior_matches: fit.prior_matches,
        ratings: table,
        ...(fixture ? { fixture } : {}),
        note: "Ratings come from goals only. A team that has played three games is mostly prior, not signal — that is the shrinkage doing its job.",
      });
    }),
  );

  // 8. backtest — the core of the toolkit
  server.tool(
    "trading_backtest",
    "Backtest a football betting strategy on real historical results and bookmaker odds (football-data.co.uk, 2000-now, 20+ leagues). Returns ROI, P&L, strike rate, max drawdown, closing-line value and per-season/per-league breakdowns. Use trading_list_strategies first to pick a strategy.",
    {
      strategy: z.enum(STRATEGIES).describe("Strategy to test — see trading_list_strategies"),
      leagues: z.string().optional().describe('Comma-separated league codes, e.g. "E0,I1,SP1" (default "E0")'),
      seasons: z.string().optional().describe('Comma-separated season codes, e.g. "2223,2324,2425" (default: the last 3 seasons)'),
      phase: z.enum(["open", "close"]).optional().describe("Price to bet at: open or close (default close; clv_steam always bets the open)"),
      book: z.enum(["avg", "max", "b365", "pinnacle"]).optional().describe("Price source (default avg — market average, the realistic choice)"),
      min_odds: z.number().gt(1).optional().describe("Skip bets below this price"),
      max_odds: z.number().gt(1).optional().describe("Skip bets above this price"),
      edge_pct: z.number().min(0).max(100).optional().describe("Minimum model edge to fire, for value_model/clv_steam (default 5)"),
      markets: z.enum(["1x2", "ou25", "both"]).optional().describe("Markets value_model may bet (default 1x2)"),
      min_history: z.number().int().min(2).max(40).optional().describe("Matches each team must have played before value_model bets on it (default 6)"),
      half_life_days: z.number().positive().optional().describe("Recency weighting for the model's ratings (default: no decay)"),
      rho: z.number().gte(-0.3).lte(0.3).optional().describe("Dixon-Coles correction for the model (default 0)"),
      staking: z.enum(["flat", "percent", "kelly"]).optional().describe("Stake plan (default flat)"),
      unit: z.number().positive().optional().describe("Flat stake per bet (default 1)"),
      percent: z.number().gt(0).lte(25).optional().describe("Percent-of-bankroll stake (default 2)"),
      kelly_fraction: z.number().gt(0).lte(1).optional().describe("Fraction of full Kelly (default 0.25)"),
      max_stake_pct: z.number().gt(0).lte(100).optional().describe("Cap per bet as % of bankroll, for kelly/percent (default 5)"),
      bankroll: z.number().positive().optional().describe("Starting bankroll (default 100)"),
      commission_pct: z.number().min(0).lt(100).optional().describe("Commission on winnings, % (default 0)"),
      sample_bets: z.number().int().min(0).max(50).optional().describe("How many example bets to return (default 8)"),
    },
    safe(async (args) => {
      const strategy = args.strategy as Strategy;
      const leagues = (args.leagues ? splitList(args.leagues) : ["E0"]).map((l) => l.toUpperCase());
      const seasons = args.seasons ? splitList(args.seasons) : recentSeasons(3);
      if (leagues.length * seasons.length > 20) {
        return errorResult(`${leagues.length} leagues x ${seasons.length} seasons = ${leagues.length * seasons.length} files, over the 20-file cap. Narrow the request and run it again.`);
      }
      for (const season of seasons) {
        if (!/^\d{4}$/.test(season)) return errorResult(`Invalid season code "${season}" — use 4 digits, e.g. "2425".`);
      }

      if ((args.staking ?? "flat") === "kelly" && strategy !== "value_model" && strategy !== "clv_steam") {
        return errorResult(`Kelly staking needs a model probability, which "${strategy}" does not produce. Use staking "flat" or "percent", or run value_model / clv_steam.`);
      }

      const book = (args.book ?? "avg") as Book;
      const phase: OddsPhase = strategy === "clv_steam" ? "open" : (args.phase ?? "close");
      const edgeThreshold = (args.edge_pct ?? 5) / 100;
      const commission = (args.commission_pct ?? 0) / 100;
      const minHistory = args.min_history ?? 6;
      const markets = args.markets ?? "1x2";

      // ---- load ----
      const groups: Array<{ league: string; season: string; matches: FdMatch[] }> = [];
      const unavailable: string[] = [];
      for (const league of leagues) {
        for (const season of seasons) {
          try {
            const rows = await fetchLeagueSeason(league, season);
            const matches = toMatches(rows, league, season, book);
            if (matches.length) groups.push({ league, season, matches });
            else unavailable.push(`${league} ${season} (no completed matches)`);
          } catch (err) {
            unavailable.push(`${league} ${season} (${err instanceof Error ? err.message.slice(0, 80) : "fetch failed"})`);
          }
        }
      }
      if (groups.length === 0) {
        return errorResult(`No data for ${leagues.join(",")} x ${seasons.join(",")}. ${unavailable.join("; ")}`);
      }

      // ---- select bets ----
      const candidates: Candidate[] = [];
      let missingPrices = 0;
      let phaseFallbacks = 0;

      const priceOf = (m: FdMatch, outcome: FdOutcome, want: OddsPhase) => {
        const direct = m.prices[want][outcome];
        if (direct) return { ...direct, phase: want };
        const other: OddsPhase = want === "close" ? "open" : "close";
        const fallback = m.prices[other][outcome];
        if (fallback) { phaseFallbacks++; return { ...fallback, phase: other }; }
        return undefined;
      };

      for (const group of groups) {
        if (strategy === "value_model") {
          const history: RatedMatch[] = [];
          const played = new Map<string, number>();
          for (const m of group.matches) {
            const ready = (played.get(m.home) ?? 0) >= minHistory && (played.get(m.away) ?? 0) >= minHistory;
            if (ready) {
              const fit: RatingsFit = fitRatings(history, {
                half_life_days: args.half_life_days ?? null,
                as_of: m.ts,
              });
              const xg = expectedGoals(fit, m.home, m.away);
              if (xg) {
                const model = matchModel(xg.home, xg.away, { rho: args.rho ?? 0 });
                const wanted: Array<[FdOutcome, number]> = [];
                if (markets !== "ou25") {
                  wanted.push(["H", model.probabilities.home], ["D", model.probabilities.draw], ["A", model.probabilities.away]);
                }
                if (markets !== "1x2") {
                  wanted.push(["O25", model.probabilities.over["2.5"]], ["U25", model.probabilities.under["2.5"]]);
                }
                let best: Candidate | undefined;
                for (const [outcome, probability] of wanted) {
                  const price = priceOf(m, outcome, phase);
                  if (!price) { missingPrices++; continue; }
                  const edge = probability * (1 + (price.odds - 1) * (1 - commission)) - 1;
                  if (edge >= edgeThreshold && (!best || edge > (best.edge as number))) {
                    best = { match: m, outcome, odds: price.odds, book: price.book, phase: price.phase, probability, edge,
                      closeOdds: m.prices.close[outcome]?.odds };
                  }
                }
                if (best) candidates.push(best);
              }
            }
            history.push({ home: m.home, away: m.away, homeGoals: m.homeGoals, awayGoals: m.awayGoals, ts: m.ts });
            played.set(m.home, (played.get(m.home) ?? 0) + 1);
            played.set(m.away, (played.get(m.away) ?? 0) + 1);
          }
          continue;
        }

        for (const m of group.matches) {
          let picks: FdOutcome[];
          if (strategy === "home") picks = ["H"];
          else if (strategy === "draw") picks = ["D"];
          else if (strategy === "away") picks = ["A"];
          else if (strategy === "over25") picks = ["O25"];
          else if (strategy === "under25") picks = ["U25"];
          else if (strategy === "favourite" || strategy === "underdog") {
            const priced = (["H", "D", "A"] as FdOutcome[])
              .map((o) => ({ o, p: priceOf(m, o, phase) }))
              .filter((x) => x.p !== undefined) as Array<{ o: FdOutcome; p: { odds: number; book: Book; phase: OddsPhase } }>;
            if (priced.length < 3) { missingPrices++; continue; }
            const sorted = priced.sort((a, b) => a.p.odds - b.p.odds);
            // Take the price already resolved above rather than looking it up
            // again, which would double-count the phase-fallback diagnostic.
            const pick = strategy === "favourite" ? sorted[0] : sorted[sorted.length - 1];
            candidates.push({ match: m, outcome: pick.o, odds: pick.p.odds, book: pick.p.book, phase: pick.p.phase,
              closeOdds: m.prices.close[pick.o]?.odds });
            continue;
          } else if (strategy === "clv_steam") {
            const closing = (["H", "D", "A"] as FdOutcome[]).map((o) => m.prices.close[o]?.odds);
            const opening = (["H", "D", "A"] as FdOutcome[]).map((o) => m.prices.open[o]?.odds);
            if (closing.some((o) => o === undefined) || opening.some((o) => o === undefined)) { missingPrices++; continue; }
            const fair = devig(closing as number[], "shin").probabilities;
            let best: Candidate | undefined;
            (["H", "D", "A"] as FdOutcome[]).forEach((outcome, i) => {
              const odds = (opening as number[])[i];
              const probability = fair[i];
              const edge = probability * (1 + (odds - 1) * (1 - commission)) - 1;
              if (edge >= edgeThreshold && (!best || edge > (best.edge as number))) {
                best = { match: m, outcome, odds, book: m.prices.open[outcome]?.book ?? book, phase: "open",
                  probability, edge, closeOdds: (closing as number[])[i] };
              }
            });
            if (best) candidates.push(best);
            continue;
          } else picks = [];

          for (const outcome of picks) {
            const price = priceOf(m, outcome, phase);
            if (!price) { missingPrices++; continue; }
            candidates.push({ match: m, outcome, odds: price.odds, book: price.book, phase: price.phase,
              closeOdds: m.prices.close[outcome]?.odds });
          }
        }
      }

      // ---- filter, stake, settle ----
      const filtered = candidates
        .filter((c) => (args.min_odds === undefined || c.odds >= args.min_odds))
        .filter((c) => (args.max_odds === undefined || c.odds <= args.max_odds))
        .sort((a, b) => a.match.ts - b.match.ts);

      const staking = args.staking ?? "flat";
      const startBankroll = args.bankroll ?? 100;
      const unit = args.unit ?? 1;
      const maxStakePct = (args.max_stake_pct ?? 5) / 100;
      let bankroll = startBankroll;
      let peak = startBankroll;
      let maxDrawdown = 0;
      let staked = 0, pnl = 0, wins = 0, oddsSum = 0, edgeSum = 0, edgeCount = 0;
      let clvSum = 0, clvCount = 0, clvBeat = 0;
      let losingRun = 0, longestLosingRun = 0, skippedAfterBust = 0;
      const bySeason = new Map<string, { bets: number; staked: number; pnl: number }>();
      const byLeague = new Map<string, { bets: number; staked: number; pnl: number }>();
      const curve: Array<{ date: string; bankroll: number }> = [];
      const settled: Array<Record<string, unknown>> = [];

      for (const c of filtered) {
        let stake: number;
        if (staking === "flat") stake = unit;
        else if (staking === "percent") stake = bankroll * ((args.percent ?? 2) / 100);
        else {
          const f = kelly(c.odds, c.probability as number, commission) * (args.kelly_fraction ?? 0.25);
          stake = bankroll * Math.max(0, Math.min(f, maxStakePct));
        }
        // Going bust ends the run: the remaining bets are reported, not silently
        // settled against a negative bankroll.
        if (bankroll <= 0) { skippedAfterBust++; continue; }
        if (!(stake > 0)) continue;

        const win = won(c.match, c.outcome);
        const profit = win ? stake * (c.odds - 1) * (1 - commission) : -stake;
        bankroll += profit;
        staked += stake;
        pnl += profit;
        oddsSum += c.odds;
        if (win) { wins++; losingRun = 0; }
        else { losingRun++; longestLosingRun = Math.max(longestLosingRun, losingRun); }
        if (c.edge !== undefined) { edgeSum += c.edge; edgeCount++; }
        if (c.closeOdds !== undefined && c.phase === "open") {
          const clv = c.odds / c.closeOdds - 1;
          clvSum += clv; clvCount++;
          if (clv > 0) clvBeat++;
        }
        peak = Math.max(peak, bankroll);
        maxDrawdown = Math.max(maxDrawdown, peak > 0 ? (peak - bankroll) / peak : 0);

        const s = bySeason.get(c.match.season) ?? { bets: 0, staked: 0, pnl: 0 };
        s.bets++; s.staked += stake; s.pnl += profit; bySeason.set(c.match.season, s);
        const l = byLeague.get(c.match.league) ?? { bets: 0, staked: 0, pnl: 0 };
        l.bets++; l.staked += stake; l.pnl += profit; byLeague.set(c.match.league, l);

        curve.push({ date: c.match.date, bankroll });
        settled.push({
          date: c.match.date,
          league: c.match.league,
          match: `${c.match.home} v ${c.match.away}`,
          score: `${c.match.homeGoals}-${c.match.awayGoals}`,
          selection: MARKET_LABEL[c.outcome],
          odds: asOdds(c.odds),
          book: c.book,
          phase: c.phase,
          ...(c.probability !== undefined ? { model_probability: asProb(c.probability) } : {}),
          ...(c.edge !== undefined ? { edge_pct: asPct(c.edge) } : {}),
          ...(c.closeOdds !== undefined ? { closing_odds: asOdds(c.closeOdds) } : {}),
          stake: round(stake, 2),
          result: win ? "won" : "lost",
          pnl: round(profit, 2),
        });
      }

      const bets = settled.length;
      const sampleCount = args.sample_bets ?? 8;
      const step = bets > 20 ? Math.ceil(bets / 20) : 1;
      const equityCurve = curve.filter((_, i) => i % step === 0 || i === curve.length - 1)
        .map((p) => ({ date: p.date, bankroll: round(p.bankroll, 2) }));

      const breakdown = (m: Map<string, { bets: number; staked: number; pnl: number }>) =>
        Object.fromEntries([...m.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, {
          bets: v.bets, pnl: round(v.pnl, 2), roi_pct: v.staked > 0 ? asPct(v.pnl / v.staked) : 0,
        }]));

      const matchesScanned = groups.reduce((a, g) => a + g.matches.length, 0);

      return toolResult({
        strategy,
        description: STRATEGY_DOCS[strategy],
        config: {
          leagues, seasons, phase, book, staking,
          ...(staking === "flat" ? { unit } : {}),
          ...(staking === "percent" ? { percent: args.percent ?? 2 } : {}),
          ...(staking === "kelly" ? { kelly_fraction: args.kelly_fraction ?? 0.25, max_stake_pct: args.max_stake_pct ?? 5 } : {}),
          ...(strategy === "value_model" || strategy === "clv_steam" ? { edge_pct: args.edge_pct ?? 5 } : {}),
          ...(strategy === "value_model" ? { markets, min_history: minHistory, half_life_days: args.half_life_days ?? null, rho: args.rho ?? 0 } : {}),
          ...(args.min_odds !== undefined ? { min_odds: args.min_odds } : {}),
          ...(args.max_odds !== undefined ? { max_odds: args.max_odds } : {}),
          commission_pct: args.commission_pct ?? 0,
        },
        coverage: {
          matches_scanned: matchesScanned,
          bets_placed: bets,
          bet_rate_pct: matchesScanned ? asPct(bets / matchesScanned) : 0,
          ...(missingPrices ? { skipped_no_price: missingPrices } : {}),
          ...(phaseFallbacks ? { phase_fallbacks: phaseFallbacks, phase_fallback_note: `${phaseFallbacks} prices fell back to the other phase — seasons before 2019/20 have no separate closing columns.` } : {}),
          ...(unavailable.length ? { unavailable } : {}),
        },
        results: bets === 0 ? null : {
          bets,
          wins,
          strike_rate_pct: asPct(wins / bets),
          average_odds: round(oddsSum / bets, 3),
          total_staked: round(staked, 2),
          profit: round(pnl, 2),
          roi_pct: asPct(pnl / staked),
          bankroll_start: round(startBankroll, 2),
          bankroll_end: round(bankroll, 2),
          growth_pct: asPct(bankroll / startBankroll - 1),
          max_drawdown_pct: asPct(maxDrawdown),
          longest_losing_run: longestLosingRun,
          ...(skippedAfterBust ? {
            went_bust: true,
            bets_skipped_after_bust: skippedAfterBust,
            bust_note: "The bankroll hit zero — the remaining qualifying bets were not settled. The ROI above covers only the bets actually placed.",
          } : {}),
          ...(edgeCount ? { average_model_edge_pct: asPct(edgeSum / edgeCount) } : {}),
          ...(clvCount ? {
            closing_line_value: {
              bets_measured: clvCount,
              average_clv_pct: asPct(clvSum / clvCount),
              beat_the_close_pct: asPct(clvBeat / clvCount),
            },
          } : {}),
        },
        by_season: breakdown(bySeason),
        by_league: breakdown(byLeague),
        equity_curve: equityCurve,
        sample_bets: settled.slice(0, sampleCount),
        caveats: [
          "Assumes you got the listed price on every qualifying match, with no stake limits and no movement between reading the price and betting.",
          bets < 200 ? `${bets} bets is a small sample — at these odds the result is mostly noise.` : "Sample size is reasonable, but one league-season is still one path through a random process.",
          "Re-running variations until one shows a profit is how backtests lie. Confirm any edge on seasons you did not tune on.",
        ],
      });
    }),
  );

  // 9. closing-line value on bets you actually made
  server.tool(
    "trading_closing_line_value",
    "Measure your bets against the closing line — the single best evidence that a betting process has an edge, ahead of P&L. Give it the price you took and the closing price for each bet; outcomes are optional.",
    {
      bets: z.array(z.object({
        name: z.string().optional().describe('Label, e.g. "Roma v Lazio — Over 2.5"'),
        odds_taken: z.number().gt(1).describe("Decimal odds you got"),
        closing_odds: z.number().gt(1).describe("Decimal odds at kick-off"),
        stake: z.number().positive().optional().describe("Stake (default 1)"),
        won: z.boolean().optional().describe("Whether the bet won — omit to skip P&L"),
      })).min(1).max(200).describe("Your bets"),
      closing_margin_pct: z.number().min(0).max(30).optional().describe("Bookmaker margin in the closing price, % — used to convert the close into a fair probability (default 0, i.e. treat the close as fair)"),
      commission_pct: z.number().min(0).lt(100).optional().describe("Commission on winnings, % (default 0)"),
    },
    safe(async ({ bets, closing_margin_pct, commission_pct }) => {
      const margin = 1 + (closing_margin_pct ?? 0) / 100;
      const commission = (commission_pct ?? 0) / 100;
      let clvSum = 0, beat = 0, staked = 0, pnl = 0, settledCount = 0, wins = 0, evSum = 0;
      const rows = bets.map((b, i) => {
        const stake = b.stake ?? 1;
        const clv = b.odds_taken / b.closing_odds - 1;
        const fairProb = Math.min(0.999999, (1 / b.closing_odds) / margin);
        const ev = fairProb * (1 + (b.odds_taken - 1) * (1 - commission)) - 1;
        clvSum += clv;
        if (clv > 0) beat++;
        staked += stake;
        evSum += ev * stake;
        let pl: number | undefined;
        if (b.won !== undefined) {
          pl = b.won ? stake * (b.odds_taken - 1) * (1 - commission) : -stake;
          pnl += pl;
          settledCount++;
          if (b.won) wins++;
        }
        return {
          name: b.name ?? `bet_${i + 1}`,
          odds_taken: asOdds(b.odds_taken),
          closing_odds: asOdds(b.closing_odds),
          clv_pct: asPct(clv),
          fair_probability: asProb(fairProb),
          expected_value_pct: asPct(ev),
          stake: round(stake, 2),
          ...(pl !== undefined ? { result: b.won ? "won" : "lost", pnl: round(pl, 2) } : {}),
        };
      });
      const avgClv = clvSum / bets.length;
      return toolResult({
        bets: bets.length,
        average_clv_pct: asPct(avgClv),
        beat_the_close_pct: asPct(beat / bets.length),
        expected_roi_pct: staked > 0 ? asPct(evSum / staked) : 0,
        ...(settledCount ? {
          realized: {
            settled: settledCount,
            wins,
            strike_rate_pct: asPct(wins / settledCount),
            profit: round(pnl, 2),
            roi_pct: asPct(pnl / staked),
          },
        } : {}),
        verdict: avgClv > 0.01
          ? "Beating the close on average. Over a few hundred bets that is the strongest evidence of a real edge — stronger than a winning P&L over the same sample."
          : avgClv > -0.01
            ? "Roughly level with the close. Your process is tracking the market, not beating it; P&L over this sample is mostly variance."
            : "Losing to the close. Whatever the P&L says, the prices you took were worse than the market's final word.",
        detail: rows,
      });
    }),
  );
}
