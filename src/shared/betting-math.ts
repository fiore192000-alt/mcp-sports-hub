/**
 * Pure betting/trading math — no network, no state, no provider coupling.
 *
 * Everything the `trading_` tools compute lives here so it can be unit-tested
 * without a server or an HTTP mock: margin removal, expected value, Kelly,
 * arbitrage stakes, back/lay hedging, Poisson match models and the team
 * strength fit that drives the walk-forward backtest.
 *
 * Convention: odds are DECIMAL (European) everywhere, probabilities are
 * fractions in [0,1], commission is a fraction of NET winnings (exchange
 * style, 0 for a bookmaker).
 */

export type DevigMethod = "multiplicative" | "additive" | "power" | "shin";

export function round(n: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

/** Fraction -> percentage, 3dp. Keeps payloads small and readable. */
export function asPct(fraction: number): number {
  return round(fraction * 100, 3);
}

/** Decimal odds rounded for output. */
export function asOdds(odds: number): number {
  return round(odds, 4);
}

/** Probability rounded for output. */
export function asProb(p: number): number {
  return round(p, 6);
}

/** Decimal odds after exchange commission on net winnings. */
export function netOdds(odds: number, commission = 0): number {
  return 1 + (odds - 1) * (1 - commission);
}

function assertOdds(odds: number[]): void {
  if (odds.length < 2) throw new Error("At least 2 outcomes are required");
  for (const o of odds) {
    if (!Number.isFinite(o) || o <= 1) throw new Error(`Invalid decimal odds: ${o} (must be > 1.0)`);
  }
}

/** Solve f(x)=0 on [lo,hi] by bisection. f must change sign across the bracket. */
function bisect(f: (x: number) => number, lo: number, hi: number, iterations = 100): number {
  let a = lo, b = hi, fa = f(a);
  for (let i = 0; i < iterations; i++) {
    const mid = (a + b) / 2;
    const fm = f(mid);
    if (fm === 0) return mid;
    if (fa * fm < 0) b = mid;
    else { a = mid; fa = fm; }
  }
  return (a + b) / 2;
}

export interface DevigResult {
  method: DevigMethod;
  /** Sum of implied probabilities, e.g. 1.052. */
  booksum: number;
  /** Bookmaker margin as a percentage of the fair book. */
  overround_pct: number;
  probabilities: number[];
  fair_odds: number[];
  /** Shin's insider-trading fraction (shin only). */
  z?: number;
  /** Power exponent (power only). */
  k?: number;
  note?: string;
}

/**
 * Strip the bookmaker margin from a complete market and return fair
 * probabilities. The method matters: multiplicative flatters longshots,
 * power and shin push probability back toward favourites (closer to how a
 * sharp book actually prices), additive is the crudest.
 */
export function devig(odds: number[], method: DevigMethod = "multiplicative"): DevigResult {
  assertOdds(odds);
  const q = odds.map((o) => 1 / o);
  const booksum = q.reduce((a, b) => a + b, 0);
  let probabilities: number[];
  let z: number | undefined;
  let k: number | undefined;
  let note: string | undefined;

  if (method === "additive") {
    const excess = (booksum - 1) / q.length;
    probabilities = q.map((p) => p - excess);
    if (probabilities.some((p) => p <= 0)) {
      probabilities = q.map((p) => p / booksum);
      note = "additive de-vig produced a non-positive probability; fell back to multiplicative";
    }
  } else if (method === "power") {
    if (booksum <= 1) {
      probabilities = q.map((p) => p / booksum);
      note = "book has no margin (booksum <= 1); power fit skipped";
    } else {
      k = bisect((x) => q.reduce((a, p) => a + p ** x, 0) - 1, 1, 20);
      probabilities = q.map((p) => p ** (k as number));
    }
  } else if (method === "shin") {
    if (booksum <= 1) {
      probabilities = q.map((p) => p / booksum);
      note = "book has no margin (booksum <= 1); shin fit skipped";
    } else {
      const shinProbs = (zz: number) =>
        q.map((p) => (Math.sqrt(zz * zz + 4 * (1 - zz) * ((p * p) / booksum)) - zz) / (2 * (1 - zz)));
      z = bisect((zz) => shinProbs(zz).reduce((a, b) => a + b, 0) - 1, 0, 0.95);
      probabilities = shinProbs(z);
    }
  } else {
    probabilities = q.map((p) => p / booksum);
  }

  // Guard against drift from the numeric solvers.
  const total = probabilities.reduce((a, b) => a + b, 0);
  probabilities = probabilities.map((p) => p / total);

  return {
    method,
    booksum: round(booksum, 6),
    overround_pct: asPct(booksum - 1),
    probabilities: probabilities.map(asProb),
    fair_odds: probabilities.map((p) => asOdds(1 / p)),
    ...(z !== undefined ? { z: round(z, 6) } : {}),
    ...(k !== undefined ? { k: round(k, 6) } : {}),
    ...(note ? { note } : {}),
  };
}

/**
 * Kelly fraction of bankroll for a back bet. Negative means no bet — the
 * price is worse than your estimate, and the only Kelly-optimal action is
 * to lay it (or pass).
 */
export function kelly(odds: number, probability: number, commission = 0): number {
  const b = netOdds(odds, commission) - 1;
  if (b <= 0) return 0;
  return (probability * b - (1 - probability)) / b;
}

export interface SelectionInput {
  name: string;
  odds: number;
  probability: number;
}

export interface SelectionAssessment {
  name: string;
  odds: number;
  effective_odds: number;
  model_probability: number;
  implied_probability: number;
  fair_odds: number;
  /** probability * effective_odds; > 1 means positive expectation. */
  value_ratio: number;
  edge_pct: number;
  ev_per_unit: number;
  kelly_pct: number;
  stake: number;
  bet: boolean;
}

export interface StakeOptions {
  bankroll?: number;
  kelly_fraction?: number;
  commission?: number;
  max_stake_pct?: number;
  min_edge_pct?: number;
}

/**
 * Score one or more selections against your own probabilities: edge, EV and
 * a (fractional) Kelly stake. `bet` is true only when the edge clears
 * min_edge_pct — an edge inside the noise of your model is not a trade.
 */
export function assessSelections(
  selections: SelectionInput[],
  opts: StakeOptions = {},
): { assessments: SelectionAssessment[]; best: SelectionAssessment | null; total_stake: number } {
  const bankroll = opts.bankroll ?? 100;
  const fraction = opts.kelly_fraction ?? 0.25;
  const commission = opts.commission ?? 0;
  const maxStakePct = opts.max_stake_pct ?? 5;
  const minEdgePct = opts.min_edge_pct ?? 0;

  const assessments = selections.map((s) => {
    if (!Number.isFinite(s.odds) || s.odds <= 1) throw new Error(`Invalid decimal odds for "${s.name}": ${s.odds}`);
    if (!(s.probability > 0 && s.probability < 1)) throw new Error(`Probability for "${s.name}" must be between 0 and 1`);
    const eff = netOdds(s.odds, commission);
    const ev = s.probability * (eff - 1) - (1 - s.probability);
    const kellyFull = kelly(s.odds, s.probability, commission);
    const bet = ev > 0 && asPct(ev) >= minEdgePct;
    const stakePct = Math.max(0, Math.min(kellyFull * fraction, maxStakePct / 100));
    return {
      name: s.name,
      odds: asOdds(s.odds),
      effective_odds: asOdds(eff),
      model_probability: asProb(s.probability),
      implied_probability: asProb(1 / s.odds),
      fair_odds: asOdds(1 / s.probability),
      value_ratio: round(s.probability * eff, 4),
      edge_pct: asPct(ev),
      ev_per_unit: round(ev, 4),
      kelly_pct: asPct(kellyFull),
      stake: bet ? round(bankroll * stakePct, 2) : 0,
      bet,
    };
  });

  const betting = assessments.filter((a) => a.bet);
  const best = betting.length
    ? betting.reduce((a, b) => (b.edge_pct > a.edge_pct ? b : a))
    : null;
  return {
    assessments,
    best,
    total_stake: round(betting.reduce((a, b) => a + b.stake, 0), 2),
  };
}

export interface ArbitrageLeg {
  name: string;
  odds: number;
  bookmaker?: string;
}

/**
 * Check a set of best prices for a risk-free book and split the stake so every
 * outcome returns the same amount.
 */
export function arbitrage(legs: ArbitrageLeg[], totalStake = 100, commission = 0) {
  assertOdds(legs.map((l) => l.odds));
  const eff = legs.map((l) => netOdds(l.odds, commission));
  const booksum = eff.reduce((a, o) => a + 1 / o, 0);
  const guaranteedReturn = totalStake / booksum;
  const allocation = legs.map((l, i) => ({
    name: l.name,
    ...(l.bookmaker ? { bookmaker: l.bookmaker } : {}),
    odds: asOdds(l.odds),
    effective_odds: asOdds(eff[i]),
    stake: round(totalStake / booksum / eff[i], 2),
    returns: round(guaranteedReturn, 2),
  }));
  const profit = guaranteedReturn - totalStake;
  return {
    is_arbitrage: booksum < 1,
    booksum: round(booksum, 6),
    margin_pct: asPct(booksum - 1),
    profit_pct: asPct(1 / booksum - 1),
    total_stake: round(totalStake, 2),
    guaranteed_return: round(guaranteedReturn, 2),
    profit: round(profit, 2),
    allocation,
  };
}

export interface HedgeInput {
  /** "back" = you already backed and want to lay off; "lay" = the reverse. */
  side: "back" | "lay";
  stake: number;
  odds: number;
  /** Price now available on the opposite side. */
  hedge_odds: number;
  commission?: number;
  /** Hedge less (or more) than the full green-up amount. */
  hedge_stake?: number;
}

/**
 * Close out an open position. Returns the stake that equalises P&L across
 * both results (the "green-up"), plus what happens if you let it ride or
 * only hedge part of it.
 */
export function hedge(input: HedgeInput) {
  const { side, stake, odds, hedge_odds } = input;
  const c = input.commission ?? 0;
  if (!Number.isFinite(odds) || odds <= 1) throw new Error(`Invalid decimal odds: ${odds}`);
  if (!Number.isFinite(hedge_odds) || hedge_odds <= 1) throw new Error(`Invalid hedge odds: ${hedge_odds}`);
  if (!(stake > 0)) throw new Error("stake must be positive");

  // P&L of the open position if the selection wins / loses. Commission is
  // charged on the exchange leg only — the common case is a bookmaker bet
  // hedged on an exchange, or an exchange lay hedged at a bookmaker.
  const openWin = side === "back" ? stake * (odds - 1) : -stake * (odds - 1);
  const openLose = side === "back" ? -stake : stake * (1 - c);

  // Full green-up stake on the opposite side.
  const fullHedge = side === "back"
    ? (stake * odds) / (hedge_odds - c)
    : (stake * (odds - c)) / hedge_odds;
  const used = input.hedge_stake ?? fullHedge;

  // P&L contributed by the hedge leg.
  const hedgeWin = side === "back" ? -used * (hedge_odds - 1) : used * (hedge_odds - 1);
  const hedgeLose = side === "back" ? used * (1 - c) : -used;

  const ifWin = openWin + hedgeWin;
  const ifLose = openLose + hedgeLose;

  return {
    position: `${side} ${round(stake, 2)} @ ${asOdds(odds)}`,
    commission_pct: asPct(c),
    unhedged: { profit_if_win: round(openWin, 2), profit_if_lose: round(openLose, 2) },
    green_up: {
      hedge_side: side === "back" ? "lay" : "back",
      hedge_odds: asOdds(hedge_odds),
      stake: round(fullHedge, 2),
      liability: side === "back" ? round(fullHedge * (hedge_odds - 1), 2) : round(fullHedge, 2),
      locked_profit: round(
        side === "back" ? fullHedge * (1 - c) - stake : stake * (1 - c) - fullHedge,
        2,
      ),
    },
    applied: {
      stake: round(used, 2),
      profit_if_win: round(ifWin, 2),
      profit_if_lose: round(ifLose, 2),
      worst_case: round(Math.min(ifWin, ifLose), 2),
    },
  };
}

// ---------------------------------------------------------------------------
// Poisson match model
// ---------------------------------------------------------------------------

function poissonPmf(k: number, lambda: number): number {
  if (lambda <= 0) return k === 0 ? 1 : 0;
  let logP = -lambda + k * Math.log(lambda);
  for (let i = 2; i <= k; i++) logP -= Math.log(i);
  return Math.exp(logP);
}

/**
 * Dixon-Coles low-score correction. rho < 0 lifts 0-0/1-1 and trims 1-0/0-1,
 * which is what real football scorelines do versus independent Poisson.
 */
function dcTau(x: number, y: number, lh: number, la: number, rho: number): number {
  if (rho === 0) return 1;
  if (x === 0 && y === 0) return 1 - lh * la * rho;
  if (x === 0 && y === 1) return 1 + lh * rho;
  if (x === 1 && y === 0) return 1 + la * rho;
  if (x === 1 && y === 1) return 1 - rho;
  return 1;
}

export interface MatchModelOptions {
  rho?: number;
  max_goals?: number;
  lines?: number[];
}

export interface MatchModel {
  expected_goals: { home: number; away: number; total: number };
  probabilities: {
    home: number; draw: number; away: number;
    btts_yes: number; btts_no: number;
    over: Record<string, number>;
    under: Record<string, number>;
  };
  fair_odds: Record<string, number>;
  top_scorelines: Array<{ score: string; probability: number; fair_odds: number }>;
}

/** Full 1X2 / O-U / BTTS / correct-score market from two expected-goal rates. */
export function matchModel(lambdaHome: number, lambdaAway: number, opts: MatchModelOptions = {}): MatchModel {
  if (!(lambdaHome > 0) || !(lambdaAway > 0)) throw new Error("Expected goals must be positive");
  const rho = opts.rho ?? 0;
  const maxGoals = opts.max_goals ?? 12;
  const lines = opts.lines ?? [1.5, 2.5, 3.5];

  const grid: number[][] = [];
  let total = 0;
  for (let h = 0; h <= maxGoals; h++) {
    grid[h] = [];
    for (let a = 0; a <= maxGoals; a++) {
      const p = poissonPmf(h, lambdaHome) * poissonPmf(a, lambdaAway) * dcTau(h, a, lambdaHome, lambdaAway, rho);
      grid[h][a] = Math.max(0, p);
      total += grid[h][a];
    }
  }

  let home = 0, draw = 0, away = 0, bttsYes = 0;
  const overs = new Map<number, number>(lines.map((l) => [l, 0]));
  const scores: Array<{ score: string; probability: number }> = [];
  for (let h = 0; h <= maxGoals; h++) {
    for (let a = 0; a <= maxGoals; a++) {
      const p = grid[h][a] / total;
      if (h > a) home += p; else if (h === a) draw += p; else away += p;
      if (h > 0 && a > 0) bttsYes += p;
      for (const line of lines) if (h + a > line) overs.set(line, (overs.get(line) as number) + p);
      scores.push({ score: `${h}-${a}`, probability: p });
    }
  }

  const over: Record<string, number> = {};
  const under: Record<string, number> = {};
  const fair: Record<string, number> = {
    home: asOdds(1 / home), draw: asOdds(1 / draw), away: asOdds(1 / away),
    btts_yes: asOdds(1 / bttsYes), btts_no: asOdds(1 / (1 - bttsYes)),
  };
  for (const line of lines) {
    const o = overs.get(line) as number;
    over[String(line)] = asProb(o);
    under[String(line)] = asProb(1 - o);
    fair[`over_${line}`] = asOdds(1 / o);
    fair[`under_${line}`] = asOdds(1 / (1 - o));
  }

  return {
    expected_goals: {
      home: round(lambdaHome, 3),
      away: round(lambdaAway, 3),
      total: round(lambdaHome + lambdaAway, 3),
    },
    probabilities: {
      home: asProb(home), draw: asProb(draw), away: asProb(away),
      btts_yes: asProb(bttsYes), btts_no: asProb(1 - bttsYes),
      over, under,
    },
    fair_odds: fair,
    top_scorelines: scores
      .sort((a, b) => b.probability - a.probability)
      .slice(0, 6)
      .map((s) => ({ score: s.score, probability: asProb(s.probability), fair_odds: asOdds(1 / s.probability) })),
  };
}

// ---------------------------------------------------------------------------
// Team strength fit (the model behind the value backtest)
// ---------------------------------------------------------------------------

export interface RatedMatch {
  home: string;
  away: string;
  homeGoals: number;
  awayGoals: number;
  /** Epoch ms — used for recency weighting only. */
  ts: number;
}

export interface TeamRating {
  team: string;
  matches: number;
  weight: number;
  attack: number;
  defence: number;
  goals_for_pg: number;
  goals_against_pg: number;
  /** Venue-specific strengths, present only when the fit was asked for them. */
  attack_home?: number;
  attack_away?: number;
  defence_home?: number;
  defence_away?: number;
}

export interface RatingsFit {
  matches_used: number;
  home_goal_avg: number;
  away_goal_avg: number;
  home_advantage: number;
  half_life_days: number | null;
  prior_matches: number;
  teams: Map<string, TeamRating>;
}

export interface FitOptions {
  /** Exponential recency decay. null/0 = every match weighs the same. */
  half_life_days?: number | null;
  /** Shrinkage toward league average, in "matches" of prior weight. */
  prior_matches?: number;
  /** Reference time for the decay; defaults to the latest match in the sample. */
  as_of?: number;
  /**
   * Also rate each team separately at home and away, pooled toward its own
   * overall rating. Some sides really are different teams away from home; most
   * are not, which is why the venue ratings are pooled rather than free.
   */
  home_away_split?: boolean;
}

/**
 * Attack/defence strengths, each relative to the league's venue average
 * (1.0 = exactly average). Shrunk toward 1.0 so a team with three games does
 * not get a 2.4 attack rating off one 4-0 win.
 */
export function fitRatings(matches: RatedMatch[], opts: FitOptions = {}): RatingsFit {
  const halfLife = opts.half_life_days ?? null;
  const prior = opts.prior_matches ?? 4;
  if (matches.length === 0) {
    return {
      matches_used: 0, home_goal_avg: 0, away_goal_avg: 0, home_advantage: 0,
      half_life_days: halfLife, prior_matches: prior, teams: new Map(),
    };
  }
  const asOf = opts.as_of ?? Math.max(...matches.map((m) => m.ts));
  const weightOf = (m: RatedMatch) => {
    if (!halfLife || halfLife <= 0) return 1;
    const ageDays = Math.max(0, (asOf - m.ts) / 86_400_000);
    return 0.5 ** (ageDays / halfLife);
  };

  let wSum = 0, homeGoals = 0, awayGoals = 0;
  for (const m of matches) {
    const w = weightOf(m);
    wSum += w;
    homeGoals += w * m.homeGoals;
    awayGoals += w * m.awayGoals;
  }
  const homeAvg = homeGoals / wSum;
  const awayAvg = awayGoals / wSum;

  interface Venue { w: number; gf: number; ga: number; expGf: number; expGa: number }
  interface Acc { w: number; n: number; gf: number; ga: number; expGf: number; expGa: number; home: Venue; away: Venue }
  const blankVenue = (): Venue => ({ w: 0, gf: 0, ga: 0, expGf: 0, expGa: 0 });
  const acc = new Map<string, Acc>();
  const touch = (team: string): Acc => {
    let a = acc.get(team);
    if (!a) { a = { w: 0, n: 0, gf: 0, ga: 0, expGf: 0, expGa: 0, home: blankVenue(), away: blankVenue() }; acc.set(team, a); }
    return a;
  };

  for (const m of matches) {
    const w = weightOf(m);
    const h = touch(m.home), a = touch(m.away);
    h.w += w; h.n += 1; h.gf += w * m.homeGoals; h.ga += w * m.awayGoals;
    h.expGf += w * homeAvg; h.expGa += w * awayAvg;
    h.home.w += w; h.home.gf += w * m.homeGoals; h.home.ga += w * m.awayGoals;
    h.home.expGf += w * homeAvg; h.home.expGa += w * awayAvg;
    a.w += w; a.n += 1; a.gf += w * m.awayGoals; a.ga += w * m.homeGoals;
    a.expGf += w * awayAvg; a.expGa += w * homeAvg;
    a.away.w += w; a.away.gf += w * m.awayGoals; a.away.ga += w * m.homeGoals;
    a.away.expGf += w * awayAvg; a.away.expGa += w * homeAvg;
  }

  const teams = new Map<string, TeamRating>();
  for (const [team, t] of acc) {
    const rawAttack = t.expGf > 0 ? t.gf / t.expGf : 1;
    const rawDefence = t.expGa > 0 ? t.ga / t.expGa : 1;
    const shrink = (raw: number) => (raw * t.w + prior) / (t.w + prior);
    const attack = shrink(rawAttack);
    const defence = shrink(rawDefence);
    // A venue rating is pooled toward the team's own overall rating, not
    // toward the league: half a season of home games is thin evidence that a
    // side is genuinely different at home.
    const venue = (v: Venue, exp: number, goals: number, overall: number) => {
      if (!opts.home_away_split) return undefined;
      const raw = exp > 0 ? goals / exp : overall;
      return round((raw * v.w + overall * prior) / (v.w + prior), 4);
    };
    teams.set(team, {
      team,
      matches: t.n,
      weight: round(t.w, 3),
      attack: round(attack, 4),
      defence: round(defence, 4),
      goals_for_pg: round(t.n ? t.gf / t.w : 0, 3),
      goals_against_pg: round(t.n ? t.ga / t.w : 0, 3),
      ...(opts.home_away_split ? {
        attack_home: venue(t.home, t.home.expGf, t.home.gf, attack),
        defence_home: venue(t.home, t.home.expGa, t.home.ga, defence),
        attack_away: venue(t.away, t.away.expGf, t.away.gf, attack),
        defence_away: venue(t.away, t.away.expGa, t.away.ga, defence),
      } : {}),
    });
  }

  return {
    matches_used: matches.length,
    home_goal_avg: round(homeAvg, 4),
    away_goal_avg: round(awayAvg, 4),
    home_advantage: round(awayAvg > 0 ? homeAvg / awayAvg : 0, 4),
    half_life_days: halfLife,
    prior_matches: prior,
    teams,
  };
}

export interface ExpectedGoalsOptions {
  /**
   * What to assume about a team with no history at all — a side promoted into
   * this league. Without it the fixture is simply unrateable, which is honest
   * but loses every match a promoted team plays in its first season.
   */
  fallback?: { attack: number; defence: number };
}

/** Expected goals for a fixture under a fitted ratings set. */
export function expectedGoals(
  fit: RatingsFit,
  home: string,
  away: string,
  opts: ExpectedGoalsOptions = {},
): { home: number; away: number } | null {
  const unrated: TeamRating | undefined = opts.fallback
    ? { team: "", matches: 0, weight: 0, goals_for_pg: 0, goals_against_pg: 0, ...opts.fallback }
    : undefined;
  const h = fit.teams.get(home) ?? unrated;
  const a = fit.teams.get(away) ?? unrated;
  if (!h || !a || fit.home_goal_avg <= 0 || fit.away_goal_avg <= 0) return null;
  return {
    home: (h.attack_home ?? h.attack) * (a.defence_away ?? a.defence) * fit.home_goal_avg,
    away: (a.attack_away ?? a.attack) * (h.defence_home ?? h.defence) * fit.away_goal_avg,
  };
}

// ---------------------------------------------------------------------------
// Forecast scoring
// ---------------------------------------------------------------------------

/** Long-run 1X2 base rates — the "know nothing" forecast every model must beat. */
export const BASE_RATES: [number, number, number] = [0.44, 0.26, 0.30];

export type OutcomeIndex = 0 | 1 | 2;

/**
 * Ranked probability score for an ordered three-way market. Lower is better,
 * 0 is perfect. Unlike hit rate it punishes being confidently wrong, and
 * unlike Brier it knows home/draw/away are ordered, so calling an away win
 * when it finished a draw costs less than calling a home win.
 */
export function rankedProbabilityScore(p: [number, number, number], actual: OutcomeIndex): number {
  let cumP = 0, cumActual = 0, total = 0;
  for (let i = 0; i < 2; i++) {
    cumP += p[i];
    cumActual += actual === i ? 1 : 0;
    total += (cumP - cumActual) ** 2;
  }
  return total / 2;
}

/** Multi-category Brier score: the squared error summed over all three outcomes. */
export function brierScore(p: [number, number, number], actual: OutcomeIndex): number {
  return p.reduce((acc, prob, i) => acc + (prob - (actual === i ? 1 : 0)) ** 2, 0);
}

/** Negative log likelihood of the outcome that happened, clamped off zero. */
export function logLoss(p: [number, number, number], actual: OutcomeIndex): number {
  return -Math.log(Math.min(1 - 1e-6, Math.max(1e-6, p[actual])));
}

export interface ForecastScores {
  n: number;
  rps: number;
  brier: number;
  log_loss: number;
  hits: number;
  hit_rate: number;
}

/**
 * Score a batch of forecasts against what happened. Used by the scoring tool
 * and by the tuning harness, so a parameter search and a reported result can
 * never drift apart.
 */
export function scoreForecasts(
  forecasts: Array<{ p: [number, number, number]; actual: OutcomeIndex }>,
): ForecastScores {
  let rps = 0, brier = 0, ll = 0, hits = 0;
  for (const { p, actual } of forecasts) {
    rps += rankedProbabilityScore(p, actual);
    brier += brierScore(p, actual);
    ll += logLoss(p, actual);
    if ((p.indexOf(Math.max(...p)) as OutcomeIndex) === actual) hits++;
  }
  const n = forecasts.length || 1;
  return {
    n: forecasts.length,
    rps: rps / n,
    brier: brier / n,
    log_loss: ll / n,
    hits,
    hit_rate: hits / n,
  };
}

// ---------------------------------------------------------------------------
// Pricing a market — the inverse of de-vigging
// ---------------------------------------------------------------------------

export type MarginMethod = "proportional" | "power" | "additive";

/**
 * Round to the increments a book actually posts. Nobody displays 2.4713.
 */
export function tickOdds(odds: number): number {
  const step = odds < 2 ? 0.01 : odds < 3 ? 0.02 : odds < 4 ? 0.05 : odds < 6 ? 0.1 : odds < 10 ? 0.2 : odds < 20 ? 0.5 : 1;
  return Math.round(odds / step) * step;
}

export interface PricedMarket {
  method: MarginMethod;
  margin_pct: number;
  booksum: number;
  outcomes: Array<{
    name: string;
    fair_probability: number;
    fair_odds: number;
    posted_odds: number;
    /**
     * How far the posted price is cut below the fair one, as a percentage of
     * the fair odds. This is what the bettor actually pays on this outcome,
     * and the only reading that shows who carries the margin: a flat tax on
     * probabilities is not a flat tax on prices.
     */
    odds_cut_pct: number;
  }>;
}

/**
 * Turn fair probabilities into the odds a bookmaker would display, by adding a
 * margin instead of removing one.
 *
 * The method matters as much as the size. `proportional` taxes every outcome
 * equally, which no real book does. `power` loads the longshots harder — which
 * is what the market actually does, and is why backing short-priced favourites
 * at the best available price is the one pattern that survives validation
 * (docs/Evaluation.md). If you want to reproduce a real book, use power.
 */
export function applyMargin(
  probabilities: number[],
  marginPct: number,
  method: MarginMethod = "power",
  names?: string[],
): PricedMarket {
  if (probabilities.length < 2) throw new Error("A market needs at least 2 outcomes");
  for (const p of probabilities) {
    if (!(p > 0 && p < 1)) throw new Error(`Probability out of range: ${p}`);
  }
  const total = probabilities.reduce((a, b) => a + b, 0);
  if (Math.abs(total - 1) > 0.02) {
    throw new Error(`Probabilities sum to ${round(total, 4)}; a market must sum to 1 before a margin is added`);
  }
  const fair = probabilities.map((p) => p / total);
  const target = 1 + marginPct / 100;

  let booked: number[];
  if (method === "additive") {
    booked = fair.map((p) => p + (target - 1) / fair.length);
  } else if (method === "proportional") {
    booked = fair.map((p) => p * target);
  } else {
    // p^k summing to the target: k < 1 inflates the longshots most, which is
    // how a real book distributes its margin.
    let lo = 0.2, hi = 1;
    for (let i = 0; i < 100; i++) {
      const mid = (lo + hi) / 2;
      const sum = fair.reduce((a, p) => a + p ** mid, 0);
      if (sum > target) lo = mid; else hi = mid;
    }
    const k = (lo + hi) / 2;
    booked = fair.map((p) => p ** k);
  }

  const bookedTotal = booked.reduce((a, b) => a + b, 0);
  return {
    method,
    margin_pct: round(marginPct, 3),
    booksum: round(bookedTotal, 6),
    outcomes: fair.map((p, i) => {
      const posted = round(tickOdds(1 / booked[i]), 3);
      return {
        name: names?.[i] ?? `outcome_${i + 1}`,
        fair_probability: asProb(p),
        fair_odds: asOdds(1 / p),
        posted_odds: posted,
        odds_cut_pct: asPct(1 - posted * p),
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// What it takes to be profitable, as arithmetic
// ---------------------------------------------------------------------------

export interface EdgeRequirements {
  odds: number;
  effective_odds: number;
  claimed_edge_pct: number;
  break_even_hit_rate_pct: number;
  required_hit_rate_pct: number;
  /** Bets needed before the claimed edge is distinguishable from zero. */
  bets_to_prove: { one_sigma: number; two_sigma: number; three_sigma: number };
  kelly: { full_pct: number; quarter_pct: number };
  /**
   * Probability of the bankroll EVER falling to a fraction of its start, over an
   * unbounded horizon. It is the classic diffusion result, so it depends only on
   * the Kelly fraction — not on the edge or the price — and it is the ceiling,
   * not what one season looks like. Simulation puts full Kelly on a +1% edge at
   * price 2.0 at 1.7% after 1,000 bets, 23% after 5,000 and 50% after 100,000.
   * `ruin_risk_horizon` says this in the payload, since a number this alarming
   * should not arrive without its timescale.
   */
  ruin_risk: Array<{ drawdown_pct: number; full_kelly: number; half_kelly: number; quarter_kelly: number }>;
  /** What horizon `ruin_risk` assumes, stated so it cannot be read as one season. */
  ruin_risk_horizon: string;
  /** How long a losing run to expect over a season of this many bets. */
  expected_longest_losing_run: (bets: number) => number;
}

/**
 * The conditions a bet has to meet to make money, computed rather than asserted.
 *
 * Two numbers here tend to end arguments. The break-even hit rate says what
 * fraction you must win simply to lose nothing — at 1.30 it is 77%, which is
 * why a 70% hit rate can be a losing system. And `bets_to_prove` says how long
 * before a record means anything: a 2% edge at short odds needs thousands of
 * bets before it separates from noise, which is longer than most bankrolls or
 * most patience last.
 */
export function edgeRequirements(
  odds: number,
  claimedEdgePct: number,
  commission = 0,
): Omit<EdgeRequirements, "expected_longest_losing_run"> & { expected_longest_losing_run_per_1000: number } {
  if (!(odds > 1)) throw new Error(`Invalid decimal odds: ${odds}`);
  const eff = netOdds(odds, commission);
  const breakEven = 1 / eff;
  const edge = claimedEdgePct / 100;
  // ROI = p*eff - 1, so the hit rate that delivers the claimed edge is:
  const required = (1 + edge) / eff;
  if (required >= 1) {
    throw new Error(`An edge of ${claimedEdgePct}% at odds ${odds} would need a hit rate above 100%`);
  }
  const sd = Math.sqrt(required * (1 - required)) * eff;
  const betsFor = (sigma: number) => Math.ceil((sigma * sd / edge) ** 2);

  const fullKelly = kelly(odds, required, commission);
  // Standard fractional-Kelly result: betting k times the Kelly stake, the
  // chance of the bank ever touching a fraction a of its start is a^(2/k - 1).
  // Note what is NOT in that expression: the edge and the price. It is an
  // unbounded-horizon limit, and over a real season the risk is far lower —
  // which is why the horizon ships alongside the number.
  const ruinAt = (a: number, k: number) => Math.min(1, a ** (2 / k - 1));

  return {
    odds: asOdds(odds),
    effective_odds: asOdds(eff),
    claimed_edge_pct: round(claimedEdgePct, 3),
    break_even_hit_rate_pct: asPct(breakEven),
    required_hit_rate_pct: asPct(required),
    bets_to_prove: { one_sigma: betsFor(1), two_sigma: betsFor(2), three_sigma: betsFor(3) },
    kelly: { full_pct: asPct(fullKelly), quarter_pct: asPct(fullKelly / 4) },
    ruin_risk_horizon:
      "Unbounded horizon: the chance of ever touching this level if you keep betting forever. " +
      "It depends only on the Kelly fraction, not on the edge or the price, and one season is far " +
      "safer — simulated at full Kelly on a +1% edge at price 2.0, the chance of halving the bank " +
      "is 1.7% after 1,000 bets, 23% after 5,000 and 50% only after 100,000.",
    ruin_risk: [0.5, 0.25, 0.1].map((a) => ({
      drawdown_pct: asPct(1 - a),
      full_kelly: asProb(ruinAt(a, 1)),
      half_kelly: asProb(ruinAt(a, 0.5)),
      quarter_kelly: asProb(ruinAt(a, 0.25)),
    })),
    expected_longest_losing_run_per_1000: round(Math.log(1000) / Math.log(1 / (1 - required)), 1),
  };
}
