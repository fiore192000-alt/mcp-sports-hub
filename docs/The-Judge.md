# The judge

Build the thing that refuses a signal before the thing that produces one.

That ordering is not a moral position, it is what the measurements force. Over
[19,062 matches](Evaluation.md) the forecasting model here loses to the market.
Over [433,395 outcome legs](The-Price-Of-The-Best-Price.md) the best available
price loses 2.24%. A flat-strategy sweep over a million bets found nothing
positive in both periods. In that environment a system that cannot say *no*
credibly will eventually say *yes* to noise, and the only question is how long
it takes.

So this page is about two pieces of machinery: a ledger that charges a search
for its own size, and an auditor that puts a claim through six gates and mostly
turns it down.

## The ledger — `npm run budget`

A research process that is not charged for the size of its own search will
always find something. The arithmetic is not subtle:

| Hypotheses tested | Bar to clear (two-sided, 5% family-wise) | Bets needed for a 2% edge at 2.0 |
|---|---|---|
| 1 | 1.96 | 9,601 |
| 14 | 3.02 | 22,780 |
| 100 | 3.48 | 30,272 |
| 907 | 4.03 | 40,642 |
| 10,000 | 4.56 | 52,059 |

The bar grows with the logarithm of the search, which sounds forgiving, and the
evidence required grows with the *square* of the bar, which is not. A hundredfold
increase in searching costs about one point of *t* — and 72% more matches than
you had.

```bash
npm run budget -- register "steam > 5% on away favourites" --count 1 --scope "19 leagues, 0506-2627"
npm run budget -- resolve 12 --verdict rejected --note "negative out of sample"
npm run budget -- status
```

Registering issues a **token**, and the token is what makes the ledger binding
rather than advisory — see *The gate* below.

Three properties make it work, and all three are inconvenient on purpose:

- **Registration happens before you see the result.** Nothing in software can
  detect a hypothesis registered afterwards. Only writing it down first does.
- **A sweep costs what it tests.** `--count 606` for a 606-pattern mine, not 1.
  Counting a sweep as a single hypothesis is the exact dishonesty the ledger
  exists to prevent.
- **It is append-only.** A resolved entry cannot be rewritten; register a new
  hypothesis instead.

The log ships with what this repository has already spent:

```
Hypotheses consumed: 907  (across 9 registered entries)
  entries: validated 0   rejected 9   open 0
Bar for any finding from this search: t >= 4.033 (uncorrected 1.96)
```

Nine entries, 907 hypotheses, nine rejections, nothing validated. That is not
a failure of the research; it is the research.

## The gate

A ledger nobody has to consult is a diary. The gate makes it load-bearing:
`trading_audit_signal` takes the `research_token` that registration issued,
looks it up, and reads the hypothesis count **off the ledger rather than off
the caller**. Without a valid token the multiple-testing gate stays shut, so an
unregistered claim can be audited but can never reach CANDIDATE.

An undeclared search size is not a small one. It is an unknown one.

The token is a hash over the entry — its id, the hypothesis text, the moment it
was written down, and what it counts as — so changing any of those invalidates
it. Four ways it refuses, all of them tested:

| Attempt | Result |
|---|---|
| No token, claiming this was the only hypothesis | `self-declared`, gate shut, capped at WATCH |
| A token that matches no entry | rejected by name |
| A real token pointed at an unrelated claim | rejected, and it says which hypothesis the token was for |
| A real token for the right claim | `ledger`, count 908, bar 4.03 — the honest bar |

The label match is deliberately loose. Wording drifts between registering an
idea and writing it up, and a strict comparison would only teach people to
paste; it catches the case that matters, which is auditing something unrelated
to what was registered.

What it still cannot do is prove the hypothesis was written down *before* the
result was read. Forging a token means editing `research/hypotheses.json` by
hand, which is the point: it turns a lapse of memory into a deliberate act.

## The auditor — `trading_audit_signal`

Six gates. Each has killed something real here.

| Gate | What it asks | What it has killed |
|---|---|---|
| **sample** | Are there enough settled bets to see this edge at all? | A 2% edge at 3.0 needs 20,196 bets. Most records are a rounding error against that. |
| **significance** | Does the edge clear its own standard error? | — |
| **multiple_tests** | Does it clear the bar for the size of the search? | 606 patterns → six survivors that were one idea. 184 threshold cells → none, largest *t* 0.93 against 3.08. |
| **out_of_sample** | Was it positive in a period it was not chosen on? | The best of 28 pre-specified cells: +15.78% on train, **−11.56%** on validation. |
| **clv** | Did it beat the closing price? | The only feedback that converges in hundreds of bets rather than tens of thousands. |
| **cost** | Does it survive execution? | The short-favourite edge is +2.23% at the full best price and −0.35% after a 10% haircut. |

Statuses: **CANDIDATE** needs all six. **WATCH** means the cost gate passes and
there is some real evidence, but not enough of it. Everything else is
**NO SIGNAL**.

### The worked example, which is this repo's own best finding

Backing anything priced at or below 1.50 at the best available price returned
+2.45% on 2005-2019 and +1.85% on 5,766 validation bets — the single positive
result in both periods that survived everything else. Put through the auditor
with the inputs it actually has:

```
STATUS: NO SIGNAL
t = 2.494   bar = 4.033   net edge -3.243%

  PASS  sample           5766 settled bets against the 3708 this edge needs at this price.
  PASS  significance     t = 2.49 against the uncorrected 1.96.
  FAIL  multiple_tests   t = 2.49 against 4.03, after charging the search for 907 hypotheses.
  PASS  out_of_sample    Positive out of sample: 1.85% over 5766 bets.
  FAIL  clv              CLV negative: -0.77% against the closing price.
  FAIL  cost             1.85% becomes -3.24% after 5% execution erosion.
```

Two of those failures are decisive and neither is about the model. The search
that found it was too large for the evidence it produced, and a 5% exchange
commission — which is what you pay roughly half the time, since the exchange
supplies half of all best prices — turns the whole thing negative before a
single bet is placed.

Change the inputs to a world where the search was small and execution free, and
the same evidence passes — but only with a token proving the count:

```
registered(1), execution_cost_pct: 0, clv_pct: +0.5   →  CANDIDATE
hypotheses_tested: 1 self-declared, same everything else  →  WATCH
```

The evidence did not change in either direction. Only the accounting did, and
in the second case only the *claim* about the accounting. Both pairs are
asserted in the test suite, because they are the entire argument.

### Shrinkage, so a card cannot be read as a stake

Kelly assumes you know your edge; you have *measured* it. The card reports how
much of the point estimate the sample actually justifies:

| Record | Weight on the estimate |
|---|---|
| 50 bets | small |
| 5,766 bets at 1.33 | 87.9% |
| 20,000 bets at 2.0 | 88.9% |

Even twenty thousand bets do not buy the right to stake the point estimate in
full — and a real +2% edge at price 2.0, sized full Kelly on a 200-bet
measurement of itself, returns −18.6 basis points a bet and halves the bank
62.5% of the time. Not betting leaves you whole.

## Which guarantee — and the honest limit of the escape route

Bonferroni bounds the probability of **any** false positive. That is the right
promise when you are about to size a bet on one finding, and the wrong one for a
research programme: at 908 hypotheses it demands *t* ≥ 4.03, and a pipeline that
keeps searching eventually cannot promote anything at all.

Benjamini-Hochberg bounds the expected **share** of promoted findings that are
false. It is a weaker promise about each result and a far more useful one about
a pipeline, which is why fields testing millions of hypotheses use it rather
than testing fewer things. `trading_audit_signal` takes `correction: "fdr"` with
`fdr_q` (default 0.10), and reads the family's p-values from the ledger —
`npm run budget -- resolve <id> --p <value>`.

**It does not rescue this repo's finding, and it will not rescue most.** Measured
over 908 hypotheses, with the rest drawn from the null:

| True signals present | Their p | BH promotes at q = 0.10 | Bonferroni promotes |
|---|---|---|---|
| 1 | 0.0126 | **0** | 0 |
| 50 | 0.0126 | **0** | 0 |
| 50 | 1e-4 | **58** | **0** |
| 50 | 1e-6 | 58 | 50 |
| 100 | 1e-4 | **116** | **0** |

Read the first two rows before the third. A modest finding buried in a large
search fails under FDR as surely as under Bonferroni, and it still fails when
there are fifty of it. FDR pays off only when the pipeline turns up **several
signals that are already fairly strong** — at p = 1e-4 it finds 58 where
Bonferroni finds none, with the false share sitting near the q it promised.

So FDR is the right guarantee to *hold* a research programme to, and it is not a
way round a weak result. The way round a weak result is a stronger one, which
means more matches, not a gentler test. That is why the sequence is collectors
first.

One cost worth naming: FDR needs the p-values of the whole family, **failures
included**. An FDR computed only over the results somebody bothered to write
down because they looked good is not an FDR, it is a decoration. The ledger
reports how many entries carry one, so the gap is visible.

## `trading_testing_bar`

Use it *before* mining rather than after. It answers the question a research
swarm never asks itself: given that I am about to test N things, how much
evidence will I need, and do I have any prospect of accumulating it?

A swarm that generates hypotheses faster than the season generates matches can
never clear its own bar. That is not a tuning problem. It is arithmetic, and the
only fix is to test fewer things.

## What this does not do

It does not detect a hypothesis registered after the fact, it does not know
whether your out-of-sample period was really out of sample, and it cannot tell
an execution cost you guessed from one you measured. The gate closes the one
hole that can be closed mechanically — a search size supplied by the party it
flatters — and the rest is on you. Every gate is only as
honest as its input. The machinery makes dishonesty explicit and deliberate
rather than accidental — which is the most any of it can do.
