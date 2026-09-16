/**
 * The judge, not the forecaster.
 *
 * Everything else in this repository tries to find an edge. This file tries to
 * destroy one, and only reports a signal that survives. The order matters: a
 * system that can say "no" credibly is the only kind whose "yes" is worth
 * anything, and the measurements in docs/The-Price-Of-The-Best-Price.md are a
 * long argument for how easily a "yes" is manufactured.
 *
 * Six gates, each of which has killed something real in this repo:
 *
 *  1. SAMPLE        — a 2% edge at price 3.0 needs 20,196 bets to separate from
 *                     zero at two sigma. Most records are a rounding error
 *                     against that.
 *  2. SIGNIFICANCE  — the observed edge against its own standard error.
 *  3. MULTIPLE TESTS — the one nobody applies to themselves. 606 patterns left
 *                     six survivors that were all the same idea; 184 threshold
 *                     cells left none, with a largest t of 0.93 against a bar
 *                     of 3.08. A search that is not charged for its own size
 *                     always finds something.
 *  4. OUT OF SAMPLE — the best of 28 pre-specified cells returned +15.78% on
 *                     training and -11.56% on validation.
 *  5. CLV           — the only feedback that converges in hundreds of bets
 *                     rather than tens of thousands.
 *  6. COST          — the surviving short-favourite edge is +2.23% at the full
 *                     best price and -0.35% after a 10% haircut. An edge that
 *                     does not clear its own execution is not an edge.
 */

import { edgeRequirements, kelly, netOdds } from "./betting-math.js";

/** Acklam's rational approximation to the inverse normal CDF, |error| < 1.15e-9. */
export function normalQuantile(p: number): number {
  if (!(p > 0 && p < 1)) throw new Error(`normalQuantile needs 0 < p < 1, got ${p}`);
  const a = [-3.969683028665376e+1, 2.209460984245205e+2, -2.759285104469687e+2,
             1.383577518672690e+2, -3.066479806614716e+1, 2.506628277459239e+0];
  const b = [-5.447609879822406e+1, 1.615858368580409e+2, -1.556989798598866e+2,
             6.680131188771972e+1, -1.328068155288572e+1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838e+0,
             -2.549732539343734e+0, 4.374664141464968e+0, 2.938163982698783e+0];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996e+0,
             3.754408661907416e+0];
  const pLow = 0.02425, pHigh = 1 - pLow;
  let q: number, r: number;
  if (p < pLow) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) /
           ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1);
  }
  if (p > pHigh) {
    q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) /
            ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1);
  }
  q = p - 0.5; r = q * q;
  return (((((a[0]*r+a[1])*r+a[2])*r+a[3])*r+a[4])*r+a[5]) * q /
         (((((b[0]*r+b[1])*r+b[2])*r+b[3])*r+b[4])*r+1);
}

/**
 * The two-sided t-statistic a claim must clear once you charge it for the size
 * of the search that produced it. One hypothesis needs 1.96; a hundred need
 * 3.48; ten thousand need 4.42. The bar grows slowly, which is exactly why an
 * agent generating hypotheses at machine speed outruns it so easily.
 */
export function bonferroniBar(hypothesesTested: number, alpha = 0.05): number {
  const k = Math.max(1, Math.floor(hypothesesTested));
  return normalQuantile(1 - alpha / (2 * k));
}

/** Standard deviation of per-bet profit at these odds and this edge. */
export function perBetSd(odds: number, edgePct: number, commission = 0): number {
  const eff = netOdds(odds, commission);
  const p = (1 + edgePct / 100) / eff;
  if (!(p > 0 && p < 1)) throw new Error(`An edge of ${edgePct}% at odds ${odds} implies an impossible hit rate`);
  return eff * Math.sqrt(p * (1 - p));
}

export interface SignalClaim {
  /** What is being claimed, for the card. */
  label: string;
  odds: number;
  /** The edge you believe you have, in % of stake. */
  claimed_edge_pct: number;
  /** How many settled bets the estimate rests on. */
  bets_observed: number;
  commission_pct?: number;
  /** Price erosion you actually expect at execution, in % of the quoted price. */
  execution_cost_pct?: number;
  /** How many hypotheses the search that produced this has consumed. */
  hypotheses_tested?: number;
  out_of_sample?: { bets: number; roi_pct: number };
  /** Closing-line value, in %. Positive means you beat the closing price. */
  clv_pct?: number;
  /** Prior SD for shrinkage, in percentage points (default 2 — the size of the best-price margin). */
  prior_sd_pct?: number;
  /**
   * Proof that the hypothesis was written down before the result was seen,
   * from `npm run budget -- register`. Without it the search size is
   * self-declared, and a self-declared count is not a small one — it is an
   * unknown one, so the multiple-testing gate cannot pass.
   */
  registration?: {
    verified: boolean;
    reason?: string;
    hypothesis?: string;
    registered_at?: string;
    /** Hypotheses the whole search has consumed, read from the ledger. */
    ledger_consumed?: number;
  };
}

export interface Gate {
  gate: string;
  passed: boolean;
  detail: string;
}

export type SignalStatus = "CANDIDATE" | "WATCH" | "NO SIGNAL";

export interface EvidenceCard {
  label: string;
  status: SignalStatus;
  odds: number;
  claimed_edge_pct: number;
  /** The edge left once commission and expected execution erosion are taken out. */
  net_edge_pct: number;
  bets_observed: number;
  bets_needed_two_sigma: number;
  observed_t_stat: number;
  hypotheses_tested: number;
  /** Whether that count was verified against the ledger or supplied by the caller. */
  hypotheses_source: "ledger" | "self-declared";
  registered_at?: string;
  bonferroni_bar: number;
  /** What the estimate justifies staking, once shrunk toward the prior. */
  shrinkage: { weight: number; shrunk_edge_pct: number; quarter_kelly_stake_pct: number };
  gates: Gate[];
  reasons: string[];
  notes: string[];
}

/**
 * Audit one claimed signal. Returns a card, and the card is usually a refusal —
 * which is the point. A CANDIDATE needs all six gates; WATCH means the idea is
 * alive and the evidence is not there yet; everything else is NO SIGNAL.
 */
export function auditSignal(claim: SignalClaim): EvidenceCard {
  const {
    label, odds, claimed_edge_pct: edge, bets_observed: n,
    commission_pct = 0, execution_cost_pct = 0,
    hypotheses_tested = 1, out_of_sample, clv_pct, prior_sd_pct = 2, registration,
  } = claim;

  const commission = commission_pct / 100;
  const req = edgeRequirements(odds, edge, commission);
  // `edge` is a percentage and per-bet profit is in units of stake, so the
  // standard error is carried in percentage points throughout. Mixing the two
  // silently produces t-statistics in the hundreds, which is how this was
  // caught: the first real signal put through it scored t = 249.
  const sdPct = perBetSd(odds, edge, commission) * 100;
  const sePct = n > 0 ? sdPct / Math.sqrt(n) : Infinity;
  const t = n > 0 ? edge / sePct : 0;
  // The count comes off the ledger when there is one. A caller's own figure is
  // used for the arithmetic so the card is still informative, but it cannot
  // open the gate: understating it is the single easiest way to manufacture a
  // finding, and it is the one people do without noticing.
  const registered = registration?.verified === true;
  const effectiveK = registered && registration?.ledger_consumed
    ? registration.ledger_consumed
    : hypotheses_tested;
  const bar = bonferroniBar(effectiveK);

  // Execution erosion is a cut of the price, so it costs (1 + edge) x cut.
  const cut = execution_cost_pct / 100;
  const netEdge = (1 + edge / 100) * (1 - cut) - 1;
  const netEdgePct = netEdge * 100;

  // Shrink the point estimate toward zero by how little the sample says.
  const priorVar = prior_sd_pct ** 2;
  const seP = Number.isFinite(sePct) ? sePct : 1e6;
  const weight = priorVar / (priorVar + seP ** 2);
  const shrunk = edge * weight;
  const shrunkStake = shrunk > 0
    ? kelly(odds, (1 + shrunk / 100) / netOdds(odds, commission), commission) / 4
    : 0;

  const gates: Gate[] = [
    {
      gate: "sample",
      passed: n >= req.bets_to_prove.two_sigma,
      detail: n >= req.bets_to_prove.two_sigma
        ? `${n} settled bets against the ${req.bets_to_prove.two_sigma} this edge needs at this price.`
        : `${n} settled bets cannot show a ${edge}% edge at ${odds}: ${req.bets_to_prove.two_sigma} are needed at two sigma. This record is consistent with having no edge at all.`,
    },
    {
      gate: "significance",
      passed: t >= 1.96,
      detail: `t = ${t.toFixed(2)} against the uncorrected 1.96 (edge ${edge}% on a standard error of ${sePct.toFixed(2)} points over ${n} bets).`,
    },
    {
      gate: "multiple_tests",
      passed: registered && t >= bar,
      detail: registered
        ? `t = ${t.toFixed(2)} against ${bar.toFixed(2)}, the bar after charging the search for ${effectiveK} hypotheses — read from the ledger, where this was registered on ${registration?.registered_at?.slice(0, 10)}.`
        : `t = ${t.toFixed(2)} against ${bar.toFixed(2)} on a self-declared count of ${hypotheses_tested}. ${registration?.reason ?? "No registration token supplied."} An undeclared search size is not a small one, it is an unknown one, so this gate stays shut.`,
    },
    {
      gate: "out_of_sample",
      passed: !!out_of_sample && out_of_sample.roi_pct > 0 && out_of_sample.bets > 0,
      detail: out_of_sample
        ? `${out_of_sample.roi_pct > 0 ? "Positive" : "Negative"} out of sample: ${out_of_sample.roi_pct}% over ${out_of_sample.bets} bets.`
        : "No out-of-sample result supplied. An in-sample number is the result of a search, not a measurement.",
    },
    {
      gate: "clv",
      passed: clv_pct !== undefined && clv_pct > 0,
      detail: clv_pct === undefined
        ? "No closing-line value supplied. It is the only feedback that converges in hundreds of bets instead of tens of thousands — measure it before the P&L."
        : `CLV ${clv_pct > 0 ? "positive" : "negative"}: ${clv_pct}% against the closing price.`,
    },
    {
      gate: "cost",
      passed: netEdgePct > 0,
      detail: cut > 0 || commission > 0
        ? `${edge}% becomes ${netEdgePct.toFixed(2)}% after ${execution_cost_pct}% execution erosion${commission > 0 ? ` and ${commission_pct}% commission` : ""}.`
        : "No execution cost declared. Half the best prices in this market are an exchange gross of commission, so zero is rarely the honest number.",
    },
  ];

  const failed = gates.filter((g) => !g.passed);
  const costOk = gates.find((g) => g.gate === "cost")!.passed;
  const anyEvidence = gates.find((g) => g.gate === "out_of_sample")!.passed
    || gates.find((g) => g.gate === "clv")!.passed;

  const status: SignalStatus = failed.length === 0 ? "CANDIDATE"
    : costOk && anyEvidence ? "WATCH"
    : "NO SIGNAL";

  const reasons = failed.length === 0
    ? ["Every gate passed. That is rare enough to be worth re-deriving from the raw data before staking anything."]
    : failed.map((g) => g.detail);

  return {
    label,
    status,
    odds,
    claimed_edge_pct: edge,
    net_edge_pct: Number(netEdgePct.toFixed(3)),
    bets_observed: n,
    bets_needed_two_sigma: req.bets_to_prove.two_sigma,
    observed_t_stat: Number(t.toFixed(3)),
    hypotheses_tested: effectiveK,
    hypotheses_source: registered ? "ledger" : "self-declared",
    registered_at: registration?.registered_at,
    bonferroni_bar: Number(bar.toFixed(3)),
    shrinkage: {
      weight: Number(weight.toFixed(4)),
      shrunk_edge_pct: Number(shrunk.toFixed(3)),
      quarter_kelly_stake_pct: Number((shrunkStake * 100).toFixed(3)),
    },
    gates,
    reasons,
    notes: [
      `The sample justifies staking ${(weight * 100).toFixed(1)}% of what the point estimate suggests. Kelly assumes you know the edge; you have measured it.`,
      "A real +2% edge at price 2.0, sized full Kelly on a 200-bet measurement of itself, returns -18.6 basis points a bet and halves the bank 62.5% of the time. Not betting leaves you whole.",
      status === "CANDIDATE"
        ? "CANDIDATE is not a bet. It means the claim survived its gates against a hypothesis count taken from the ledger — which still cannot prove the hypothesis was written down before the result was read."
        : "This is the expected outcome. Over 606 mined patterns and 184 threshold cells, nothing in this repository has reached CANDIDATE on honest inputs.",
    ],
  };
}
