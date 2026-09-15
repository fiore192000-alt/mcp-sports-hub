# Drop football-data.co.uk CSVs here

The toolkit reads this directory **before** the network, so a file you download
in a browser works on a machine that cannot reach the site at all — blocked
network, outage, or rate limit.

## Layout

Exactly the site's own, so downloaded files go in unchanged:

```
data/football-data/
├── fixtures.csv          # https://www.football-data.co.uk/fixtures.csv
├── 2627/
│   ├── I1.csv            # https://www.football-data.co.uk/mmz4281/2627/I1.csv
│   └── E0.csv
└── 2526/
    └── I1.csv
```

Season codes are four digits: `2627` = 2026-27. League codes: `I1` Serie A,
`E0` Premier League, `SP1` La Liga, `D1` Bundesliga, `F1` Ligue 1 — the full
list is in `trading_list_strategies`.

Point somewhere else with `SPORTS_HUB_DATA_DIR=/path/to/csvs`.

## Why it matters

These CSVs carry the **bookmaker odds**, and nothing else the toolkit can
reach does. Without them:

- predictions have no market to be compared against, so `benchmarks.market`
  and `skill_vs_market_pct` stay empty — the model can only be measured
  against base rates, which is a floor, not a benchmark;
- there are no edges, so no picks and no stakes;
- `trading_backtest` cannot run at all, since a backtest without prices is
  just a list of results.

With them, all of the above light up automatically. Nothing else needs
configuring, and the tools report which source answered.

The season subdirectories are gitignored. The CSVs are football-data.co.uk's
data, not this repository's, so redistributing them is left to whoever
downloads them; this README and the layout are all that is tracked.

## What has been measured with files dropped in here

Two complete Premier League seasons (2021-22 and 2023-24) were enough to answer
the question the toolkit was built around, and the answer is in
[docs/Evaluation.md](../../docs/Evaluation.md): **the model loses to the
market**, betting its disagreements loses 13-27% of turnover, and blending it
into the market helps at no weight. To reproduce, download

- `https://www.football-data.co.uk/mmz4281/2324/E0.csv` into `2324/E0.csv`
- `https://www.football-data.co.uk/mmz4281/2122/E0.csv` into `2122/E0.csv`

and run `npm run track -- hindcast --leagues E0 --seasons 2324 --source footballdata`.
