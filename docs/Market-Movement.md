# What the open-to-close data says

The first research run on the 489,437-observation open/close archive. Registered
before it was run (ledger entries #11 and #12, 36 specifications, ledger now at
944, bar *t* ≥ 4.042), train 2019-20 to 2022-23, validation 2023-24 to 2025-26,
standard errors clustered by match.

## The result that looks like a signal, and is not

Back a selection **at the opening price** when the panel's best price later
shortened:

| Condition | Train | Validation |
|---|---|---|
| shortened ≥ 2% | **+8.03%** ± 1.58, t = 5.09, n = 10,669 | **+3.76%** ± 1.62, t = 2.32, n = 8,406 |
| shortened ≥ 5% | +11.44% ± 2.60, t = 4.40 | +5.01% ± 2.62, t = 1.91 |
| shortened ≥ 10% | +16.50% ± 6.74, t = 2.45 | **+13.71%** ± 6.58, t = 2.08 |

And the mirror image, which is the same fact read backwards:

| Condition | Train | Validation |
|---|---|---|
| drifted ≥ 2% | −6.91%, t = −5.88 | −10.93%, t = −8.22 |
| drifted ≥ 10% | −13.92%, t = −5.51 | **−22.06%**, t = −7.54 |

Positive in both periods, monotone in the threshold, with a symmetric negative
twin. Every surface property of a real effect.

**It is look-ahead.** Betting at the open on selections that *later* shortened
requires knowing at the open what the close will say. The condition is not
available at the moment the bet is placed, so the row cannot be traded — no
matter how good the arithmetic is.

## The executable form, which settles it

Same conditions, same selections, bought at the **closing** price — the move has
already happened and you take the price that exists after it:

| Condition | Train | Validation |
|---|---|---|
| shortened ≥ 2% | +1.28% ± 1.44, t = 0.89 | **−2.53%** ± 1.51 |
| shortened ≥ 5% | +1.10% ± 2.29, t = 0.48 | **−4.43%** ± 2.35 |
| shortened ≥ 10% | −1.25% ± 5.54 | −2.96% ± 5.50 |
| drifted ≥ 2% | +1.02% ± 1.32, t = 0.77 | −3.93% ± 1.46 |
| drifted ≥ 10% | +0.87% ± 3.06 | −9.31% ± 3.47 |

Nothing clears *t* = 1 on training and every validation cell of consequence is
negative. **The closing price fully absorbs the move.** That is the textbook
result, and it is now measured here on 12,459 matches rather than assumed.

The two tables together are worth more than either alone. The first says the
movement carries real information — a lot of it, 4 to 14 points. The second says
that by the time the movement is observable, the price has already taken all of
it back. The prize for *predicting* direction of movement is large; the prize for
*noticing* it is zero.

## The conditions that are executable, and lose

These use only information available when the bet is placed.

**Cross-venue disagreement at the open.** Both directions of the obvious trade:

| Rule | Train | Validation |
|---|---|---|
| Pinnacle richer than market average by ≥ 1%, back Pinnacle | −2.47%, t = −3.54 | **−5.99%**, t = −6.42, n = 14,029 |
| …by ≥ 4% | −3.34% | −8.72% |
| Bet365 richer than Pinnacle by ≥ 1%, back Bet365 | +2.70%, t = 0.81 | **−7.54%**, t = −2.22 |
| …by ≥ 4% | +15.51%, t = 1.49 | −10.87% |

The Bet365 rows are a clean demonstration of the trap this repository keeps
finding: +15.51% on training, −10.87% out of sample, on a rule chosen because
training liked it.

**Best closing price by band.** The best executable cell in the whole run is 1X2
at or below 1.50 taken at the closing price: **+2.73% ± 1.90 on 886 validation
bets, t = 1.43**. Against a bar of 4.042 it is not close, and the one band that
*is* significant in validation is significantly bad — 5.00 to 10.00 at −10.73%,
t = −2.49.

## The verdict, from the judge

```
A. 1X2 at best closing price, 1.00-1.50 — the best executable cell
   STATUS: WATCH    t=1.535  bar=4.042 (k=944, from the ledger)
     FAIL sample · FAIL significance · FAIL multiple_tests · FAIL clv
     PASS out_of_sample · PASS cost

B. steam >=2% bought at OPEN — the tempting one
   STATUS: WATCH    t=2.250  bar=4.042
     PASS sample · PASS significance · PASS out_of_sample · PASS clv · PASS cost
     FAIL multiple_tests
   (and it is look-ahead, which no statistical gate can see)

B. steam >=2% bought at CLOSE — the executable one
   STATUS: NO SIGNAL — validation ROI is -2.53%
```

Note what the second card does **not** catch. Every gate but one passes, and the
failure it reports is the multiple-testing bar, not the look-ahead. A statistical
judge cannot see that a condition was unavailable at bet time; only reading the
rule can. That is the argument for an adversarial reader sitting beside the
gates rather than trusting them alone.

## What this leaves

No profitable situation. The one large effect in the data is unavailable at bet
time, and everything available at bet time loses. The honest reframing is the
one the data itself suggests: **the question worth budget is not whether the
movement is informative — it is, decisively — but whether anything observable at
the open predicts its direction.** That question needs the intraday trajectory
this archive does not contain, which is what a live snapshotter would build.
