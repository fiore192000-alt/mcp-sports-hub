# How good is the model, actually

Run on every season the keyless source covers: **19,062 matches, 55
league-seasons, five leagues, 2015-16 to 2025-26**. Every prediction is
walk-forward — each match is rated using only results from before it, with the
previous season pooled in and weighted by recency. No lookahead, no tuning per
season, one parameter set throughout (`half_life_days: 240`, `rho: -0.1`,
minimum 4 matches of history per side).

Reproduce it with:

```bash
npm run track -- hindcast --leagues I1,E0,SP1,D1,F1 \
  --seasons 1516,1617,1718,1819,1920,2021,2122,2223,2324,2425,2526
```

## Headline

| Metric | Model | Base rates (44/26/30) |
|---|---|---|
| Ranked probability score | **0.2011** | 0.2298 |
| Brier | 0.5882 | — |
| Log loss | 0.9868 | — |
| Hit rate | 52.3% | ~44% |

**Skill vs base rates: 12.5%.** Not one of the 55 league-seasons finished below
the base rates; the worst was Ligue 1 2018-19 at +7.1%, the best Serie A
2017-18 and the Premier League 2018-19 at +21.3%.

## By league

| League | Matches | Hit rate | RPS | Skill |
|---|---|---|---|---|
| Serie A (`I1`) | 4,021 | 53.7% | 0.1952 | **15.5%** |
| Premier League (`E0`) | 4,025 | 53.4% | 0.2013 | 13.3% |
| La Liga (`SP1`) | 4,026 | 52.1% | 0.1982 | 12.2% |
| Bundesliga (`D1`) | 3,258 | 51.4% | 0.2056 | 10.8% |
| Ligue 1 (`F1`) | 3,732 | 50.8% | 0.2063 | 10.1% |

## By season (skill vs base rates)

| Season | I1 | E0 | SP1 | D1 | F1 | Pooled |
|---|---|---|---|---|---|---|
| 2015-16 | 10.2% | 7.8% | 13.5% | 10.3% | 8.1% | **10.0%** |
| 2016-17 | 19.3% | 15.5% | 19.9% | 9.7% | 11.3% | **15.4%** |
| 2017-18 | 21.3% | 15.8% | 14.0% | 7.7% | 14.1% | **14.9%** |
| 2018-19 | 15.4% | 21.3% | 7.4% | 12.5% | 7.1% | **12.9%** |
| 2019-20 | 13.8% | 12.0% | 10.2% | 13.6% | 8.1% | **11.7%** |
| 2020-21 | 17.2% | 10.9% | 11.9% | 9.0% | 10.9% | **12.1%** |
| 2021-22 | 15.1% | 15.5% | 10.5% | 8.4% | 8.8% | **11.8%** |
| 2022-23 | 12.3% | 8.6% | 7.8% | 8.4% | 13.1% | **10.1%** |
| 2023-24 | 15.2% | 16.1% | 16.3% | 15.0% | 8.4% | **14.4%** |
| 2024-25 | 16.5% | 14.2% | 13.1% | 10.2% | 12.4% | **13.4%** |
| 2025-26 | 14.2% | 8.0% | 9.4% | 13.9% | 8.1% | **10.7%** |

2019-20 and 2023-24 Ligue 1 carry fewer matches: the first was cut short, the
second is a 18-team season. The numbers are whatever the data says.

## Calibration

The part that matters most, and the part a hit rate hides. Across 19,062
matches, every predicted probability (all three outcomes, not just the pick):

| Said | Matches | Happened |
|---|---|---|
| 0-10% | 1,703 | 7.1% (said 7.0%) |
| 10-20% | 7,475 | 15.5% (said 15.8%) |
| 20-30% | 21,227 | 25.5% (said 25.6%) |
| 30-40% | 11,300 | 33.3% (said 34.0%) |
| 40-50% | 6,542 | 45.5% (said 44.7%) |
| 50-60% | 4,498 | 54.7% (said 54.7%) |
| 60-70% | 2,678 | 67.0% (said 64.5%) |
| 70-80% | 1,246 | 74.8% (said 74.4%) |
| 80-90% | 473 | 85.4% (said 83.6%) |
| 90-100% | 44 | 88.6% (said 92.0%) |

Within a point almost everywhere. The model is mildly under-confident at the
top (60-90%) and over-confident in the thin 90-100% bucket, where 44 samples
say nothing.

## What this does not show

**It has never been compared to a bookmaker.** Base rates are a floor, not a
benchmark — beating "home wins 44% of the time" is the minimum a model must do
to be worth running, not evidence that it is any good. The comparison that
decides whether these probabilities are worth money is against the closing
market, and it is missing here for one reason: the source that carries odds
(football-data.co.uk) was unreachable from the machine that ran this, so every
number above comes from the odds-free mirror.

Run the same sweep where that archive is reachable and
`trading_score_predictions` will fill in `benchmarks.market` and
`skill_vs_market_pct` automatically, from the prices recorded at prediction
time. Until then, treat 12.5% skill as "the model is calibrated and clearly
better than nothing", not as "the model beats the market".

A model can be beautifully calibrated and still lose money against every
bookmaker in Europe. Those are different questions, and only one of them is
answered here.

## Trying to make it better

Every idea below was chosen on training seasons (2016-17 to 2020-21) and
scored on validation seasons the search never saw (2021-22 to 2025-26), over
the top three leagues. Reproduce with `npm run tune -- --compare`.

| Variant | Train RPS | Validation RPS | vs baseline |
|---|---|---|---|
| **baseline** (240d half-life, prior 4, rho -0.1) | 0.19550 | **0.19992** | — |
| no recency decay | 0.19544 | 0.20047 | -0.28% |
| fast decay (120d) | 0.19685 | 0.20079 | -0.44% |
| slow decay (540d) | 0.19527 | 0.20001 | -0.05% |
| weak shrinkage (2) | 0.19540 | 0.19997 | -0.03% |
| strong shrinkage (16) | 0.19915 | 0.20255 | -1.31% |
| no Dixon-Coles (rho 0) | 0.19547 | 0.20000 | -0.04% |
| strong Dixon-Coles (rho -0.15) | 0.19562 | 0.19997 | -0.03% |
| blend 5% toward base rates | 0.19581 | 0.20007 | -0.08% |
| blend 20% toward base rates | 0.19763 | 0.20138 | -0.73% |
| separate home/away ratings | 0.19767 | 0.20213 | -1.11% |

**Nothing helped.** A 96-cell grid over half-life, shrinkage and rho found a
combination 0.2% better on training that was 0.15% *worse* on validation —
the signature of fitting noise. The hand-picked defaults are already at the
plateau of what goals-only ratings can do, and several plausible ideas (venue
splits, blending, heavier shrinkage) make it clearly worse.

This is the useful negative result: **the ceiling here is the input, not the
fitting.** More parameter search on the same data will not move it.

### The one thing that did help, and it is not accuracy

Giving a newly promoted side an assumed rating (0.85 attack, 1.15 defence)
instead of refusing to predict it:

| | Matches | RPS |
|---|---|---|
| Fixtures both variants cover | 5,508 | 0.19992 either way — **identical** |
| Fixtures the baseline refuses | 172 | **0.19135** (base rates: 0.2298) |

So it changes nothing for rated teams and predicts the previously-unpredictable
ones better than the model's own average — a coverage gain, not an accuracy
gain, and worth having for exactly that reason. It is on by default, each
affected fixture names the assumption in `assumed_prior_for`, and
`rate_promoted: false` turns it off. It applies to at most one side: with both
teams unknown the forecast would be the prior playing itself, so those are
still declined.

## What would actually move the number

In the order the evidence supports:

1. **Bookmaker odds.** Blending a model with the market is the most reliable
   accuracy gain in the forecasting literature, and without prices there is no
   way to know whether 0.20 is good. Drop CSVs into `data/football-data/`
   (see the README there) or allow `www.football-data.co.uk` through the
   network.
2. **Shot quality (xG).** Goals are a noisy sample of chances; ratings built on
   expected goals converge faster and rate a team that lost 0-1 having had 18
   shots correctly. This is the biggest *modelling* upgrade available, and it
   needs a source this repo cannot currently reach.
3. **Team news.** Lineups, injuries and suspensions published an hour before
   kick-off are most of what moves a market between opening and closing.

## Trying to make it better

Every idea below was chosen on training seasons (2016-17 to 2020-21) and
scored on validation seasons the search never saw (2021-22 to 2025-26), over
the top three leagues. Reproduce with `npm run tune -- --compare`.

| Variant | Train RPS | Validation RPS | vs baseline |
|---|---|---|---|
| **baseline** (240d half-life, prior 4, rho -0.1) | 0.19550 | **0.19992** | — |
| no recency decay | 0.19544 | 0.20047 | -0.28% |
| fast decay (120d) | 0.19685 | 0.20079 | -0.44% |
| slow decay (540d) | 0.19527 | 0.20001 | -0.05% |
| weak shrinkage (2) | 0.19540 | 0.19997 | -0.03% |
| strong shrinkage (16) | 0.19915 | 0.20255 | -1.31% |
| no Dixon-Coles (rho 0) | 0.19547 | 0.20000 | -0.04% |
| strong Dixon-Coles (rho -0.15) | 0.19562 | 0.19997 | -0.03% |
| blend 5% toward base rates | 0.19581 | 0.20007 | -0.08% |
| blend 20% toward base rates | 0.19763 | 0.20138 | -0.73% |
| separate home/away ratings | 0.19767 | 0.20213 | -1.11% |

**Nothing helped.** A 96-cell grid over half-life, shrinkage and rho found a
combination 0.2% better on training that was 0.15% *worse* on validation —
the signature of fitting noise. The hand-picked defaults are already at the
plateau of what goals-only ratings can do, and several plausible ideas (venue
splits, blending, heavier shrinkage) make it clearly worse.

This is the useful negative result: **the ceiling here is the input, not the
fitting.** More parameter search on the same data will not move it.

### The one thing that did help, and it is not accuracy

Giving a newly promoted side an assumed rating (0.85 attack, 1.15 defence)
instead of refusing to predict it:

| | Matches | RPS |
|---|---|---|
| Fixtures both variants cover | 5,508 | 0.19992 either way — **identical** |
| Fixtures the baseline refuses | 172 | **0.19135** (base rates: 0.2298) |

So it changes nothing for rated teams and predicts the previously-unpredictable
ones better than the model's own average — a coverage gain, not an accuracy
gain, and worth having for exactly that reason. It is on by default, each
affected fixture names the assumption in `assumed_prior_for`, and
`rate_promoted: false` turns it off. It applies to at most one side: with both
teams unknown the forecast would be the prior playing itself, so those are
still declined.

## What would actually move the number

In the order the evidence supports:

1. **Bookmaker odds.** Blending a model with the market is the most reliable
   accuracy gain in the forecasting literature, and without prices there is no
   way to know whether 0.20 is good. Drop CSVs into `data/football-data/`
   (see the README there) or allow `www.football-data.co.uk` through the
   network.
2. **Shot quality (xG).** Goals are a noisy sample of chances; ratings built on
   expected goals converge faster and rate a team that lost 0-1 having had 18
   shots correctly. This is the biggest *modelling* upgrade available, and it
   needs a source this repo cannot currently reach.
3. **Team news.** Lineups, injuries and suspensions published an hour before
   kick-off are most of what moves a market between opening and closing.

## Trying to make it better

Every idea below was chosen on training seasons (2016-17 to 2020-21) and
scored on validation seasons the search never saw (2021-22 to 2025-26), over
the top three leagues. Reproduce with `npm run tune -- --compare`.

| Variant | Train RPS | Validation RPS | vs baseline |
|---|---|---|---|
| **baseline** (240d half-life, prior 4, rho -0.1) | 0.19550 | **0.19992** | — |
| no recency decay | 0.19544 | 0.20047 | -0.28% |
| fast decay (120d) | 0.19685 | 0.20079 | -0.44% |
| slow decay (540d) | 0.19527 | 0.20001 | -0.05% |
| weak shrinkage (2) | 0.19540 | 0.19997 | -0.03% |
| strong shrinkage (16) | 0.19915 | 0.20255 | -1.31% |
| no Dixon-Coles (rho 0) | 0.19547 | 0.20000 | -0.04% |
| strong Dixon-Coles (rho -0.15) | 0.19562 | 0.19997 | -0.03% |
| blend 5% toward base rates | 0.19581 | 0.20007 | -0.08% |
| blend 20% toward base rates | 0.19763 | 0.20138 | -0.73% |
| separate home/away ratings | 0.19767 | 0.20213 | -1.11% |

**Nothing helped.** A 96-cell grid over half-life, shrinkage and rho found a
combination 0.2% better on training that was 0.15% *worse* on validation —
the signature of fitting noise. The hand-picked defaults are already at the
plateau of what goals-only ratings can do, and several plausible ideas (venue
splits, blending, heavier shrinkage) make it clearly worse.

This is the useful negative result: **the ceiling here is the input, not the
fitting.** More parameter search on the same data will not move it.

### The one thing that did help, and it is not accuracy

Giving a newly promoted side an assumed rating (0.85 attack, 1.15 defence)
instead of refusing to predict it:

| | Matches | RPS |
|---|---|---|
| Fixtures both variants cover | 5,508 | 0.19992 either way — **identical** |
| Fixtures the baseline refuses | 172 | **0.19135** (base rates: 0.2298) |

So it changes nothing for rated teams and predicts the previously-unpredictable
ones better than the model's own average — a coverage gain, not an accuracy
gain, and worth having for exactly that reason. It is on by default, each
affected fixture names the assumption in `assumed_prior_for`, and
`rate_promoted: false` turns it off. It applies to at most one side: with both
teams unknown the forecast would be the prior playing itself, so those are
still declined.

## What would actually move the number

In the order the evidence supports:

1. **Bookmaker odds.** Blending a model with the market is the most reliable
   accuracy gain in the forecasting literature, and without prices there is no
   way to know whether 0.20 is good. Drop CSVs into `data/football-data/`
   (see the README there) or allow `www.football-data.co.uk` through the
   network.
2. **Shot quality (xG).** Goals are a noisy sample of chances; ratings built on
   expected goals converge faster and rate a team that lost 0-1 having had 18
   shots correctly. This is the biggest *modelling* upgrade available, and it
   needs a source this repo cannot currently reach.
3. **Team news.** Lineups, injuries and suspensions published an hour before
   kick-off are most of what moves a market between opening and closing.

## Against a bookmaker, at last

Everything above measures the model against base rates, because the source
carrying odds was unreachable. With two complete Premier League seasons dropped
into `data/football-data/` (2021-22 and 2023-24, 679 matches with both opening
and closing prices), the comparison that matters can finally be made.

| Forecaster | RPS | Hit rate |
|---|---|---|
| **Closing line** (de-vigged, Shin) | **0.1868** | 59.6% |
| Opening line (de-vigged, Shin) | 0.1886 | — |
| Base rates (44/26/30) | 0.2347 | ~44% |
| **This model** | **0.2040** | 53.6% |

**The model loses to the market by 9.2%, and to the opening line by 8.2%.** It
beats base rates by 13%, which is the same result as before and now clearly
worth much less than it sounded.

### Blending does not rescue it

Mixing the model into the market at weight *w*, scored on the same 679 matches:

| Model weight | 0% | 10% | 20% | 30% | 50% | 100% |
|---|---|---|---|---|---|---|
| RPS | **0.18677** | 0.18771 | 0.18882 | 0.19011 | 0.19320 | 0.20397 |
| vs market | — | -0.50% | -1.10% | -1.79% | -3.45% | -9.21% |

The optimum is zero. Every gram of this model added to the market makes the
forecast worse, monotonically. In the forecasting literature a well-built model
usually earns a small positive weight; this one earns none.

### Betting its disagreements loses money

Backing the model's edge against the **opening** price, same 679 matches:

| Minimum edge | Bets | ROI | Mean CLV |
|---|---|---|---|
| 2% | 571 | **-13.6%** | -6.41% |
| 5% | 498 | -19.1% | -6.53% |
| 10% | 407 | -24.4% | -6.95% |
| 20% | 262 | **-27.5%** | -7.63% |

The pattern is the damning part: **the bigger the model's disagreement with the
market, the more wrong it is.** Consistently negative closing-line value says
the same thing — these bets are taken at prices the market then moves away
from, in the wrong direction.

This is why `trading_predict_fixtures` no longer suggests picks by default.
`suggest_picks: true` still works, for a model you have measured yourself, and
every response carrying picks carries these numbers with it.

### Flat strategies on the same data

760 bets per strategy, closing prices, market-average book, over both seasons:

| Strategy | Strike | Average odds | ROI | Max drawdown |
|---|---|---|---|---|
| favourite | 59.6% | 1.85 | **+4.9%** | 13.0% |
| over 2.5 | 59.3% | 1.77 | +2.5% | 20.7% |
| home | 44.5% | 3.04 | -7.6% | 61.7% |
| away | 33.2% | 4.81 | -7.2% | 69.7% |
| draw | 22.4% | 4.44 | -9.6% | 85.6% |
| underdog | 19.3% | 6.14 | -11.3% | 88.7% |
| under 2.5 | 40.7% | 2.26 | -12.2% | 96.1% |
| value_model (5% edge) | — | — | **-15.8%** | — |

Most strategies lose roughly the bookmaker's margin, which is what should
happen. Two are positive — and two Premier League seasons is 760 bets down a
single path, nowhere near enough to call that an edge rather than variance. The
favourite-longshot bias they hint at is real in the literature; this sample
cannot establish it, and a strategy is not a strategy until it survives seasons
it was not chosen on.

`value_model` is the model betting itself: it claimed an average edge of +32%
and returned -15.8%. A model that is confident and wrong is worse than one that
is uncertain.

### What this changes

The toolkit's measurement machinery works — it detected its own model's
worthlessness against the market within minutes of getting real prices, which
is exactly what it was built to do. The model does not.

Nothing here says the pipeline is wrong. It says goals-only ratings cannot
compete with a market that prices team news, lineups and money flow. The next
step is better inputs (shot quality, availability), not more fitting, and any
future model should be put through this same sequence before a single bet.

## Is a different model the answer? No.

`xgabora/Club-Football-Match-Data` publishes 238k matches with pre-match odds
**and Elo ratings** — Elo being an entirely different rating system, built by
other people from the same match results. Putting it head to head with this
toolkit's Poisson model, on the same 8,069 matches (five leagues, 2022 to
September 2026, all three forecasters present):

| Forecaster | RPS | Hit rate | vs market |
|---|---|---|---|
| Base rates | 0.23032 | 43.6% | -17.88% |
| Elo (rating difference alone) | 0.20129 | 52.5% | -3.02% |
| **This model (Poisson)** | 0.20118 | 52.5% | **-2.96%** |
| Elo + Poisson, 50/50 | 0.20036 | 52.7% | -2.54% |
| **Market** (average price, de-vigged) | **0.19539** | 53.9% | — |
| Market + 10% Elo | 0.19561 | 53.8% | -0.11% |
| Market + 10% Poisson | 0.19563 | 53.8% | -0.12% |

Elo lands within 0.0001 RPS of the Poisson model. Two unrelated methods, built
by different people, hitting the same wall to four decimal places is not a
coincidence: **it is the ceiling of what match results alone contain.**

Ensembling the two does gain something real (-2.54% against -2.96%), which is
what decorrelated errors are supposed to do. It is not shipped: it doubles the
model surface to move a number that changes no decision, since neither version
comes close to the market. The measurement is here if that ever stops being
true.

And once more, from a third independent angle: nothing added to the market
improves it.

The gap is smaller here (-3%) than in the Premier League study above (-9%)
because this dataset carries the market **average** price, while that one used
the **closing** line. Both are the same finding at different sharpness: the
model trails the average price by about 3% and the closing line by about 9%.

## Which strategy would have returned the most?

None of them. Every one loses, and the sample is large enough to say so
without hedging: 19 leagues, 2005-06 to 2026-27, **over a million bets** across
the sweep. Reproduce with `npm run fetch:archive && npm run sweep`.

Strategies are run on 2005-2019 and again on 2019-2027, a period they were not
chosen on. ROI is flat-stake, with the standard error of the estimate — without
it a small number looks like a result when it is the width of the noise.

| Strategy | Market average price | Best available price | Validation odds |
|---|---|---|---|
| favourite | -3.61% ±0.50 | **-0.51% ±0.47** | 2.07 |
| draw | -4.89% ±0.97 | -0.48% ±0.87 | 3.99 |
| home | -6.17% ±0.64 | -2.21% ±0.64 | 2.74 |
| over 2.5 | -5.96% ±0.57 | -2.27% ±0.48 | 1.99 |
| under 2.5 | -6.10% ±0.54 | -2.59% ±0.46 | 2.02 |
| away | -7.57% ±1.19 | -2.86% ±1.00 | 4.27 |
| underdog | -8.73% ±1.34 | -3.18% ±1.08 | 5.07 |

*(validation period; ± is one standard error)*

- **Nothing is positive in both periods.** Not one of the 14 combinations.
- **Nothing is more than two standard errors above zero** in validation either.
- The best validation number, `draw` at best price (-0.48%), returned -3.56% in
  training. The best training number, `home` at best price (-0.06%), returned
  -2.21% in validation. That flip is what data mining looks like from the
  inside.
- The most precisely measured is `favourite` at best price: -0.30% training,
  -0.51% validation, 135,000 bets between them. Tight, consistent, and
  negative — the residual house edge after shopping, measured.

The model-driven strategy on the same data: `value_model` at best price with a
10% edge threshold returned **+0.23% over 7,071 bets**. At those odds the
standard error is about 2.4 points, so that is zero with a decoration. Loosen
the threshold to 5% and it is -0.61%; tighten it to 20% and it is -1.83%. At
the market average price it is -6.47%.

### The one thing that was worth real money

Look down the two price columns rather than across the strategies. Taking the
**best available price instead of the market average** is worth about **four to
five percentage points of ROI on every strategy** — more than the entire spread
between the best and worst strategy in either column.

| | Average price | Best price | Gained |
|---|---|---|---|
| favourite | -3.61% | -0.51% | **+3.1** |
| home | -6.17% | -2.21% | **+4.0** |
| over 2.5 | -5.96% | -2.27% | **+3.7** |
| underdog | -8.73% | -3.18% | **+5.6** |

This is the practical finding of the whole exercise: **where you place the bet
matters more than what you bet on.** Line shopping does not turn a loser into a
winner — favourite at best price is still -0.5% — but it recovers most of the
bookmaker's margin, and it requires no model at all.

The caveat that keeps it honest: `max` is the best price *any* book offered,
recorded after the fact. Holding accounts at every one of them, getting on
before the price moves, and not being limited when you keep taking the top of
the market are the reasons this is an upper bound rather than a plan.
