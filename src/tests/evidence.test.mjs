import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  auditSignal, benjaminiHochberg, bonferroniBar, normalQuantile, perBetSd, twoSidedP,
} from "../../dist/shared/evidence.js";

/** Deterministic uniform draws, so "null hypotheses" are reproducible. */
const nulls = (n, seed) => { let s = seed; return Array.from({ length: n }, () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)); };

/** A registration the ledger would have produced, for tests that need one. */
const registered = (k, at = "2026-01-01T00:00:00.000Z") =>
  ({ verified: true, hypothesis: "x", registered_at: at, ledger_consumed: k });

const close = (a, b, tol, msg) =>
  assert.ok(Math.abs(a - b) <= tol, `${msg}: expected ${b} +/- ${tol}, got ${a}`);

describe("normalQuantile", () => {
  it("matches the textbook critical values", () => {
    close(normalQuantile(0.975), 1.959964, 1e-5, "two-sided 5%");
    close(normalQuantile(0.995), 2.575829, 1e-5, "two-sided 1%");
    close(normalQuantile(0.5), 0, 1e-9, "the median");
    close(normalQuantile(0.9), 1.281552, 1e-5, "upper decile");
  });

  it("is symmetric and monotone, including in the tails the rational pieces switch at", () => {
    for (const p of [1e-8, 1e-4, 0.0242, 0.0243, 0.3, 0.7, 0.9757, 0.9758, 1 - 1e-8]) {
      close(normalQuantile(p), -normalQuantile(1 - p), 1e-6, `symmetry at ${p}`);
    }
    let prev = -Infinity;
    for (let p = 0.001; p < 1; p += 0.001) {
      const q = normalQuantile(p);
      assert.ok(q > prev, `not monotone at ${p}`);
      prev = q;
    }
  });

  it("refuses probabilities outside (0,1) rather than returning a number", () => {
    for (const bad of [0, 1, -0.5, 2, NaN]) assert.throws(() => normalQuantile(bad));
  });
});

describe("bonferroniBar", () => {
  it("is 1.96 for a single hypothesis and rises with the size of the search", () => {
    close(bonferroniBar(1), 1.959964, 1e-5, "one hypothesis");
    close(bonferroniBar(100), 3.4808, 1e-3, "a hundred");
    // Cross-checked against Python's statistics.NormalDist to six decimals.
    close(bonferroniBar(907), 4.032755, 1e-5, "the search this repo has already done");
    close(bonferroniBar(10000), 4.564788, 1e-5, "ten thousand");
  });

  it("rises slowly in t and brutally in the evidence that costs", () => {
    // A hundredfold bigger search moves the bar by about one point of t, which
    // sounds survivable. It is not: bets needed scale with the SQUARE of the
    // bar, so that one point is a 72% increase in the sample required, and the
    // full trip from one hypothesis to ten thousand is more than fivefold.
    const gap = bonferroniBar(10000) - bonferroniBar(100);
    close(gap, 1.084, 0.01, "a hundredfold search costs about a point of t");
    close((bonferroniBar(10000) / bonferroniBar(100)) ** 2, 1.72, 0.01, "and 72% more bets");
    const betsRatio = (bonferroniBar(10000) / bonferroniBar(1)) ** 2;
    assert.ok(betsRatio > 5, `a 10k search should need >5x the bets, got ${betsRatio.toFixed(1)}x`);
  });

  it("never falls as the search grows", () => {
    let prev = 0;
    for (const k of [1, 2, 5, 14, 100, 907, 5000, 1e6]) {
      const bar = bonferroniBar(k);
      assert.ok(bar >= prev, `bar fell at k=${k}`);
      prev = bar;
    }
  });
});

describe("perBetSd", () => {
  it("equals the closed form o*sqrt(p(1-p))", () => {
    for (const [odds, edge] of [[1.33, 1.85], [2, 2], [5, 3], [10, 8]]) {
      const p = (1 + edge / 100) / odds;
      close(perBetSd(odds, edge), odds * Math.sqrt(p * (1 - p)), 1e-12, `odds ${odds}`);
    }
  });

  it("refuses an edge that would need a hit rate above 100%", () => {
    assert.throws(() => perBetSd(1.05, 50));
  });
});

describe("auditSignal", () => {
  // The repo's single best finding, with the inputs it actually has.
  const realFinding = {
    label: "outcomes priced <= 1.50 at the best available price",
    odds: 1.33,
    claimed_edge_pct: 1.85,
    bets_observed: 5766,
    hypotheses_tested: 907,
    execution_cost_pct: 5,
    out_of_sample: { bets: 5766, roi_pct: 1.85 },
    clv_pct: -0.77,
  };

  it("keeps the edge and its standard error in the same units", () => {
    // Regression: the first version divided a percentage by a fraction and
    // reported t = 249 for this exact claim. An independent measurement of the
    // same rule put it at 2.43, so anything outside a sane band is the bug back.
    const card = auditSignal(realFinding);
    assert.ok(card.observed_t_stat > 2 && card.observed_t_stat < 3,
      `t should be around 2.5, got ${card.observed_t_stat}`);
  });

  it("refuses the repo's best finding, and says which gates it failed", () => {
    const card = auditSignal(realFinding);
    assert.equal(card.status, "NO SIGNAL");
    const failed = card.gates.filter((g) => !g.passed).map((g) => g.gate);
    assert.deepEqual(failed.sort(), ["clv", "cost", "multiple_tests"]);
    assert.ok(card.net_edge_pct < 0, "a 5% cut on a 1.85% edge is negative");
  });

  it("would pass the same finding if the search had been small and the price free", () => {
    const card = auditSignal({ ...realFinding, execution_cost_pct: 0, clv_pct: 0.5, registration: registered(1) });
    assert.equal(card.status, "CANDIDATE");
    assert.ok(card.gates.every((g) => g.passed));
    assert.equal(card.hypotheses_source, "ledger");
  });

  it("charges the search: the same evidence fails once the ledger is honest", () => {
    const clean = { ...realFinding, execution_cost_pct: 0, clv_pct: 0.5 };
    const small = auditSignal({ ...clean, registration: registered(1) });
    const large = auditSignal({ ...clean, registration: registered(907) });
    assert.equal(small.status, "CANDIDATE");
    assert.equal(large.status, "WATCH");
    assert.ok(large.bonferroni_bar > small.bonferroni_bar);
    assert.equal(small.observed_t_stat, large.observed_t_stat, "the evidence did not change, only the charge for it");
  });

  it("will not open the multiple-testing gate on a count the caller supplied itself", () => {
    // The whole point of the gate. Identical evidence, identical claimed count
    // of one: verified reaches CANDIDATE, self-declared cannot.
    const clean = { ...realFinding, execution_cost_pct: 0, clv_pct: 0.5 };
    const declared = auditSignal({ ...clean, hypotheses_tested: 1 });
    const verified = auditSignal({ ...clean, registration: registered(1) });
    assert.equal(declared.status, "WATCH");
    assert.equal(verified.status, "CANDIDATE");
    assert.equal(declared.hypotheses_source, "self-declared");
    assert.equal(declared.observed_t_stat, verified.observed_t_stat);
    assert.match(declared.gates.find((g) => g.gate === "multiple_tests").detail, /unknown one/);
  });

  it("reads the count off the ledger and ignores a flattering one from the caller", () => {
    const card = auditSignal({ ...realFinding, hypotheses_tested: 1, registration: registered(907) });
    assert.equal(card.hypotheses_tested, 907, "the caller's 1 must not win");
    close(card.bonferroni_bar, 4.033, 0.01, "the bar is the ledger's");
  });

  it("carries a failed verification's reason into the card", () => {
    const card = auditSignal({
      ...realFinding,
      registration: { verified: false, reason: "Token h9-abc matches no entry in the ledger." },
    });
    assert.match(card.gates.find((g) => g.gate === "multiple_tests").detail, /matches no entry/);
    assert.notEqual(card.status, "CANDIDATE");
  });

  it("treats a missing out-of-sample result as a failure, not as an absence", () => {
    const card = auditSignal({ ...realFinding, out_of_sample: undefined });
    const gate = card.gates.find((g) => g.gate === "out_of_sample");
    assert.equal(gate.passed, false);
    assert.match(gate.detail, /No out-of-sample result supplied/);
  });

  it("calls a short record what it is, however good the number looks", () => {
    const card = auditSignal({ label: "hot streak", odds: 3, claimed_edge_pct: 12, bets_observed: 40 });
    assert.equal(card.status, "NO SIGNAL");
    const sample = card.gates.find((g) => g.gate === "sample");
    assert.equal(sample.passed, false);
    assert.ok(card.bets_needed_two_sigma > 40 * 5);
  });

  it("shrinks harder the thinner the record, and stops staking when it shrinks to nothing", () => {
    const thin = auditSignal({ label: "x", odds: 2, claimed_edge_pct: 5, bets_observed: 50 });
    const thick = auditSignal({ label: "x", odds: 2, claimed_edge_pct: 5, bets_observed: 20000 });
    assert.ok(thin.shrinkage.weight < thick.shrinkage.weight, "more bets should earn more weight");
    assert.ok(thin.shrinkage.shrunk_edge_pct < thin.claimed_edge_pct);
    // 0.889 against a 2-point prior, cross-checked by hand. Even twenty
    // thousand bets do not buy the right to stake the point estimate in full.
    close(thick.shrinkage.weight, 0.889, 0.002, "a 20k record earns most, not all, of the estimate");
    assert.ok(thick.shrinkage.weight < 1, "nothing earns the full point estimate");
    assert.ok(thin.shrinkage.quarter_kelly_stake_pct < thick.shrinkage.quarter_kelly_stake_pct);
  });

  it("takes the execution cut off the whole return, not off the edge", () => {
    // A 5% cut on a 1.85% edge leaves (1.0185 x 0.95) - 1 = -3.24%, not -3.15%.
    const card = auditSignal({ label: "x", odds: 2, claimed_edge_pct: 1.85, bets_observed: 10, execution_cost_pct: 5 });
    close(card.net_edge_pct, -3.243, 1e-3, "erosion applies to the price, not the margin");
  });

  it("emits only the three statuses, whatever it is fed", () => {
    for (const odds of [1.2, 2, 6]) for (const n of [0, 10, 100000]) for (const k of [1, 907]) {
      for (const cost of [0, 5]) for (const clv of [undefined, -1, 1]) {
        const card = auditSignal({ label: "x", odds, claimed_edge_pct: 2, bets_observed: n, hypotheses_tested: k, execution_cost_pct: cost, clv_pct: clv });
        assert.ok(["CANDIDATE", "WATCH", "NO SIGNAL"].includes(card.status), `bad status ${card.status}`);
        assert.ok(Number.isFinite(card.bonferroni_bar) && Number.isFinite(card.net_edge_pct));
        assert.ok(Number.isFinite(card.observed_t_stat), `non-finite t at n=${n}`);
        assert.ok(card.reasons.length > 0, "a card always says why");
      }
    }
  });
});


describe("twoSidedP", () => {
  it("matches the exact normal tail to better than 2e-7", () => {
    // Cross-checked against Python's statistics.NormalDist.
    const exact = { 0.5: 6.170751e-1, 1.96: 4.999579e-2, 2.494: 1.263125e-2, 3: 2.699796e-3, 4.03: 5.577685e-5, 5: 5.733031e-7 };
    for (const [t, e] of Object.entries(exact)) close(twoSidedP(Number(t)), e, 2e-7, `t=${t}`);
  });

  it("is symmetric, bounded and monotone in |t|", () => {
    for (const t of [0.3, 1, 2.5, 6]) close(twoSidedP(t), twoSidedP(-t), 1e-12, "symmetry");
    close(twoSidedP(0), 1, 1e-6, "no evidence is p=1");
    let prev = 1;
    for (let t = 0.1; t < 8; t += 0.1) {
      const p = twoSidedP(t);
      assert.ok(p <= prev + 1e-12 && p >= 0 && p <= 1, `not monotone or out of range at t=${t}`);
      prev = p;
    }
  });
});

describe("benjaminiHochberg", () => {
  it("promotes nothing when the family is all noise", () => {
    const r = benjaminiHochberg(nulls(1000, 11), 0.1);
    assert.equal(r.promoted, 0);
    assert.equal(r.threshold, null);
  });

  it("does not rescue one modest finding buried in a large search", () => {
    // This repo's own case: t = 2.49 is p = 0.0126, among 907 nulls. Neither
    // correction promotes it, and that is the honest answer — FDR is less
    // punishing in general, not a way round a weak result.
    const family = [0.0126, ...nulls(907, 42)];
    for (const q of [0.05, 0.1, 0.2]) assert.equal(benjaminiHochberg(family, q).promoted, 0, `q=${q}`);
    assert.ok(twoSidedP(2.494) > 0.05 / (2 * 908), "nor does Bonferroni");
  });

  it("beats Bonferroni decisively once several moderately strong signals exist", () => {
    const family = [...Array(50).fill(1e-4), ...nulls(858, 7)];
    const bh = benjaminiHochberg(family, 0.1);
    const bonferroni = family.filter((p) => p <= 0.05 / (2 * family.length)).length;
    assert.ok(bh.promoted >= 50, `BH should find the 50, got ${bh.promoted}`);
    assert.equal(bonferroni, 0, "Bonferroni finds none of them");
  });

  it("keeps false discoveries near q, which is the guarantee it actually makes", () => {
    const trueSignals = 50;
    const family = [...Array(trueSignals).fill(1e-4), ...nulls(858, 7)];
    const bh = benjaminiHochberg(family, 0.1);
    const falseDiscoveries = bh.promoted - trueSignals;
    assert.ok(falseDiscoveries / bh.promoted <= 0.15, `false share ${(falseDiscoveries / bh.promoted).toFixed(3)} should sit near q=0.10`);
  });

  it("is monotone in q and handles the empty family", () => {
    const family = [...Array(20).fill(1e-4), ...nulls(200, 3)];
    let prev = -1;
    for (const q of [0.01, 0.05, 0.1, 0.25, 0.5]) {
      const n = benjaminiHochberg(family, q).promoted;
      assert.ok(n >= prev, `promotions fell as q rose (q=${q})`);
      prev = n;
    }
    const empty = benjaminiHochberg([], 0.1);
    assert.equal(empty.m, 0);
    assert.equal(empty.promoted, 0);
    assert.equal(empty.threshold, null);
  });

  it("ignores values that are not probabilities rather than trusting them", () => {
    const r = benjaminiHochberg([1e-6, NaN, -0.2, 1.4, Infinity, 0.5], 0.1);
    assert.equal(r.m, 2, "only the two real p-values count");
  });
});

describe("auditSignal under FDR", () => {
  const base = {
    label: "x", odds: 1.33, claimed_edge_pct: 1.85, bets_observed: 5766,
    execution_cost_pct: 0, out_of_sample: { bets: 5766, roi_pct: 1.85 }, clv_pct: 0.5,
    registration: registered(908),
  };

  it("refuses this repo's finding under FDR too, and says Bonferroni agrees", () => {
    const card = auditSignal({ ...base, correction: "fdr", family_p_values: [0.0126, ...nulls(907, 42)] });
    assert.equal(card.status, "WATCH");
    assert.equal(card.correction, "fdr");
    const g = card.gates.find((x) => x.gate === "multiple_tests");
    assert.equal(g.passed, false);
    assert.match(g.detail, /does not clear/, "the card should say Bonferroni agrees");
  });

  it("promotes the same claim when the family says it is one of many real ones", () => {
    const card = auditSignal({ ...base, correction: "fdr", family_p_values: [...Array(60).fill(1e-4), 0.0126, ...nulls(847, 7)] });
    assert.equal(card.gates.find((x) => x.gate === "multiple_tests").passed, false, "0.0126 is still too weak even in good company");
    const strong = auditSignal({ ...base, claimed_edge_pct: 4, correction: "fdr", family_p_values: [...Array(60).fill(1e-4), ...nulls(847, 7)] });
    assert.ok(strong.p_value < 1e-4, "a 4% edge over 5766 bets at 1.33 is a strong result");
    assert.equal(strong.status, "CANDIDATE");
  });

  it("refuses to pass on FDR when no family was supplied, rather than passing by default", () => {
    const card = auditSignal({ ...base, correction: "fdr", family_p_values: [] });
    const g = card.gates.find((x) => x.gate === "multiple_tests");
    assert.equal(g.passed, false);
    assert.match(g.detail, /no family p-values were supplied/);
  });

  it("still needs a verified registration, whichever correction is asked for", () => {
    const card = auditSignal({ ...base, registration: undefined, correction: "fdr", family_p_values: [...Array(60).fill(1e-9)] });
    assert.equal(card.gates.find((x) => x.gate === "multiple_tests").passed, false);
    assert.equal(card.hypotheses_source, "self-declared");
  });
});
