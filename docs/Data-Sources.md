# Where the data comes from, and what each source is missing

A record of what was searched, what is reachable, and what each source can and
cannot answer — so the next person does not repeat the hunt.

## Reachable and used

| Source | What it has | What it lacks |
|---|---|---|
| [football-data.co.uk](https://www.football-data.co.uk/) | Results, match stats, **opening and closing odds** from 10+ books, 25+ leagues, 2000-now | One host; a network policy or an outage takes it away entirely |
| [openfootball/football.json](https://github.com/openfootball/football.json) | Full season calendars and results, top leagues, served from GitHub | **No odds.** Volunteer-maintained: lags days to weeks, and has holes |
| [xgabora/Club-Football-Match-Data](https://github.com/xgabora/Club-Football-Match-Data-2000-2025) | 238k matches, 38 divisions, 2000 → Sep 2026, football-data.co.uk derived: results, stats, **market average and best odds**, Elo, form | **No closing line**, so no closing-line value. Elo after mid-2025 is the maintainer's continuation, not ClubElo |
| [datasets/football-datasets](https://github.com/datasets/football-datasets) | Results and match stats, ISO dates | Odds stripped out. Used only as an independent source to cross-check results |

`npm run fetch:archive` pulls the third of these and writes it into
`data/football-data/` in football-data.co.uk's own layout, so the odds-dependent
half of the toolkit works on a machine that cannot reach the original site. It
never overwrites a file already there, because yours may be the real thing with
the closing line in it.

## Reachable, not used

| Source | Why not |
|---|---|
| [openfootball/italy](https://github.com/openfootball/italy), `/england`, `/espana`, `/deutschland` | The text feeds upstream of `football.json`. Same data, same lag, harder to parse |
| [vaastav/Fantasy-Premier-League](https://github.com/vaastav/Fantasy-Premier-League) | Premier League only, and its results mirror lagged further behind than openfootball when checked |
| [statsbomb/open-data](https://github.com/statsbomb/open-data) | Event-level data good enough to derive shot quality, but only for selected competitions and seasons — not the running leagues this toolkit predicts |

## Not reachable from here

Blocked by this environment's egress policy, each checked directly:
`understat.com`, `fbref.com`, ESPN, `api.football-data.org`, `thesportsdb.com`,
`api.openligadb.de`, `statsapi.mlb.com`, Wikipedia, jsDelivr, Hugging Face.
Only GitHub and GitLab answer.

## The gap that matters

**Nothing reachable carries expected goals for the leagues in play.** Goals are
a noisy sample of chances, and every model built on them — including this one
and including Elo, which is built by other people from the same signal —
lands in the same place, about 3% behind the average market price and 9%
behind the closing line ([Evaluation](Evaluation.md)).

Shot quality is the input that would change that, and it needs either
`understat.com` / `fbref.com` allowed through the network, or their CSVs
dropped on disk. Team news — lineups, injuries — is the other, and it needs an
API key rather than a mirror.

## Checking for drift

`npm run verify:sources` fetches each live source, validates that its shape
still parses, reports holes, and cross-checks a finished season against an
independent mirror. Run it before trusting a number that came out of a source
you have not touched in a while.
