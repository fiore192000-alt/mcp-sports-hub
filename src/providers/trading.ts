import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { errorResult, safe, toolResult } from "../shared/http.js";
import {
  BOOKS, FD_LEAGUES, type Book, type FdFixture, type FdMatch, type FdOutcome, type OddsPhase,
  fetchFixtures, fetchLeagueSeason, normalizeTeam, toFixtures, toMatches,
} from "../shared/football-csv.js";
import { type SeasonData, type Source, loadSeasonData, short } from "../shared/football-source.js";
import {
  type DevigMethod, type RatedMatch, type RatingsFit,
  arbitrage, assessSelections, asOdds, asPct, asProb, devig, expectedGoals,
  fitRatings, hedge, kelly, matchModel, round,
  BASE_RATES, brierScore, logLoss, rankedProbabilityScore, type OutcomeIndex,
  applyMargin, edgeRequirements, type MarginMethod,
} from "../shared/betting-math.js";
import { auditSignal, bonferroniBar } from "../shared/evidence.js";
import { consumed, familyPValues, readLedger, verifyToken } from "../shared/research-ledger.js";

// ---------------------------------------------------------------------------
// Trading toolkit — 11 tools
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
  clv_steam: "Closing-line value: bet the OPENING price when it beats the de-vigged CLOSING probability by edge_pct. Measures whether taking early prices beats the market's final word. Needs 2019/20+ seasons, which are the ones carrying separate closing columns. Read its closing-line value with care: this strategy SELECTS on beating the close, so a high average CLV and a 100% beat-the-close rate are its entry rule restated, not evidence of skill. Judge it on ROI.",
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

/** The season currently in progress (European calendar: July starts one). */
function currentSeason(): string {
  const now = new Date();
  return seasonCode(now.getUTCMonth() >= 6 ? now.getUTCFullYear() : now.getUTCFullYear() - 1);
}

/** The season before a given code: "2627" -> "2526". */
function previousSeason(code: string): string {
  const start = Number.parseInt(code.slice(0, 2), 10);
  return `${String((start + 99) % 100).padStart(2, "0")}${String(start).padStart(2, "0")}`;
}

/** Season code covering a date, same July boundary as currentSeason(). */
function seasonForDate(iso: string): string {
  const d = new Date(`${iso}T12:00:00Z`);
  return seasonCode(d.getUTCMonth() >= 6 ? d.getUTCFullYear() : d.getUTCFullYear() - 1);
}

/** Outcome keys as they appear in a prediction row. */
const PICK_OUTCOMES = { home: "H", draw: "D", away: "A", over25: "O25", under25: "U25" } as const;
type PickKey = keyof typeof PICK_OUTCOMES;

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

  // 2b. price a market — the inverse of de-vigging
  server.tool(
    "trading_price_market",
    "Turn fair probabilities into the odds a bookmaker would display, by adding a margin rather than removing one. The inverse of trading_devig_odds. Use it to see what your model's probabilities look like as posted prices, or to check how far a real book's prices sit from your own.",
    {
      probabilities: z.array(z.number().gt(0).lt(1)).min(2).max(40).describe("Fair probabilities for EVERY outcome of one market; they must sum to 1"),
      names: z.array(z.string()).optional().describe('Optional labels aligned with the probabilities, e.g. ["Home","Draw","Away"]'),
      margin_pct: z.number().min(0).max(100).optional().describe("Margin to add, % (default 5 — roughly what a mainstream book posts on a 1X2 market; the best price across books leaves about 1.2%)"),
      method: z.enum(["power", "proportional", "additive"]).optional().describe("How the margin is spread (default power). power loads the longshots hardest, which is what real books do; proportional taxes every outcome equally; additive splits it evenly in probability."),
    },
    safe(async ({ probabilities, names, margin_pct, method }) =>
      toolResult({
        ...applyMargin(probabilities, margin_pct ?? 5, (method ?? "power") as MarginMethod, names),
        note: "Posted odds are rounded to the increments books display. `odds_cut_pct` is how far each price sits below its fair value — the only reading that shows who carries the margin. Under the power method the longshot is cut hardest and the favourite barely at all, which is the favourite-longshot bias seen from the bookmaker's side.",
      }),
    ),
  );

  // 2c. what it would take for this to be profitable
  server.tool(
    "trading_edge_requirements",
    "The conditions a bet has to meet to make money, as arithmetic: the hit rate that breaks even, the hit rate your claimed edge implies, how many bets before that edge is distinguishable from luck, the Kelly stake, the risk of ruin at different staking speeds, and the losing run to expect anyway. Use it before trusting a record, and before sizing anything.",
    {
      odds: z.number().gt(1).describe("Decimal odds you are betting at"),
      edge_pct: z.number().gt(0).max(100).optional().describe("The edge you believe you have, % (default 2 — about what the best documented market biases are worth)"),
      commission_pct: z.number().min(0).lt(100).optional().describe("Commission on winnings, % (default 0)"),
      bets_so_far: z.number().int().min(0).optional().describe("How many bets your record covers, if you want it judged against the requirement"),
    },
    safe(async ({ odds, edge_pct, commission_pct, bets_so_far }) => {
      const req = edgeRequirements(odds, edge_pct ?? 2, (commission_pct ?? 0) / 100);
      return toolResult({
        ...req,
        ...(bets_so_far !== undefined ? {
          your_record: {
            bets: bets_so_far,
            verdict: bets_so_far >= req.bets_to_prove.two_sigma
              ? `${bets_so_far} bets is enough to separate a ${req.claimed_edge_pct}% edge from zero at this price.`
              : `${bets_so_far} bets cannot show a ${req.claimed_edge_pct}% edge at this price: ${req.bets_to_prove.two_sigma} are needed. Whatever the record says so far, it is consistent with having no edge at all.`,
          },
        } : {}),
        notes: [
          `Break-even is ${req.break_even_hit_rate_pct}%: below that hit rate the bet loses money however good it feels. A high hit rate is a property of short odds, not of skill.`,
          "Ruin risk uses the standard fractional-Kelly result and assumes the edge is real and known. If the edge is smaller than you think, every number here is optimistic.",
          `Expect a losing run of about ${req.expected_longest_losing_run_per_1000} in every 1000 bets at this hit rate, with no edge lost.`,
        ],
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

  // 10. predict upcoming fixtures
  server.tool(
    "trading_predict_fixtures",
    "Predict upcoming football fixtures: fits team ratings on the season so far, prices every match in the next few days (1X2, over/under), compares against the bookmakers' own prices where they are available, and flags where the model disagrees enough to bet. Works without any API key, and falls back to a keyless GitHub-hosted results mirror when the odds archive is unreachable. Returns prediction rows you can feed straight back into trading_score_predictions once the matches are played.",
    {
      leagues: z.string().optional().describe('Comma-separated league codes, e.g. "I1,E0" (default "E0"). Max 8.'),
      season: z.string().regex(/^\d{4}$/).optional().describe('Season to rate teams from, e.g. "2627" (default: the season in progress)'),
      include_previous_season: z.boolean().optional().describe("Pool the previous season into the ratings (default true — essential early on, when the current season is only a few rounds old)"),
      half_life_days: z.number().positive().optional().describe("Recency weighting: a result this many days old counts half (default 240)"),
      prior_matches: z.number().min(0).max(50).optional().describe("Shrinkage toward league average, in matches of prior weight (default 4)"),
      rho: z.number().gte(-0.3).lte(0.3).optional().describe("Dixon-Coles low-score correction (default -0.1)"),
      book: z.enum(["avg", "max", "b365", "pinnacle"]).optional().describe("Which market price to compare against (default avg)"),
      days_ahead: z.number().int().min(1).max(30).optional().describe("Only fixtures kicking off within this many days (default 10)"),
      min_edge_pct: z.number().min(0).max(100).optional().describe("Edge required before a fixture gets a suggested pick (default 5). Only matters when suggest_picks is on."),
      suggest_picks: z.boolean().optional().describe("Turn the model's disagreements with the market into suggested bets with stakes (default FALSE). Measured over 679 Premier League matches with real prices, betting this model's disagreements lost 14-27% of turnover at every edge threshold, with closing-line value around -6.5%. Turn it on only with a model you have measured yourself."),
      markets: z.enum(["1x2", "ou25", "both"]).optional().describe("Markets to consider for the pick (default both)"),
      bankroll: z.number().positive().optional().describe("Bankroll for stake sizing (default 100)"),
      kelly_fraction: z.number().gt(0).lte(1).optional().describe("Fraction of full Kelly (default 0.25)"),
      max_stake_pct: z.number().gt(0).lte(100).optional().describe("Cap per bet as % of bankroll (default 5)"),
      limit: z.number().int().min(1).max(60).optional().describe("Max fixtures to return (default 20)"),
      rate_promoted: z.boolean().optional().describe("Price fixtures involving a team with no history in the rated seasons, using the promoted-team prior below (default true). Turn it off to have them reported as `unrated` instead of predicted on an assumption."),
      promoted_attack: z.number().gt(0).lte(2).optional().describe("Attack strength assumed for a team with no history, 1.0 = league average (default 0.85)"),
      promoted_defence: z.number().gt(0).lte(2).optional().describe("Defence strength assumed for a team with no history, 1.0 = league average, higher concedes more (default 1.15)"),
      source: z.enum(["auto", "footballdata", "openfootball"]).optional().describe('Data source (default auto): "footballdata" = football-data.co.uk, results + odds, roughly a week of fixtures; "openfootball" = keyless GitHub mirror, full season calendar but NO odds, so no market comparison and no picks; "auto" prefers the first and falls back to the second.'),
    },
    safe(async (args) => {
      const leagues = (args.leagues ? splitList(args.leagues) : ["E0"]).map((l) => l.toUpperCase());
      if (leagues.length > 8) return errorResult(`${leagues.length} leagues requested; the cap is 8 per call.`);
      const season = args.season ?? currentSeason();
      const includePrevious = args.include_previous_season ?? true;
      const book = (args.book ?? "avg") as Book;
      const rho = args.rho ?? -0.1;
      const minEdge = args.min_edge_pct ?? 5;
      const markets = args.markets ?? "both";
      const now = Date.now();
      const horizon = now + (args.days_ahead ?? 10) * 86_400_000;

      const source = (args.source ?? "auto") as Source;

      // Ratings and fixtures, per league, from whichever source answers.
      const fits = new Map<string, RatingsFit>();
      const ratingNotes: string[] = [];
      const sourcesUsed = new Set<string>();
      const coverage: Record<string, unknown> = {};
      const seasons = includePrevious ? [previousSeason(season), season] : [season];
      const perLeagueFixtures: FdFixture[] = [];
      let fdFixtures: FdFixture[] | undefined;

      for (const league of leagues) {
        const rated: RatedMatch[] = [];
        let used: "footballdata" | "openfootball" | undefined;
        let currentFixtures: FdFixture[] = [];
        for (const code of seasons) {
          try {
            const data = await loadSeasonData(league, code, source, book);
            used = data.used;
            sourcesUsed.add(data.used);
            if (data.note) ratingNotes.push(data.note);
            if (data.coverage && data.coverage.missing_results > 0) coverage[`${league} ${code}`] = data.coverage;
            for (const m of data.played) {
              rated.push({ home: m.home, away: m.away, homeGoals: m.homeGoals, awayGoals: m.awayGoals, ts: m.ts });
            }
            if (code === season) currentFixtures = data.fixtures;
          } catch (err) {
            ratingNotes.push(`${league} ${code}: no data (${short(err)})`);
          }
        }
        if (rated.length) {
          fits.set(league, fitRatings(rated, {
            half_life_days: args.half_life_days ?? 240,
            prior_matches: args.prior_matches,
            as_of: now,
          }));
        }

        if (used === "openfootball") {
          // This source ships the whole season calendar, priced at nothing.
          perLeagueFixtures.push(...currentFixtures);
        } else if (used === "footballdata") {
          // One shared file covers every league, so fetch it at most once.
          if (fdFixtures === undefined) {
            try {
              fdFixtures = toFixtures(await fetchFixtures(), book, leagues);
            } catch (err) {
              fdFixtures = [];
              ratingNotes.push(`Upcoming-fixtures file unreachable (${short(err)}).`);
            }
          }
          perLeagueFixtures.push(...fdFixtures.filter((f) => f.league === league));
        }
      }

      const fixtures = perLeagueFixtures.sort((a, b) => a.ts - b.ts);

      // A fixture dated before today has already been played — the source
      // simply has not recorded the result yet. Predicting it would be
      // hindsight wearing a forecast's clothes, so it is excluded and named.
      const todayStart = Date.UTC(
        new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate(),
      );
      const stale = fixtures
        .filter((f) => f.ts < todayStart)
        .map((f) => ({ date: f.date, league: f.league, match: `${f.home} v ${f.away}` }));
      const upcoming = fixtures
        .filter((f) => f.ts <= horizon && f.ts >= todayStart)
        .slice(0, args.limit ?? 20);

      if (upcoming.length === 0) {
        return toolResult({
          season, leagues,
          source: [...sourcesUsed],
          fixtures_found: fixtures.length,
          predictions: [],
          ...(stale.length ? { already_played: stale.slice(0, 20), already_played_note: `${stale.length} fixture(s) are dated before today and carry no result — the source has not caught up. They are not predictable and were skipped.` } : {}),
          ...(ratingNotes.length ? { rating_notes: ratingNotes } : {}),
          note: fixtures.length
            ? `${fixtures.length} fixture(s) known for ${leagues.join(",")}, none inside the next ${args.days_ahead ?? 10} days. Widen days_ahead.`
            : `No upcoming fixtures for ${leagues.join(",")}. football-data.co.uk's fixtures file covers roughly the next week and is empty mid-break; openfootball carries the full calendar but may not have this league or season.`,
        });
      }

      const bankroll = args.bankroll ?? 100;
      // A side promoted into this league has no history to rate. Measured over
      // 172 such fixtures in the top three leagues, assuming 0.85 attack /
      // 1.15 defence scored RPS 0.191 — better than the model's own average,
      // and far better than declining to predict them. It changes nothing for
      // teams that do have history.
      const promotedPrior = (args.rate_promoted ?? true)
        ? { attack: args.promoted_attack ?? 0.85, defence: args.promoted_defence ?? 1.15 }
        : undefined;
      const predictions: Array<Record<string, unknown>> = [];
      const unrated: Array<Record<string, string>> = [];

      for (const f of upcoming) {
        const fit = fits.get(f.league);
        const missing = fit
          ? [f.home, f.away].filter((team) => !fit.teams.has(team))
          : [];
        // The prior stands in for ONE unknown side. With both unknown the
        // "forecast" would be the prior playing itself: no information, dressed
        // up as a prediction. Decline those.
        const usePrior = promotedPrior && missing.length === 1;
        const xg = fit ? expectedGoals(fit, f.home, f.away, usePrior ? { fallback: promotedPrior } : {}) : null;
        if (!fit || !xg) {
          unrated.push({
            league: f.league, date: f.date, match: `${f.home} v ${f.away}`,
            reason: !fit
              ? "no rated matches for this league/season"
              : missing.length > 1
                ? `neither ${missing.join(" nor ")} has history in the rated seasons — a prediction here would be the promoted-team prior playing itself`
                : `no history in the rated seasons for ${missing.join(" and ")} (newly promoted?) and rate_promoted is off`,
          });
          continue;
        }
        const model = matchModel(xg.home, xg.away, { rho });
        const modelProb: Record<PickKey, number> = {
          home: model.probabilities.home,
          draw: model.probabilities.draw,
          away: model.probabilities.away,
          over25: model.probabilities.over["2.5"],
          under25: model.probabilities.under["2.5"],
        };

        const marketOdds: Partial<Record<PickKey, number>> = {};
        for (const [key, outcome] of Object.entries(PICK_OUTCOMES) as Array<[PickKey, FdOutcome]>) {
          const price = f.prices[outcome]?.odds;
          if (price) marketOdds[key] = asOdds(price);
        }

        // De-vigged market view of the 1X2 market, for a like-for-like comparison.
        let marketProb: Partial<Record<PickKey, number>> = {};
        if (marketOdds.home && marketOdds.draw && marketOdds.away) {
          const fair = devig([marketOdds.home, marketOdds.draw, marketOdds.away], "shin").probabilities;
          marketProb = { home: fair[0], draw: fair[1], away: fair[2] };
        }

        const candidateKeys: PickKey[] = markets === "ou25"
          ? ["over25", "under25"]
          : markets === "1x2" ? ["home", "draw", "away"] : ["home", "draw", "away", "over25", "under25"];
        const selections = candidateKeys
          .filter((k) => marketOdds[k] !== undefined)
          .map((k) => ({ name: k, odds: marketOdds[k] as number, probability: modelProb[k] }));
        const assessed = selections.length && (args.suggest_picks ?? false)
          ? assessSelections(selections, {
              bankroll,
              kelly_fraction: args.kelly_fraction,
              max_stake_pct: args.max_stake_pct,
              min_edge_pct: minEdge,
            })
          : null;

        predictions.push({
          date: f.date,
          ...(f.time ? { time: f.time } : {}),
          ...(f.ts < todayStart + 86_400_000 ? { kicks_off_today: true } : {}),
          league: f.league,
          home: f.home,
          away: f.away,
          expected_goals: { home: round(xg.home, 2), away: round(xg.away, 2) },
          prob_home: asProb(modelProb.home),
          prob_draw: asProb(modelProb.draw),
          prob_away: asProb(modelProb.away),
          prob_over25: asProb(modelProb.over25),
          most_likely: (["home", "draw", "away"] as PickKey[]).reduce((a, b) => (modelProb[b] > modelProb[a] ? b : a)),
          ...(missing.length ? {
            assumed_prior_for: missing,
            assumed_prior: promotedPrior,
          } : {}),
          ...(Object.keys(marketOdds).length ? { market_odds: marketOdds } : {}),
          ...(marketProb.home !== undefined ? {
            market_prob_home: asProb(marketProb.home as number),
            market_prob_draw: asProb(marketProb.draw as number),
            market_prob_away: asProb(marketProb.away as number),
          } : {}),
          ...(assessed?.best ? {
            pick: {
              outcome: assessed.best.name,
              odds: assessed.best.odds,
              edge_pct: assessed.best.edge_pct,
              stake: assessed.best.stake,
            },
          } : {}),
        });
      }

      const withPick = predictions.filter((p) => p.pick !== undefined);
      const hasMarket = predictions.some((p) => p.market_odds !== undefined);
      return toolResult({
        season,
        leagues,
        source: [...sourcesUsed],
        market_data: hasMarket,
        ...(hasMarket ? {} : {
          no_market_note: "This source carries no odds, so there is no market comparison, no edge and no pick — the probabilities are the whole output. Scoring them later still works: hit rate, RPS, Brier, log loss and calibration, benchmarked against base rates instead of the market.",
        }),
        rated_from: includePrevious ? [previousSeason(season), season] : [season],
        model: { half_life_days: args.half_life_days ?? 240, rho, book, min_edge_pct: minEdge, markets },
        fixtures_priced: predictions.length,
        picks_suggested: withPick.length,
        ...(predictions.some((p) => p.assumed_prior_for) ? {
          promoted_prior: promotedPrior,
          promoted_prior_note: "Some fixtures involve a team with no history in the rated seasons; they were priced on the promoted-team prior and each one names it in `assumed_prior_for`. Set rate_promoted false to have them reported as unrated instead.",
        } : {}),
        ...(args.suggest_picks ? {
          picks_warning: "Picks are the model disagreeing with the market. Measured over 679 Premier League matches with real opening prices, doing that lost 13.6% of turnover at a 2% edge threshold and 27.5% at 20%, with mean closing-line value of -6.5%: the larger the disagreement, the more wrong it was. See docs/Evaluation.md. These are not tips.",
        } : {}),
        ...(Object.keys(coverage).length ? {
          data_quality: coverage,
          data_quality_note: "These seasons have matches whose date has passed with no result recorded — holes in the source, not lag. Ratings were fitted on what exists, and predictions on those matches can never be settled.",
        } : {}),
        ...(stale.length ? {
          already_played_skipped: stale.length,
          already_played_note: "Fixtures dated before today with no result recorded yet were skipped — the source lags a few days, and a 'prediction' made after kick-off is worthless.",
        } : {}),
        total_stake: round(withPick.reduce((a, p) => a + ((p.pick as { stake: number }).stake ?? 0), 0), 2),
        predictions,
        ...(unrated.length ? { unrated } : {}),
        ...(ratingNotes.length ? { rating_notes: ratingNotes } : {}),
        next_step: "Save this `predictions` array. Once the matches are played, pass it to trading_score_predictions to see how the model actually did — hit rate, RPS and log loss against the market's own prices, plus the P&L of the picks.",
        caveats: [
          "Ratings come from goals alone: no injuries, suspensions, European fixtures or rotation.",
          "Early in a season the ratings are mostly the previous season plus the prior — expect the market to be better informed than the model until a few rounds are in.",
          "A suggested pick is a model disagreement with the market, not a tip. The market is right more often than it is wrong.",
        ],
      });
    }),
  );

  // 11. score predictions once the matches are played
  server.tool(
    "trading_score_predictions",
    "Score predictions you made earlier against what actually happened: hit rate, ranked probability score and log loss, measured against the bookmakers' own prices as the benchmark, plus calibration and the P&L and closing-line value of any picks. Feed it the `predictions` array from trading_predict_fixtures.",
    {
      predictions: z.array(z.object({
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Match date, YYYY-MM-DD"),
        league: z.string().describe('League code, e.g. "I1"'),
        home: z.string().describe("Home team, as named in the football-data archive"),
        away: z.string().describe("Away team"),
        prob_home: z.number().gt(0).lt(1),
        prob_draw: z.number().gt(0).lt(1),
        prob_away: z.number().gt(0).lt(1),
        market_odds: z.object({
          home: z.number().gt(1).optional(),
          draw: z.number().gt(1).optional(),
          away: z.number().gt(1).optional(),
        }).optional().describe("Prices at prediction time — used as the benchmark to beat"),
        pick: z.object({
          outcome: z.enum(["home", "draw", "away", "over25", "under25"]),
          odds: z.number().gt(1),
          stake: z.number().min(0).optional(),
        }).optional().describe("The bet you took, if any"),
      })).min(1).max(500).describe("Predictions to score — the array trading_predict_fixtures returned. The cap fits one league-season, which is the natural batch for a whole-season review."),
      season: z.string().regex(/^\d{4}$/).optional().describe("Season to look results up in (default: derived from each prediction's date)"),
      source: z.enum(["auto", "footballdata", "openfootball"]).optional().describe("Where to read results from (default auto). Use the same source the predictions came from — team names differ between them."),
      commission_pct: z.number().min(0).lt(100).optional().describe("Commission on winnings, % (default 0)"),
      sample: z.number().int().min(0).max(60).optional().describe("How many scored matches to list individually (default 10)"),
    },
    safe(async ({ predictions, season, source, commission_pct, sample }) => {
      const commission = (commission_pct ?? 0) / 100;
      const src = (source ?? "auto") as Source;

      // Results, one CSV per league-season the predictions touch.
      const needed = new Set(predictions.map((p) => `${p.league.toUpperCase()}|${season ?? seasonForDate(p.date)}`));
      if (needed.size > 20) return errorResult(`These predictions span ${needed.size} league-seasons, over the 20-file cap. Score them in batches.`);
      const results = new Map<string, FdMatch>();
      const scheduled = new Map<string, number>();
      const unavailable: string[] = [];
      const sourcesUsed = new Set<string>();
      for (const key of needed) {
        const [league, code] = key.split("|");
        try {
          const data = await loadSeasonData(league, code, src, "avg");
          sourcesUsed.add(data.used);
          for (const m of data.played) {
            results.set(`${league}|${normalizeTeam(m.home)}|${normalizeTeam(m.away)}`, m);
          }
          // Keep the unplayed ones too, so a pending prediction can say whether
          // the match is still ahead or the source simply never recorded it.
          for (const f of data.fixtures) {
            scheduled.set(`${league}|${normalizeTeam(f.home)}|${normalizeTeam(f.away)}`, f.ts);
          }
        } catch (err) {
          unavailable.push(`${league} ${code} (${short(err)})`);
        }
      }

      // Scoring maths lives in shared/betting-math.ts so the tuning harness
      // and this tool can never report differently scaled numbers.
      const rps = rankedProbabilityScore;
      const brier = brierScore;

      const scored: Array<Record<string, unknown>> = [];
      const pending: Array<Record<string, string>> = [];
      let hits = 0, modelRps = 0, modelBrier = 0, modelLogLoss = 0;
      let marketRps = 0, marketLogLoss = 0, marketCount = 0, marketHits = 0;
      let climRps = 0, climLogLoss = 0;
      let picks = 0, pickWins = 0, staked = 0, pnl = 0, clvSum = 0, clvCount = 0;
      const buckets = new Map<number, { predicted: number; observed: number; n: number }>();

      for (const p of predictions) {
        const league = p.league.toUpperCase();
        const match = results.get(`${league}|${normalizeTeam(p.home)}|${normalizeTeam(p.away)}`);
        if (!match) {
          const key = `${league}|${normalizeTeam(p.home)}|${normalizeTeam(p.away)}`;
          const kickoff = scheduled.get(key);
          const status = kickoff === undefined
            ? "not in the source at all — check the team names match the source you predicted from"
            : kickoff > Date.now() - 3 * 86_400_000
              ? "not played yet"
              : "played, but the source never recorded a result — this prediction can never be settled";
          pending.push({ date: p.date, league, match: `${p.home} v ${p.away}`, status });
          continue;
        }
        const actual: OutcomeIndex = match.result === "H" ? 0 : match.result === "D" ? 1 : 2;
        const modelP: [number, number, number] = [p.prob_home, p.prob_draw, p.prob_away];
        const predictedIndex = modelP.indexOf(Math.max(...modelP)) as OutcomeIndex;
        const hit = predictedIndex === actual;
        if (hit) hits++;
        modelRps += rps(modelP, actual);
        modelBrier += brier(modelP, actual);
        modelLogLoss += logLoss(modelP, actual);
        climRps += rps(BASE_RATES, actual);
        climLogLoss += logLoss(BASE_RATES, actual);

        // Calibration: every predicted probability counts, not just the pick.
        modelP.forEach((prob, i) => {
          const bucket = Math.min(9, Math.floor(prob * 10));
          const b = buckets.get(bucket) ?? { predicted: 0, observed: 0, n: 0 };
          b.predicted += prob; b.observed += actual === i ? 1 : 0; b.n++;
          buckets.set(bucket, b);
        });

        let marketP: [number, number, number] | undefined;
        const mo = p.market_odds;
        if (mo?.home && mo.draw && mo.away) {
          const fair = devig([mo.home, mo.draw, mo.away], "shin").probabilities as [number, number, number];
          marketP = fair;
          marketRps += rps(fair, actual);
          marketLogLoss += logLoss(fair, actual);
          if ((fair.indexOf(Math.max(...fair)) as OutcomeIndex) === actual) marketHits++;
          marketCount++;
        }

        let pickRow: Record<string, unknown> | undefined;
        if (p.pick) {
          const outcome = PICK_OUTCOMES[p.pick.outcome];
          const stake = p.pick.stake ?? 1;
          const winner = won(match, outcome);
          const profit = winner ? stake * (p.pick.odds - 1) * (1 - commission) : -stake;
          picks++; staked += stake; pnl += profit;
          if (winner) pickWins++;
          const closing = match.prices.close[outcome]?.odds ?? match.prices.open[outcome]?.odds;
          if (closing) { clvSum += p.pick.odds / closing - 1; clvCount++; }
          pickRow = {
            outcome: p.pick.outcome, odds: p.pick.odds, stake: round(stake, 2),
            result: winner ? "won" : "lost", pnl: round(profit, 2),
            ...(closing ? { closing_odds: asOdds(closing), clv_pct: asPct(p.pick.odds / closing - 1) } : {}),
          };
        }

        scored.push({
          date: match.date, league, match: `${match.home} v ${match.away}`,
          score: `${match.homeGoals}-${match.awayGoals}`,
          actual: match.result === "H" ? "home" : match.result === "D" ? "draw" : "away",
          predicted: (["home", "draw", "away"] as const)[predictedIndex],
          predicted_probability: asProb(modelP[predictedIndex]),
          probability_of_actual: asProb(modelP[actual]),
          hit,
          rps: round(rps(modelP, actual), 4),
          ...(marketP ? { market_rps: round(rps(marketP, actual), 4) } : {}),
          ...(pickRow ? { pick: pickRow } : {}),
        });
      }

      const n = scored.length;
      if (n === 0) {
        return toolResult({
          scored: 0,
          pending_count: pending.length,
          source: [...sourcesUsed],
          pending,
          ...(unavailable.length ? { unavailable } : {}),
          note: `None of these predictions has a result yet${sourcesUsed.size ? ` in ${[...sourcesUsed].join("/")}` : ""}. Come back after the matches are played — or check that the team names match the source you predicted from: the two sources spell them differently ("Inter" vs "FC Internazionale Milano"), and trading_predict_fixtures emits whichever form its source uses.`,
        });
      }

      const modelRpsAvg = modelRps / n;
      const marketRpsAvg = marketCount ? marketRps / marketCount : null;
      const skill = marketRpsAvg !== null && marketRpsAvg > 0 ? 1 - modelRpsAvg / marketRpsAvg : null;

      return toolResult({
        scored: n,
        pending_count: pending.length,
        source: [...sourcesUsed],
        accuracy: {
          hits,
          hit_rate_pct: asPct(hits / n),
          ...(marketCount ? { market_hit_rate_pct: asPct(marketHits / marketCount), market_hit_rate_sample: marketCount } : {}),
        },
        probability_scores: {
          rps: round(modelRpsAvg, 4),
          brier: round(modelBrier / n, 4),
          log_loss: round(modelLogLoss / n, 4),
          note: "Ranked probability score is the standard 1X2 metric — lower is better, 0 is perfect. It penalises being confidently wrong, unlike hit rate.",
        },
        benchmarks: {
          ...(marketRpsAvg !== null ? {
            market: { rps: round(marketRpsAvg, 4), log_loss: round(marketLogLoss / marketCount, 4), matches: marketCount },
            skill_vs_market_pct: skill !== null ? asPct(skill) : null,
          } : {}),
          base_rates: { rps: round(climRps / n, 4), log_loss: round(climLogLoss / n, 4), note: "Predicting the long-run 44/26/30 split for every match." },
        },
        calibration: [...buckets.entries()].sort(([a], [b]) => a - b).map(([bucket, b]) => ({
          predicted_range: `${bucket * 10}-${bucket * 10 + 10}%`,
          predictions: b.n,
          average_predicted_pct: asPct(b.predicted / b.n),
          actual_pct: asPct(b.observed / b.n),
        })),
        ...(picks ? {
          picks: {
            bets: picks,
            wins: pickWins,
            strike_rate_pct: asPct(pickWins / picks),
            staked: round(staked, 2),
            profit: round(pnl, 2),
            roi_pct: asPct(pnl / staked),
            ...(clvCount ? { average_clv_pct: asPct(clvSum / clvCount), clv_measured: clvCount } : {}),
          },
        } : {}),
        sample_matches: scored.slice(0, sample ?? 10),
        ...(pending.length ? { pending: pending.slice(0, 20) } : {}),
        ...(unavailable.length ? { unavailable } : {}),
        verdict: skill === null
          ? `${n} matches scored. Record the market odds alongside your predictions to get the benchmark that matters — beating the closing market, not beating a coin flip.`
          : skill > 0
            ? `The model's RPS is ${asPct(skill)}% better than the market's over ${marketCount} matches. Encouraging, but under a few hundred matches this gap is well inside noise.`
            : `The market scored better (model RPS ${round(modelRpsAvg, 4)} vs ${round(marketRpsAvg as number, 4)}). Normal: bookmakers price with team news and money flow the model never sees.`,
        caveats: [
          n < 50 ? `${n} matches is a very small sample — RPS differences this size are mostly luck.` : "Keep adding matches: forecast skill only separates from noise over hundreds of them.",
          "Predictions must be made BEFORE kick-off for any of this to mean anything. Scoring a prediction generated after the result is self-deception, and nothing here can detect it.",
        ],
      });
    }),
  );

  // 14. audit a claimed signal — the judge, which mostly says no
  server.tool(
    "trading_audit_signal",
    "Audit a claimed edge before betting it: sample size, significance, the multiple-testing bar for the size of the search that found it, out-of-sample result, closing-line value, and whether it survives execution costs. Returns an evidence card with a status of CANDIDATE, WATCH or NO SIGNAL. Built to refuse: on honest inputs nothing measured in this repository has reached CANDIDATE.",
    {
      label: z.string().describe('What is being claimed, e.g. "home favourites under 1.50 at best price"'),
      odds: z.number().gt(1).describe("Typical decimal odds the signal fires at"),
      claimed_edge_pct: z.number().gt(0).max(100).describe("The edge you believe you have, % of stake"),
      bets_observed: z.number().int().min(0).describe("Settled bets the estimate rests on"),
      research_token: z.string().optional().describe("Token from `npm run budget -- register`, proving the hypothesis was written down. Without one the multiple-testing gate stays shut and the claim cannot reach CANDIDATE."),
      hypotheses_tested: z.number().int().min(1).optional().describe("How many hypotheses the search has consumed. Ignored when a valid research_token is given — the count is then read off the ledger instead of taken from you."),
      commission_pct: z.number().min(0).lt(100).optional().describe("Commission on winnings, % (default 0)"),
      execution_cost_pct: z.number().min(0).max(50).optional().describe("Price erosion you actually expect at execution, % of the quoted price (default 0)"),
      out_of_sample_bets: z.number().int().min(0).optional().describe("Bets in a period the signal was NOT chosen on"),
      out_of_sample_roi_pct: z.number().optional().describe("ROI over those out-of-sample bets, %"),
      clv_pct: z.number().optional().describe("Closing-line value, %. Positive means you beat the closing price."),
      prior_sd_pct: z.number().gt(0).max(50).optional().describe("Prior SD for shrinking the estimate, percentage points (default 2 — the size of the best-price margin)"),
      correction: z.enum(["bonferroni", "fdr"]).optional().describe('Multiple-testing guarantee (default "bonferroni"). "bonferroni" bounds the chance of ANY false positive — right before staking money on one finding. "fdr" bounds the expected SHARE of promoted findings that are false — right for a research pipeline, and far less punishing at large ledger sizes. FDR reads the family\'s p-values from the ledger, so it only works if failures were resolved with --p too.'),
      fdr_q: z.number().gt(0).lt(1).optional().describe("Target false discovery rate when correction is fdr (default 0.10)"),
    },
    safe(async (a) => {
      const oos = a.out_of_sample_bets !== undefined && a.out_of_sample_roi_pct !== undefined
        ? { bets: a.out_of_sample_bets, roi_pct: a.out_of_sample_roi_pct }
        : undefined;
      const registration = a.research_token ? verifyToken(a.research_token, a.label) : undefined;
      const rows = readLedger();
      const card = auditSignal({
        registration,
        correction: a.correction,
        fdr_q: a.fdr_q,
        family_p_values: familyPValues(rows),
        label: a.label,
        odds: a.odds,
        claimed_edge_pct: a.claimed_edge_pct,
        bets_observed: a.bets_observed,
        commission_pct: a.commission_pct,
        execution_cost_pct: a.execution_cost_pct,
        hypotheses_tested: a.hypotheses_tested,
        out_of_sample: oos,
        clv_pct: a.clv_pct,
        prior_sd_pct: a.prior_sd_pct,
      });
      return toolResult({
        ...card,
        ledger: {
          entries: rows.length,
          hypotheses_consumed: consumed(rows),
          entries_with_p_value: familyPValues(rows).length,
        },
      });
    }),
  );

  // 15. what a search of a given size costs you
  server.tool(
    "trading_testing_bar",
    "The t-statistic a finding must clear once the search that produced it is charged for its own size, and how many bets that takes. Use it before mining: a swarm that generates hypotheses faster than it accumulates matches can never clear its own bar.",
    {
      hypotheses_tested: z.number().int().min(1).max(1e7).describe("How many hypotheses the search has consumed"),
      odds: z.number().gt(1).optional().describe("Typical decimal odds, for the bets-needed figure (default 2)"),
      edge_pct: z.number().gt(0).max(100).optional().describe("The edge you would need to find, % (default 2)"),
      alpha: z.number().gt(0).lt(1).optional().describe("Family-wise error rate (default 0.05)"),
    },
    safe(async ({ hypotheses_tested, odds, edge_pct, alpha }) => {
      const o = odds ?? 2, e = edge_pct ?? 2;
      const bar = bonferroniBar(hypotheses_tested, alpha ?? 0.05);
      const req = edgeRequirements(o, e);
      const betsAtBar = Math.ceil(req.bets_to_prove.one_sigma * bar ** 2);
      return toolResult({
        hypotheses_tested,
        bonferroni_bar: round(bar, 3),
        uncorrected_bar: 1.96,
        odds: o,
        edge_pct: e,
        bets_needed_uncorrected: req.bets_to_prove.two_sigma,
        bets_needed_at_this_bar: betsAtBar,
        seasons_at_1000_bets: round(betsAtBar / 1000, 1),
        verdict: `A search of ${hypotheses_tested} hypotheses needs t >= ${round(bar, 2)}, so a ${e}% edge at ${o} needs ${betsAtBar} settled bets instead of ${req.bets_to_prove.two_sigma} — ${round(betsAtBar / 1000, 1)} seasons at a thousand bets a year.`,
        notes: [
          "The bar grows with the logarithm of the search, which sounds forgiving and is not: it grows faster than any real dataset does.",
          "Measured here: 606 mined patterns left six survivors that were all one idea, and 184 threshold cells left none, the largest validation t being 0.93 against a bar of 3.08.",
          "Declaring a small number here does not make the search small. The count has to include every variant you looked at and discarded.",
        ],
      });
    }),
  );
}
