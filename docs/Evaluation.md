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
