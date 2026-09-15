# The price of the best price

Suppose the constraints come off. You can bet at **any** price, you are under **no**
obligation to bet at all, and you can stake **whatever you like**. Those are the three
freedoms people assume are what separates them from the winners. This page measures what
each one is worth.

The short version: the first is worth about five and a third points and stops there, the
second is worth nothing without something to select on, and the third is worth nothing
without the first two. The best available price closes 5.3 points of a 6.6 point margin
and leaves you short.

Three independent measurements, on two datasets that do not overlap, agree.

## 1. What the best price is worth

**Measurement A** — 1,186 matches, 22 divisions, 15 Aug to 13 Sep 2025, from the
football-data.co.uk workbook, which carries nine named bookmakers with both an opening and
a closing price. Mean overround, where 1.000 is a book with no margin at all:

| Book at the close | Overround | Margin |
|---|---|---|
| Ladbrokes | 1.0846 | 8.5% |
| Coral | 1.0804 | 8.0% |
| bwin | 1.0775 | 7.8% |
| Bet365 | 1.0753 | 7.5% |
| BetMGM | 1.0752 | 7.5% |
| BetVictor | 1.0737 | 7.4% |
| Betfair Sportsbook | 1.0709 | 7.1% |
| Pinnacle | 1.0406 | 4.1% |
| Betfair Exchange | 1.0100 | 1.0% (gross of commission) |

| Taking the best of all nine | Overround | CLV vs close | ROI (SE clustered by match) |
|---|---|---|---|
| market average | 1.0782 | −7.07% | −8.73% |
| best **opening** price | 1.0199 | **−0.77%** | −2.70% ± 1.33% |
| best **closing** price | **0.9991** | **+1.58%** | −0.74% ± 1.44% |
| best close, no exchange | 1.0202 | −1.19% | −3.33% ± 1.28% |
| best close, exchange net 5% | 1.0184 | −0.64% | −2.89% ± 1.38% |
| best close, exchange net 2% | 1.0067 | +0.69% | −1.60% ± 1.41% |

Three things fall out of that table.

**Half the apparent edge is an exchange price gross of commission.** The Betfair Exchange
supplies the best quote 49.4% of the time. Net of 5% commission it adds nothing at all
over the best bookmaker (1.0184 against 1.0202 without it); net of 2% it adds about 1.2
points. Your effective commission decides whether the exchange is a venue or a mirage.

**Taking the best price early does not beat the close.** The best opening price has a CLV
of −0.77% against the de-vigged closing consensus, where the best closing price has
+1.58%. That is 2.35 points for waiting rather than anticipating — the opposite of the
folklore.

**Real arbitrage barely exists.** Three best prices summing below 1 occurs in 4.05% of
matches with everything gross, but only **0.17%** excluding the exchange and 0.42% with
the exchange net of 5%. The closing figures look far larger (39% gross, 11.6% ex-exchange)
and should not be believed: football-data records each book's last price, not simultaneous
prices, which is precisely how arbitrage appears in data and vanishes in execution.

**Measurement B** — 144,465 matches and 433,395 legs from the archive mirror, seasons
2005-06 to 2026-27, 19 divisions, standard errors clustered by match:

| Execution | ROI % | SE | Train 0506-1819 | Valid 1920-2627 |
|---|---|---|---|---|
| **best price** | **−2.24** | 0.12 | −2.11 | −2.49 |
| best −1% | −3.22 | 0.12 | −3.09 | −3.46 |
| best −2% | −4.19 | 0.12 | −4.07 | −4.44 |
| best −3% | −5.17 | 0.12 | −5.05 | −5.41 |
| best −5% | −7.13 | 0.12 | −7.01 | −7.36 |
| midpoint of avg and best | −4.89 | 0.12 | −4.84 | −4.98 |
| market average | −7.54 | 0.11 | −7.58 | −7.47 |

Line shopping is worth **+5.30 points**. The margin is 6.6. You lose by the difference,
and there is no haircut to measure because there is no edge to degrade: you would have to
beat the listed best price by 2.29% before the benchmark even reaches zero.

The two measurements locate each other. The archive's 2025-26 best-price overround is
**1.0329**, against Measurement A's 1.0339 at the open excluding exchanges and 1.0202 at
the close. The archive *is* the opening best price without exchanges — and that price
loses 4.88% over 7,094 matches. Which says where to look next: if the +1.58% CLV at the
close is real, the close and the exchange are doing all the work, and neither is in the
archive.

## 2. Why taking the best price buys you a worse bet

This is the finding that explains all the others.

Sort every selection into dispersion deciles — how far the best quote sits above the
consensus — computed *within* odds bands so the favourite-longshot effect is controlled:

| Decile | n | best/avg − 1 | implied prob | realised | difference | z |
|---|---|---|---|---|---|---|
| 1 | 43,343 | +0.32% | 33.69% | 34.82% | **+1.13pp** | +5.55 |
| 5 | 43,339 | +4.93% | 33.94% | 34.18% | +0.24pp | +1.16 |
| 8 | 43,339 | +7.89% | 32.73% | 32.06% | −0.68pp | −3.36 |
| 10 | 43,337 | +15.94% | 31.60% | 30.21% | **−1.39pp** | **−6.94** |

The gradient is −0.240pp per decile (t = −8.94, R² = 0.91) and survives a power de-vig,
so it is not an artefact of how the consensus was stripped of margin.

Now the decomposition. From decile 1 to decile 10 the extra *gross* price you capture
rises from +0.31pp to +12.68pp — a gain of 12.37 points. Over the same range the *net*
return moves from −2.34% to −1.81% — a gain of 0.53 points.

> **95.7% of the extra price is consumed by adverse selection.** Regressed directly,
> return at the best price against dispersion decile has slope +0.020pp (t = 0.29): flat.

The outlier book is an outlier because it knows something, and it knows almost exactly the
amount it is giving away. Chasing dispersion is the one thing this data punishes
monotonically: a rule of "bet where the best quote is at least d above consensus" returns
−2.29% at d = 0.02 and −7.22% at d = 0.12.

## 3. Selectivity, and the de-vig that manufactures a result

The natural way to use full selectivity is a threshold: de-vig the consensus into fair
probabilities, and bet the best price only when it beats fair by at least *t*. Swept over
t = 0.00 to 0.20, on 145,552 matches, under three de-vig methods, train and validation
kept apart:

**It does not exist.** The largest validation t-statistic in the primary table is **0.93**
against a Bonferroni bar of 3.08 for the 24 primary cells, 3.64 across all 184 cells
tested. No odds band, no outcome and no league is positive with |t| > 2 in both periods.

The instructive part is *how* it fails. Under multiplicative de-vig the rule looks
decisively bad and gets monotonically worse with t (−2.6% to −15.7% on train); under a
power de-vig it looks mildly good. The reason is calibration:

| Avg odds | n legs | multiplicative says | Shin | power | **actually happened** |
|---|---|---|---|---|---|
| 1.0-1.5 | 17,337 | 71.74% | 73.60% | 74.59% | **75.49%** |
| 2-3 | 113,096 | 38.79% | 39.05% | 39.13% | **38.89%** |
| 5-10 | 39,229 | 15.30% | 14.43% | 14.09% | **14.12%** |
| >10 | 7,436 | 7.21% | 6.04% | 5.79% | **5.29%** |

Multiplicative de-vig overstates longshots by 36% in relative terms. Since the rule fires
where `price x probability` is largest, an inflated probability on longshots selects
exactly the bets that lose — which is why the mean price it takes climbs to 15.9. **Power
is the best calibrated of the three on this data; multiplicative should not be used for
selection here at all.** The verdict is the same under every method; what changes is which
way you would have been wrong.

## 4. Where not to look

Soft markets are supposed to be the soft target. They are not:

| | overround at best | arb frequency | ROI at best |
|---|---|---|---|
| **Top five** (E0, D1, I1, SP1, F1) | **1.0054** | **30.7%** | **−1.46%** ± 0.30 |
| The other fourteen divisions | 1.0161 | 10.5% | −2.51% ± 0.13 |

It holds in both periods. More books quote the Premier League and the Bundesliga, so the
envelope of their quotes is tighter around fair; thin leagues have fewer quotes, wider
individual margins, and no compensating dispersion. The *value of shopping itself* is
near-identical (5.49pp against 5.24pp) — what differs is the margin you are shopping
against. Worst divisions at any price: Greece −6.27%, Portugal −5.19%.

## 5. The window is closing

| | 2005-06 | 2014-15 | 2025-26 |
|---|---|---|---|
| mean best/avg | 1.0927 | 1.0616 | **1.0446** |
| overround at best | 1.0301 | **1.0012** | 1.0329 |
| matches with arbitrage | 4.6% | **39.7%** | **0.9%** |
| ROI at best price | −4.19% | −0.67% | −4.88% |

The series is U-shaped and the floor was 2014-15. Dispersion between books has fallen
monotonically for twenty years — the robust trend, since it does not reverse at the point
where the mirror's bookmaker panel changed. Since 2014-15 the best price has decayed
0.25pp per season (t = −3.14) and arbitrage in this panel extrapolates to zero by 2027-28.
The partial 2026-27 season is already at −4.66%, worse than the trend line.

Part of the post-2014 reversal in *levels* is panel composition rather than the market
sharpening. The dispersion decline is established; the level reversal is directionally
suggestive.

## 6. Streaks match chance, explicitly

On the best surviving selection set (24,904 bets, 32.75% hit rate) the longest observed
winning run is **7**. Against 5,000 order-shuffles preserving the number of bets and wins,
chance gives a longest run averaging 8.74, with a 5th-95th range of [7, 11] and a maximum
of 22. **P(chance longest ≥ 7) = 0.999** — the observed streaks are *shorter* than chance,
not longer. Lag-1 autocorrelation is −0.0145; the hit rate after a win is 31.78% against
33.23% after a loss.

Every runs test, every permutation p-value and every autocorrelation is consistent with
independent flips at the same rate. Streak-chasing is not a strategy here. The one useful
number the streak analysis produces is the **longest losing run: 29**, which chance calls
unremarkable, and which is what the bankroll has to survive.

## 7. What is left standing, and why it is not a strategy

Two selection sets are positive in both periods.

**Short prices at the best quote.** Anything at 1.50 or below: +2.45% on train (n =
10,039, t = 4.27) and +1.85% on validation (n = 5,766, t = 2.43), positive in seven of
eight validation seasons, 721 bets a season across 19 divisions. This independently
reproduces the single survivor of the earlier 606-pattern search.

It is entirely line shopping. The identical selections at the consensus price return
**−1.86%** and **−1.13%**. There is no mispricing in the market's own number; the whole of
it is the gap between best quote and consensus, which means you must actually get the best
quote every time on selections every arbitrageur in Europe is watching. And it dies to
trivial erosion:

| price taken | pooled ROI | t |
|---|---|---|
| the full best price | +2.23% | 4.87 |
| −2% | +1.71% | 3.76 |
| **−5%** | **+0.94%** | 2.08 |
| −10% | −0.35% | — |

A 5% exchange commission *is* the −5% row. Given that the exchange supplies half the best
prices, most of this is already spent.

**Mid-priced draws**, 2.20 to 3.19, at the best price: +5.11% ± 1.63 on validation. It was
selected from 28 pre-specified cells, it dies at a 4.9% haircut, its post-2014 trend is
−0.46pp per season (t = −2.39), and over the last three seasons it is **+1.87% ± 3.40** —
which is nothing. It is a hypothesis for a forward-tracked sample, not a signal.

A clean demonstration of the trap sits in the same grid: the *best* training cell of the
28 (top-five home sides at 5-10) returned +15.78% on train and **−11.56%** on validation.
The train-validation correlation across all 28 cells is 0.295. Picking the maximum of 28
cells is picking noise.

## 8. The third freedom: what to stake, and what being wrong costs

Simulation over 50,000 paths per case, seed 20260915, cross-checked against the repo's
own `trading_edge_requirements` — which agreed on all 90 `bets_to_prove` values and all
45 Kelly stakes, and whose simulated log-growth matched the analytic value to within 0.1
basis points on all 30 combinations.

### How long before you know

| price | edge | bets to 2 sigma | seasons @200/yr | seasons @1000/yr | P(behind after 1,000 bets) |
|---|---|---|---|---|---|
| 1.5 | +1% | 19,796 | 99 | 19.8 | 32.7% |
| 1.5 | +2% | 4,896 | 24.5 | **4.9** | 18.3% |
| 2.0 | +2% | 9,996 | 50.0 | 10.0 | 26.4% |
| **3.0** | **+2%** | **20,196** | **101** | **20.2** | **32.8%** |
| 3.0 | +5% | 3,276 | 16.4 | 3.3 | 13.5% |
| 5.0 | +2% | 40,597 | 203 | 40.6 | 37.7% |
| 10.0 | +2% | 91,597 | 458 | 91.6 | 41.7% |

A genuine +2% edge at price 3.0 needs **twenty seasons** of a thousand bets to separate
from zero at two sigma, and leaves you behind after any given season a third of the time.
Realised profit is not a feedback signal on these timescales — closing-line value is, since
it converges in hundreds of trades instead of tens of thousands. The P&L is the payslip,
not the instrument panel.

### Drawdown is set by price, not by edge

Median maximum drawdown over a 1,000-bet campaign at flat 1-unit stakes is about 19u at
price 1.5, 29u at 2.0, 43u at 3.0, 64u at 5.0 and 98u at 10.0 — **almost unchanged**
whether the edge is 0.5% or 5%. Expressed in years of expected profit, the 90th-percentile
drawdown is 1.6 years at 1.5/+2%, 3.7 years at 3.0/+2%, and **26 years** at 2.0/+0.5%.

Working rule for a 1,000-bet season: one unit is 1% of bank at price 1.5-2.0, 0.5% at 3.0,
0.3% at 5.0, 0.2% at 10.0 — a bank of **100 to 250 units** depending on price. Flat-staking
2% of bank at price 3.0 carries a one-in-ten chance of losing 37% of it *with a real +2%
edge*.

### The estimation-error penalty, which is the whole section

Since Kelly is approximately `edge / (odds - 1)`, staking on a believed edge when the truth
is different is exactly staking a multiple of true Kelly — and growth turns **negative above
2x**. Staking half of Kelly and one-and-a-half times Kelly give *identical* growth, but only
one of them also multiplies the drawdown. The curve is symmetric in return and brutally
asymmetric in risk, so the error to make is the low one.

The realistic case is worse than the textbook one. The standard error of a 200-bet ROI
estimate is **±7.07 percentage points at price 2.0**: a true +2% will measure anywhere from
−12% to +16%, and you cannot tell it from +5% or from −3%. Sizing full Kelly on that record,
against a true +2% edge, over 1,000 bets:

| | growth/bet | median wealth | 10th pct | P(lose half) | P(lose 90%) |
|---|---|---|---|---|---|
| full Kelly on a 200-bet estimate | **−18.6 bp** | 0.678 | 0.001 | **62.5%** | **36.3%** |
| half Kelly on the same estimate | −1.4 bp | 1.047 | 0.184 | 37.6% | 10.3% |
| quarter Kelly on the same estimate | +1.3 bp | 1.094 | 0.599 | 14.9% | 0.9% |
| full Kelly *knowing* the edge is +2% | +2.0 bp | — | — | 18.3% | <0.1% |
| not betting at all | 0 | 1.000 | 1.000 | 0% | 0% |

> **A real edge, over-bet on a noisy estimate, is worse than no bet at all.** The loss is
> not from being wrong about the edge — the edge is there — it is entirely from the sizing.

The same shape appears in the cleaner cases: a true +2% sized as +5% loses 21.8% of the bank
per 1,000 bets at price 2.0, and a phantom edge (true 0%, believed +3%) loses 36.1% at full
Kelly against 2.7% at quarter Kelly. Fractional Kelly is not a timidity discount. It is the
premium on insurance against your own estimate.

If you want to size on a measurement at all, **shrink it first**. Against a prior of 2
percentage points — defensible, since the best-price margin is about 2% — a 200-bet record
at price 2.0 justifies staking **7.4%** of what the point estimate suggests. A 1,000-bet
record raises that to 28.6%. You earn the right to size up by accumulating evidence.

### What it would take, and where the line is

Targeting 5,000 a season in flat stakes, with a bank where a one-in-a-hundred run costs half
of it:

| price | true edge | stake | bankroll | return on bank | turnover/yr | seasons to proof |
|---|---|---|---|---|---|---|
| 1.5 | **+2%** | 250 | **25k** | **20.0%** | 250k | 4.9 |
| 2.0 | **+2%** | 250 | **50k** | **10.0%** | 250k | 10.0 |
| 3.0 | +2% | 250 | 100k | 5.0% | 250k | 20.2 |
| 2.0 | +1% | 500 | 200k | 2.5% | 500k | 40 |
| 2.0 | +0.5% | 1,000 | **800k** | **0.6%** | 1.0M | 160 |

| true edge | verdict |
|---|---|
| **at or below +1%** | **Do not bet.** The bank is 4 to 36 times the annual profit, the return on it is 0.2-5%, and 20 to 3,200 seasons are needed to confirm it. You will never learn whether you had it. |
| **+2%, price at or below 2.0, 1,000+ bets a year** | **Marginally viable.** A 25-50k bank returns 10-20% a year, proof in 5-10 seasons, worst normal drawdown 25-32% of bank. This is the boundary case — and the only one the market data says is on offer. |
| **+2%, price 3.0 or longer** | **Not viable.** Twenty seasons to confirm, 5% or less on bank. |
| **+5% or more** | Comfortable everywhere, and almost certainly not real: against a 2% best-price margin it means beating the close by 7%, where this repo's model loses to it by 9%. Treat it as measurement error until 1,500 bets say otherwise, and size it as +2% meanwhile. |

A note on the repo's own tool. `trading_edge_requirements` reports ruin risk from the
standard `a^(2/k - 1)`, which contains neither the edge nor the price — it is the
**unbounded-horizon** limit, so it returns 50% / 12.5% / 0.8% for bank-halving at full,
half and quarter Kelly no matter what you pass it. Simulation confirms the formula (50.6%
at 100,000 bets against 50.0% predicted) and confirms that one season is far safer: 1.7%
after 1,000 bets at +1% and price 2.0, 23.2% after 5,000. The tool now ships that horizon
in the payload, because a number that alarming should not arrive without its timescale.

## 9. What the three freedoms are actually worth

**Any price** is the real lever, and the only one that is measurable. It recovers 5.3 of
the 6.6 points of margin and leaves you at roughly break-even — closer to zero at the
close, further from it at the open, and further still once commission is real. It is worth
more than any model in this repository, and it is not enough on its own.

**Only when you want** is worth nothing without something to select on. The forecasting
model cannot do it (it loses to the market by 3%). Price dispersion cannot do it — it is
actively harmful, since 95.7% of what dispersion offers is taken back. The consensus
already knows what the best quote knows.

**Whatever stake you like** is worth nothing without the first two, and is actively
destructive with an edge you have merely estimated: a genuine +2% edge, sized full Kelly on
a 200-bet measurement of itself, loses 18.6 basis points a bet and halves the bank 62.5% of
the time — worse than never betting. Quarter Kelly or flatter, on a bank of 100 to 250
units, sized on a shrunk estimate rather than a point estimate.

Anything built on top of the best price must generate **1.3 points** of genuine selection
skill before the first unit of profit, and **2.3 points** before it can absorb one point
of slippage. Nothing in this repository generates either.
