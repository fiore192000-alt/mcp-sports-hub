# Collecting

Two scripts, on the principle that you find out what is gatherable before
deciding what to gather.

## `npm run inventory` — what this machine can actually reach

Probes every provider on one cheap endpoint and classifies it **LIVE**,
**NEEDS_KEY**, **PARTIAL**, **BLOCKED** or **ERROR**.

The distinction that matters is NEEDS_KEY against BLOCKED: one is a free signup
away, the other cannot be solved from this machine at all. Getting it right took
a correction. An egress proxy can answer `403` to the CONNECT itself, and that
arrives looking exactly like an API saying "no key" — the first run of this
script reported eleven providers as NEEDS_KEY that were nothing of the kind. The
tell is a `text/plain` body reading *"Host not in allowlist: <host>. Add this
host to your network egress settings to allow access."*, and the script now
detects it.

Run from this container, the honest answer is stark:

| | Count |
|---|---|
| LIVE | **2** |
| BLOCKED by egress policy | **32** |

The two are `raw.githubusercontent.com` mirrors. Everything else — ESPN, the NHL
and MLB APIs, Lichess, Sleeper, OpenLigaDB, all four odds providers, both
Polymarket endpoints, and football-data.co.uk itself — is unreachable here, and
no API key changes that.

So: **a live collector cannot run in this environment.** Run it where those
hosts are reachable, or add them to the environment's egress allowlist. The
script prints the exact host list to paste.

## `npm run collect` — the collector, deliberately stupid

```bash
npm run collect -- backfill --leagues E0,I1 --seasons 2425,2526
npm run collect -- snapshot --leagues E0
npm run collect -- status
```

It records what a price **was** at a moment. It does not decide whether that
price is interesting, does not de-vig, does not compute an edge, does not rank
anything. Every judgement made on the way in is a judgement that cannot later be
re-made differently, and the whole value of the archive is that it can be
re-read by a question nobody has asked yet.

### Storage

Append-only NDJSON under `data/collected/<stream>/<UTC day>.ndjson`. Never
rewrites a line. NDJSON rather than Parquet because appending is the only write
this thing does and it needs no dependency to do it — and DuckDB reads it
directly:

```sql
SELECT venue, market, count(*), avg(price)
FROM read_json_auto('data/collected/odds/*.ndjson')
GROUP BY 1, 2;
```

Three streams:

| Stream | Row |
|---|---|
| `odds` | `match_id, league, kickoff_date, home, away, source, venue, market, selection, price, available_stake, price_taken_at, observed_at, phase` |
| `results` | `match_id, …, ft_home, ft_away, ht_home, ht_away, result, home_elo, away_elo` |
| `collection_log` | every run, including the failures |

That last stream is not bookkeeping. **A gap you cannot see is a gap you will
silently read as an absence of events** — no price movement, no news, nothing
happening — when in fact the collector was down.

### `price_taken_at` is null in the backfill, on purpose

The archive records a price but not when it was taken. Writing `observed_at`
into that field would be indistinguishable, a year from now, from a timestamp
that was real. So it stays null, and the gap is the argument for snapshotting:
the open-to-close series is the one thing the research programme needs and the
one thing no archive contains.

### Backfill, measured

```
238,858 matches in the archive. Filtering to E0,I1 over 2425,2526.
  E0      760 matches
  I1      760 matches
15,200 price observations, 1,520 results.
```

Ten observations per match: 1X2 and Over/Under 2.5, each at the market average
and at the best of the panel. Source is the keyless
[Club-Football-Match-Data](https://github.com/xgabora/Club-Football-Match-Data-2000-2025)
mirror, 2000 to 2025, which also carries Elo.

### Snapshot needs a key, and says so rather than looking healthy

No keyless source publishes live prices with timestamps. Without
`THE_ODDS_API_KEY` the snapshot command writes a `skipped` line to
`collection_log` and explains that history can be backfilled but the
open-to-close series cannot be built. It does not write an empty file and exit 0.

## The closing line is free after all

An earlier version of this page said no free source publishes a closing line.
**That was wrong**, and the correction is the most valuable thing on it.

[`huhao930422-debug/football-odds-mirror`](https://github.com/huhao930422-debug/football-odds-mirror)
mirrors football-data.co.uk's own CSVs *whole*, closing columns included, updated
daily by a GitHub Action. Since `raw.githubusercontent.com` is a different origin
from the blocked one, the historical open-to-close series is reachable here.

Verified rather than trusted, which matters for a mirror nobody vouches for:

| Check | Result |
|---|---|
| Its 2023-24 Premier League file against a copy downloaded from football-data.co.uk directly | **380 of 380 fixtures matched, 0 differing cells across 4,560 closing-odds values, 380/380 identical scores** |
| Row counts across 5 leagues × 7 seasons | correct throughout, *including* Ligue 1 truncated to 279 in 2019-20 by the pandemic and 306 once it and the Bundesliga settled at eighteen clubs |
| Do open and close actually differ | 244,658 pairs: 8.5% identical (real non-movement on short prices), median absolute move **4.49%**, p5 −10.4%, p95 +14.9% |

A mirror that reproduced the schema but fabricated the numbers would fail the
first check; one that copied a single season would fail the second; one that
duplicated a column into both phases would fail the third.

```bash
npm run collect -- closing            # 5 leagues, 2019-20 to 2025-26
```

**489,437 price observations over 12,459 matches** — every price twice, once as
posted and once at the off, from Bet365, Pinnacle, the best of the panel and the
market average, across 1X2 and Over/Under 2.5.

`phase` carries the open/close distinction. `price_taken_at` stays null for both,
because the archive says *which* price it is and never *when* it was taken.

What this unlocks is the closing-line research that was supposed to wait for a
live snapshotter — on twelve thousand matches rather than the 1,186 of a single
month. What it still does not give is intraday trajectory or liquidity: two
points per match, not a path.

## What replaces an API key, and what does not

The snapshot stream needs an odds provider, and the honest search for a free
substitute produced a mixed answer worth stating in full.

**What was found.**

| Source | What it gives | Verdict |
|---|---|---|
| `xgabora/Club-Football-Match-Data` — `Matches.csv` | 238,858 matches, 38 divisions, 2000 to **3 Sep 2026**, 1X2 and O/U 2.5 at market average and best of panel | the backfill's spine |
| same repo — `EloRatings.csv` | **273,972 dated strength snapshots**, twice monthly, 629 dates, 2000-07-01 to 2026-09-01, 942 clubs | a real time series, now collected |
| `footballcsv/cache.footballdata` | mirrors football-data.co.uk — but stripped to five columns, `Date, Team 1, FT, HT, Team 2` | **odds removed; useless here** |
| `openfootball/football.json` | fixtures and results, keyless | already wired as the no-odds fallback |

**What was not found, and is not findable.** No keyless source publishes a
*price* time series: no closing line, no intraday movement, no liquidity. The
one archive that has closing columns is football-data.co.uk itself, and its host
is blocked from this environment. Every GitHub mirror of it that could be
located either drops the odds entirely or republishes the pre-match price only.

So the substitution is partial and should not be oversold: **an Elo series is
not a price series.** It carries no market, no money and no closing line. What
it does carry is the one thing the odds archive lacks — a dated external opinion
of team strength, so a match can be joined to what was known *before* it rather
than to a season-long average.

### The point-in-time join, and why "strictly before" is load-bearing

`ratingAsOf(snapshots, clubSlug, date)` returns the last snapshot **strictly
earlier** than the date. Not "on or before" — a snapshot stamped the day of a
match may already reflect it, and a model fed that looks prescient in backtest
and useless in front of a bookmaker.

Verified against real collected data:

```
joined 400/400 matches, 0 missing
rows where the rating is dated on or after kickoff: 0
cross-check vs the archive's own home_elo, n=500:  median |diff| 0.0, p90 1.3
```

That last line is the one that matters. The archive computes its own pre-match
Elo column independently; reproducing it to a median difference of zero
confirms the join semantics **and** the club slugging at once, from a direction
that could have disagreed.

## Match identity

`matchId(league, date, home, away)` → `I1-2026-09-12-LAZIO-MILAN`. Built from
things that do not change, so two sources spelling a club differently still land
on the same row.

Writing its test found a real bug. `String.normalize("NFD")` decomposes `é` into
`e` plus a combining accent, which a non-ASCII strip then removes cleanly — but
**`ø`, `ł`, `đ`, `æ` and `ß` are letters in their own right**, not a base plus a
diacritic. NFD leaves them, the strip deletes them outright, and Bodø/Glimt
forks from Bodo/Glimt into two clubs. Fixed with an explicit transliteration
table, and asserted over Bodø, Łódź, Đjurgården, Fenerbahçe and Malmö.

That bug is the whole case for the identity layer being built first rather than
last: it produces no error, no warning and no crash. It just quietly makes every
join downstream wrong, and wrong in a way that is not random — clubs with
awkward names are not a random sample of clubs.
