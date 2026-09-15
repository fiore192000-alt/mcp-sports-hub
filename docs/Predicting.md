# Predicting a season and tracking how it goes

Three `trading_` tools form a loop you can run every week: predict the coming
fixtures, save what you predicted, and score it once the matches are played.
No API key is needed — the data comes from the keyless
[football-data.co.uk](https://www.football-data.co.uk/) archive.

The point of the loop is the scoring. A model that is never scored against the
market is entertainment.

## 1. Predict the coming round

```
trading_predict_fixtures
  leagues: "I1"          # Serie A. Comma-separate up to 8: "I1,E0,SP1"
  season: "2627"         # optional — defaults to the season in progress
  days_ahead: 10
  min_edge_pct: 5
```

It fits attack/defence ratings on the season so far (plus the previous season
by default, weighted down by recency), prices every upcoming fixture with a
Dixon-Coles Poisson model, and puts the model's probabilities next to the
bookmakers' own de-vigged prices. Where the disagreement clears
`min_edge_pct`, the fixture gets a suggested pick and a quarter-Kelly stake.

The upcoming-fixtures file covers roughly the next week and is empty during
international breaks — if nothing comes back, that is usually why.

Teams the ratings have never seen (newly promoted sides, in the first season
after promotion) come back under `unrated` rather than being guessed at.

## 2. Save the predictions

Keep the `predictions` array verbatim. It is already in the shape the scorer
wants, and it carries the market prices as they were when you predicted —
which is what makes the benchmark meaningful later.

## 3. Score them once the matches are played

```
trading_score_predictions
  predictions: [ ...the array you saved... ]
```

The archive updates within a few days of each round, so score last week's
predictions when you make this week's.

You get back:

| Metric | What it tells you |
|---|---|
| `hit_rate_pct` | How often the most likely outcome happened. Easy to read, weak as evidence — always shown next to the market's hit rate on the same matches. |
| `rps` | Ranked probability score, the standard 1X2 metric. Lower is better, 0 is perfect. It punishes being confidently wrong, which hit rate does not. |
| `benchmarks.market` | The same scores for the bookmakers' de-vigged prices. This is the bar. Beating base rates is trivial; beating the market is the whole question. |
| `skill_vs_market_pct` | How much better (or worse) your RPS is than the market's. |
| `calibration` | Of the matches you called 60-70%, how many actually happened? A well-calibrated model lands near the diagonal even when its hit rate is mediocre. |
| `picks` | Strike rate, ROI and closing-line value of the bets the model suggested. |

## What to expect

- **Early in a season the market will beat the model.** The ratings are mostly
  last season plus a prior, while the bookmakers price team news, transfers
  and money flow. This is normal, and the scorer says so.
- **Sample size dominates.** Under a few hundred scored matches, any gap
  between model and market is noise. The verdict line repeats this because it
  is the single easiest thing to forget.
- **Predict before kick-off.** Nothing in the scorer can tell whether a
  prediction was made before or after the result; that honesty is yours to
  keep.

## Related

- [`trading_backtest`](Tools-Reference.md) — the same model measured over past
  seasons, with ROI, drawdown and closing-line value.
- [`trading_team_ratings`](Tools-Reference.md) — the ratings themselves, and
  one-off pricing of a single fixture.
- The `predict-and-track` prompt runs the whole loop, scoring first.
