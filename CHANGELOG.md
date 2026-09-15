# Changelog

All notable changes to this project are documented here. This project follows [semantic versioning](https://semver.org/).

## [Unreleased]

Context cost, multi-client correctness, and a football trading toolkit.

### Measured — what the best available price is actually worth

New page: [docs/The-Price-Of-The-Best-Price.md](docs/The-Price-Of-The-Best-Price.md).
Three independent measurements on two non-overlapping datasets, asking what it
would be worth to bet at any price, only when you choose, at any stake.

- **Line shopping recovers 5.30 of the market's 6.6 points of margin and stops.**
  Backing every outcome at the best quote returns -2.24% +/- 0.12 over 433,395
  legs; you would need to beat the listed best price by 2.29% to reach zero.
- **95.7% of the extra price is taken back by adverse selection.** Sorted into
  dispersion deciles within odds bands, selections where the best quote sits
  furthest above consensus underperform their implied probability by 1.39pp
  (z = -6.94). Going from the lowest to the highest decile buys 12.37 points of
  extra gross price and 0.53 points of return. The outlier book is sharp.
- **The best opening price does not beat the close.** On 1,186 matches with nine
  named books quoting open and close, CLV is -0.77% at the open against +1.58%
  at the close. This corrects the advice in Thinking-Like-A-Book section 7, which
  said to place within minutes of the opening price.
- **Half the best prices are an exchange gross of commission.** Net of 5% the
  Betfair Exchange adds nothing over the best bookmaker, and 5% is the erosion
  that takes the surviving short-favourite edge from +2.23% to +0.94%.
- **Selectivity on the de-vigged consensus does not work at any threshold.**
  Largest validation t-statistic 0.93 against a Bonferroni bar of 3.08. Along the
  way: multiplicative de-vig overstates longshots by 36% relative and manufactures
  the result; power de-vig is the best calibrated of the three on this data.
- **Soft leagues are the wrong place to look.** The big five have a lower
  best-price overround (1.0054 against 1.0161) and better returns in both periods.
- **The window is closing.** Between-book dispersion has fallen monotonically for
  twenty years; since 2014-15 the best price has decayed 0.25pp per season and
  arbitrage in this panel extrapolates to zero by 2027-28.
- **Streaks match chance.** Longest observed winning run 7 against a chance median
  of 9; P(chance >= observed) = 0.999. The useful number is the longest losing run,
  29, which is what a bankroll has to survive.
- **Staking: a real edge, over-bet on a noisy estimate, is worse than no bet.** A
  genuine +2% edge at price 2.0, sized full Kelly on a 200-bet measurement of itself,
  returns -18.6 bp per bet and halves the bank 62.5% of the time over 1,000 bets;
  not betting leaves you at 1.000. Staking half of Kelly and 1.5x Kelly give identical
  growth, but only one also multiplies the drawdown. A 200-bet record at price 2.0
  justifies staking 7.4% of its own point estimate.
- **What it would take.** A +2% edge is marginally viable at price 2.0 or shorter with
  1,000+ bets a year (25-50k bank, 10-20% on bank, 5-10 seasons to prove). At +1% or
  below, at any price and any frequency, the bankroll is 4 to 36 times the annual
  profit and the exercise is strictly worse than doing nothing.

### Changed

- `trading_edge_requirements` now returns `ruin_risk_horizon`. Its ruin figures come
  from the standard `a^(2/k - 1)`, which contains neither the edge nor the price
  because it is an unbounded-horizon limit — so it returns 50% / 12.5% / 0.8% for
  bank-halving whatever you pass it. Simulation confirms the formula (50.6% at 100,000
  bets) and confirms one season is far safer (1.7% after 1,000 bets at +1% and price
  2.0). The horizon now ships with the number.

### Added — `trading_` provider (11 tools, no API key)

Predicts matches, scores those predictions honestly, turns prices into positions, and lets you test an idea on history before staking anything:

- `trading_predict_fixtures` — fit ratings on the season so far, price every fixture in the next few days, and compare against the bookmakers' own (de-vigged) prices. Emits prediction rows shaped for the scorer.
- `trading_score_predictions` — score those predictions once the matches are played: hit rate, ranked probability score, Brier, log loss, calibration buckets, and the P&L and closing-line value of any picks — all benchmarked against the market's own prices rather than a coin flip.
- `trading_backtest` — run a strategy over real results + bookmaker odds (football-data.co.uk, 2000-now, 20+ leagues) and get ROI, strike rate, max drawdown, closing-line value and per-season/per-league breakdowns. Strategies: flat sides (`home`/`draw`/`away`/`favourite`/`underdog`/`over25`/`under25`), `value_model` (walk-forward Poisson ratings, no lookahead) and `clv_steam` (opening price vs the de-vigged close). Flat, percent-of-bank or fractional Kelly staking.
- `trading_team_ratings` — attack/defence strengths fitted from a league's results, with optional recency decay, shrinkage and fixture pricing.
- `trading_poisson_model` — 1X2, over/under, BTTS and correct score from expected goals, with an optional Dixon-Coles low-score correction.
- `trading_devig_odds` — margin removal (multiplicative, additive, power, shin).
- `trading_evaluate_bet` — edge, EV and fractional Kelly stake for one or more selections.
- `trading_find_arbitrage` — risk-free books and the stake split that equalises the return.
- `trading_hedge_position` — green-up/cash-out stake and P&L for an open back or lay, with exchange commission.
- `trading_closing_line_value` — measure bets you actually made against the close.
- `trading_list_strategies` — the strategy/staking/price-source reference, with the data caveats.

Every backtest result ships with its caveats (assumed fills, sample size, the risk of tuning on the same data). New `trading` preset; the provider also joins `free`, `soccer` and `odds`. New prompts: `build-football-trade`, `backtest-football-strategy`, `predict-and-track`.

**Second data source, so the loop survives a blocked or failing archive.** `trading_predict_fixtures` and `trading_score_predictions` take a `source`: `footballdata` (football-data.co.uk — results, odds, about a week of fixtures), `openfootball` (a keyless GitHub-hosted mirror with the full season calendar but no odds), or `auto`, which prefers the first and falls back to the second. The fallback is always reported, along with what it costs: no odds means no market benchmark, no edge and no picks — the probabilities and their scoring still work. Fixtures dated before today with no result yet are skipped rather than "predicted", since both sources lag by a few days.

**Fixed: every 0-0 was being dropped from the openfootball mirror.** That source writes most matches as `{"ft":[h,a],"ht":[…]}` but some as a bare `[h,a]` — and in Serie A 2025-26 the bare form is used for all 36 goalless matches. Reading only `.ft` classified them as "not played", so ratings never saw a goalless game: over-2.5 probabilities came out 4-5 percentage points too high and draws about 1.4 points too low, enough to flip the most likely outcome of a fixture. Both shapes are read now. Found by cross-checking a finished season against an independent mirror, which agreed on goals and on home and away wins but not on draws.

**Data-quality reporting.** A match whose date has passed with no result is a hole in the source, not lag: `trading_predict_fixtures` returns those under `data_quality`, and `trading_score_predictions` distinguishes a prediction still to come from one the source will never settle, and from a name that is not in the source at all.

**`trading_edge_requirements`** computes what a bet has to clear to make money: the break-even hit rate, the hit rate a claimed edge implies, how many bets before that edge separates from luck, the Kelly stake, the risk of ruin at each staking speed, and the losing run to expect anyway. A 2% edge at 1.30 needs 2,857 bets before it means anything; break-even at that price is a 76.9% hit rate.

**The Polymarket provider grew a trade tape and a proper quote**, both confirmed against Polymarket's own open-source client rather than written from memory: `polymarket_get_trades` returns the public fills volume-weighted (a quote nobody has traded at is an opinion, not a price) and `polymarket_get_quote` combines midpoint, spread and last trade, tolerating each call failing on its own. The official client also confirmed the field mapping the provider was guessing at — `outcomes`, `outcomePrices` and `clobTokenIds` really are JSON-encoded strings.

**docs/Beating-The-Market.md** answers whether any of this could beat the best traders on an exchange. It could not, and the reasoning is the repository's own numbers: a model 9% behind a bookmaker's closing line cannot beat the traders who set a sharper one, and an exchange is the harder target rather than the easier one, because you no longer beat a price — you beat whoever chose to take the other side of your fill. What is documented instead is the apparatus that would detect and prove an edge: score against the market's own later price, not against P&L, because closing-line value converges in hundreds of trades where return needs thousands.

**`polymarket_` provider (5 tools, no key).** A prediction market prices the same events through a different mechanism, and it removes the constraint that actually ends bookmaker edges: an exchange cannot restrict you for winning. `polymarket_get_order_book` shows the size behind each price — the thing a book never reveals until it refuses your stake — and `polymarket_compare_to_book` puts the two venues side by side, fee included, and checks whether they disagree enough to back both sides. `polymarket_explain` states what does NOT carry over, because it matters more: the edge measured in docs/Evaluation.md is the gap between the best bookmaker price and the average one, which is a disagreement among books — a single exchange has one price and nothing to arbitrage. Coverage is thin outside big matches, and liquidity replaces the account limit as the binding constraint. Written from the public API shape and never called from the session that wrote it (the network blocks the host); `npm run verify:sources` now checks the field mapping wherever it can reach.

**What the edge pays, in money.** The surviving pattern qualifies about 793 bets a year across 19 leagues at +2.04% ROI, with four losing years in the last twenty. On a €5,000 bank at 2% a bet that is €1,620 a year — on €79,300 of turnover, which is the number that decides the outcome: that profile is what gets accounts limited, usually before the sample is long enough to prove the edge exists. Added to docs/Thinking-Like-A-Book.md.

**docs/Thinking-Like-A-Book.md** studies what bookmakers actually do, measured on 235,806 matches and ~700,000 priced outcomes: the margin is loaded onto longshots (4.5% below fair at odds under 1.20, 15.9% above 8.00), a 70%+ hit rate needs no model at all and still loses money, only the bands under 1.60 are beatable and only at the best price, the closing line beats the opening by 0.82% with the direction of movement carrying information, and the conditions to collect the one surviving edge are listed — including the one no model can supply, which is an account that does not get limited.

**`trading_price_market`** does what the toolkit could not: add a margin instead of removing one, turning fair probabilities into the odds a book would post. The margin size is measured rather than invented — mainstream books run about 5% overround on 1X2 in these leagues, the best price across books leaves 1.2% — and the default `power` method distributes it the way real books do, cutting the longshot several times harder than the favourite. Each outcome reports `odds_cut_pct`, how far its price sits below fair, because a flat tax on probabilities is not a flat tax on what the bettor pays; a test asserting the wrong version of that is what caught it.

**The ten-match review, run on both leagues, and the hypothesis it produced.** Serie A's last ten had the model beating the market by 9.5%, the Premier League's by 6.3% — and in each case one match carries the whole thing: remove Fiorentina v Frosinone and it becomes -4.6%, remove Coventry v Hull and it becomes -10.7%. Both are matches where the MARKET was confidently wrong, and RPS punishes confident errors hard enough for one to swamp ten. The model won them by being less sure, which is not skill. Both windows falling in late August suggested the model might be relatively better early in the season; split across 8,069 matches by season phase, the gap is -3.44% in rounds 1-8 and -2.27% to -3.76% everywhere else, with no trend. Hypothesis dead, which is what generating it from ten matches and testing it on eight thousand is for. In docs/Evaluation.md.

**`npm run patterns`** crosses betting sides with odds bands, Elo differences, form filters and price sources — 606 combinations, each scored on a period it was not chosen on. The top of the training table (a 28% return on 329 bets) collapses in validation, as it should. Six survived two standard errors, all one idea: backing short-priced favourites at the best available price, +1.8% over 5,766 validation bets and positive in 18 of 22 years — while the identical bets at the market average price return -1.2%. The edge is the price shopping, not the selection. docs/Evaluation.md also records what streaks and compounding really do: a 40-match winning run against 32.8 expected by chance, patterns that string 33 wins together while losing money, and a 1.7% edge that turns 100 into 1,561 at a 5% stake, 114 at 10%, and nothing at 25%.

**`npm run sweep`** answers "which strategy would have returned the most" over 19 leagues and 22 seasons — more than a million bets — with each strategy run on a period it was not chosen on and every ROI carrying its standard error. The answer is none: nothing is positive in both periods, nothing clears two standard errors, and the best training result flips to a loss in validation. The finding that does survive is not a strategy at all: taking the best available price instead of the market average is worth four to five points of ROI on every strategy, more than the whole spread between the best and worst of them. docs/Evaluation.md has the table.

**`npm run fetch:archive`** fills `data/football-data/` from a GitHub mirror of football-data.co.uk (238k matches, 38 divisions, 2000 to the present, with the market average and best price), in the site's own layout — so the odds-dependent half of the toolkit works on a machine that cannot reach the original host. It never overwrites a file already there, since yours may be the real thing with the closing line in it. The mirror has no closing line and its Elo column after mid-2025 is the maintainer's continuation rather than ClubElo's; docs/Data-Sources.md records that, along with everything else that was searched and what each source lacks.

**Elo was measured against this model and lands in the same place.** On 8,069 matches with both: Elo 0.20129 RPS, this model 0.20118, market 0.19539. Two unrelated rating systems hitting the same wall to four decimal places is the ceiling of what match results alone contain. A 50/50 ensemble of them is genuinely better (-2.54% against the market rather than -2.96%) and is deliberately not shipped: it doubles the model surface to move a number that changes no decision.

**Measured the model against a real bookmaker, and turned picks off because of what came back.** With two complete Premier League seasons of prices (679 matches), the model scores RPS 0.204 against the closing line's 0.187 and the opening line's 0.189 — it loses to both. Blending it into the market at any weight makes the forecast monotonically worse, so the optimal weight on this model is zero. Backing its disagreements with the opening price lost 13.6% of turnover at a 2% edge threshold and 27.5% at 20%, with closing-line value around -6.5%: the larger the disagreement, the more wrong it was. `trading_predict_fixtures` therefore defaults `suggest_picks` to false, and any response carrying picks carries those numbers. Full write-up in docs/Evaluation.md, including the first real backtest of the flat strategies.

**`clv_steam` documents its own circularity**: the strategy selects on beating the close, so its closing-line value is its entry rule restated, not evidence. Judge it on ROI.

**The local CSV directory is resolved per call**, not at import time, so tests can point it at nothing — they were otherwise reading whatever CSVs a developer happened to have on disk, which is how this was found.

**Local CSV drop-in.** `data/football-data/<season>/<LEAGUE>.csv` (or `SPORTS_HUB_DATA_DIR`) is read before the network, in the site's own layout, so a file downloaded in a browser restores odds — and with them the market benchmark, edges and backtests — on a machine that cannot reach football-data.co.uk at all.

**Promoted-team prior.** `trading_predict_fixtures` prices a fixture with one unrated side by assuming 0.85 attack / 1.15 defence rather than declining it. Measured over the top three leagues: identical RPS on the 5,508 fixtures both variants cover, and 172 extra fixtures predicted at RPS 0.191 against 0.2298 for base rates. A coverage gain, not an accuracy one. Each affected fixture names the assumption; `rate_promoted: false` restores the old behaviour; with both sides unknown the fixture is still declined, because the forecast would be the prior playing itself.

**`npm run tune`** searches model parameters with the choice made on training seasons and the result reported on validation seasons the search never saw. Its finding is a negative one, recorded in docs/Evaluation.md: a 96-cell grid bought 0.2% on training and lost 0.15% on validation, and venue splits, blending and heavier shrinkage are all clearly worse. Goals-only ratings are at their ceiling; the next gain has to come from better inputs, not better fitting.

**Measured the model over 19,062 real matches.** `npm run track -- hindcast` now takes `--seasons` and pools many league-seasons, so the walk-forward check runs over everything the keyless source covers: five leagues, 2015-16 to 2025-26, 55 league-seasons. RPS 0.2011 against 0.2298 for base rates (12.5% skill), calibrated within about a point in every bucket that has samples, and not one league-season below base rates. Written up in [docs/Evaluation.md](docs/Evaluation.md) — including what it does not show, which is any comparison against a bookmaker, since the source carrying odds was unreachable from the machine that ran it. `trading_score_predictions` now accepts up to 500 predictions, one league-season's worth.

**`npm run verify:sources`** (`scripts/verify-sources.mjs`) checks the live sources against what the code expects: shapes parse, seasons are complete enough to rate a league on, and a finished season agrees with an independent mirror. FAIL means real upstream drift; SKIP means the host was unreachable, which is an environment fact rather than a defect.

**`npm run track`** (`scripts/season-tracker.mjs`) runs the loop from a shell with no MCP client: `predict` logs a round to `predictions/<LEAGUE>-<SEASON>.json` (append-only — a forecast you can edit after the result is not a forecast), `score` grades what has been played, and `hindcast` re-predicts every match already played this season using only what was known before each one. `predict --supersede "<reason>"` retires earlier predictions on matches still ahead — the old rows stay in the log with the reason, since the point of an append-only log is that nothing quietly changes after the fact.

Totals: **43 providers / 421 tools** (up from 42 / 410). `footballdata_uk_` now shares the CSV loader with the new provider — same tools, same behaviour.

### Fixed
- **HTTP mode served only one client.** A single `StreamableHTTPServerTransport` was shared by every request, so the second client to `initialize` got `400 Invalid Request: Server already initialized`. This affected the Smithery-hosted endpoint, which is HTTP by definition. Each client now gets its own session (or set `SPORTS_HUB_STATELESS=1` for a throwaway server per request).
- **Overlapping presets silently dropped providers.** `SPORTS_HUB_PROVIDERS="free,us-major"` tried to register `espn` twice; the second attempt threw `Tool espn_get_scoreboard is already registered` and the provider was skipped. The list is now deduped, and excludes are honoured alongside includes (`us-major,-cfbd`).
- **The cache ignored auth headers.** Two API keys hitting the same URL shared one cache entry, so in any process handling more than one key, one account could be served another's response. The key now includes a digest of the auth headers.

### Added
- **`fields` parameter on every tool.** Comma-separated key names to keep, matched at any depth. `espn_get_teams` for the NBA goes from 297 KB to 2.9 KB with `fields=id,abbreviation,displayName,location`. When nothing matches, the tool says so and lists the keys it did see.
- **Response size cap** (`SPORTS_HUB_MAX_RESULT_BYTES`, default 40 KB). Over the limit, the longest lists in the payload are shortened until it fits, so the result still parses, and a note reports how many items were dropped.
- **Empty-response hints.** A successful call whose lists are all empty (common out of season) now says so, instead of looking to the model like a working tool that returned nothing.
- **Retry with backoff** on `429`/`5xx`, honouring `Retry-After`. Client errors and timeouts are not retried.
- **In-flight coalescing.** Concurrent identical requests share one upstream call.
- **Negative caching** of `404`/`410` for 30s, so a wrong ID is not re-fetched in a loop.
- **Server instructions** describing `fields` once at connect time rather than on 396 tool schemas.
- 22 tests covering projection, slimming, capping, retries, coalescing and cache isolation, plus 82 for the trading maths, the archive's odds columns, the backtest engine, the predict/score loop, the source fallback, robustness against malformed input, and a full real Serie A season kept verbatim as a fixture — walk-forward forecasting on it is checked for lookahead, calibration and exact regression values (282 total).

### Changed
- Tool results are serialized compactly. The previous `JSON.stringify(data, null, 2)` spent 56% of the bytes on indentation no model reads.
- `tools/list` no longer emits the per-tool `$schema` boilerplate (~28 KB across 396 tools) or `maximum: 9007199254740991` artifacts from `z.number().int()`. Validation is unchanged: it still runs server-side against the original zod schema.

## [1.3.0] — 2026-06-24

Big release: **41 providers / 396 tools** (up from 32 / 336), new MCP capabilities, and a round of security/doc fixes.

### Added — 9 new providers
- **Motorsport** (no key): `motogp_` (MotoGP/Moto2/Moto3/MotoE), `formulae_` (Formula E), `nascar_` (Cup/Xfinity/Truck + live feed) — plus a new `motorsport` preset.
- **Esports / fantasy** (no key): `opendota_` (deep Dota 2 match/player/hero analytics), `sleeper_` (NFL fantasy — player search, injuries, depth charts, trending, leagues).
- **Basketball / archives** (no key): `euroleague_` (EuroLeague + EuroCup), `footballdata_uk_` (historical football results + closing bookmaker odds for backtesting).
- **API key required**: `boxing_` (Boxing Data API), `highlightly_` (multi-sport video highlights, odds, predictions).

### Added — MCP capabilities
- **Tool annotations**: every tool is now marked `readOnly` / `idempotent` / `openWorld` with a friendly title, so clients can skip confirmation prompts.
- **Resources**: readable catalogs — `sportshub://providers`, `sportshub://presets`, `sportshub://provider/{key}` (with key autocompletion).
- **Prompts**: 6 curated workflows — `whats-on-today`, `compare-odds`, `motorsport-weekend`, `league-standings`, `team-deep-dive`, `f1-race`.

### Added — distribution
- MCPB bundle (`manifest.json` + `npm run bundle`) for one-click Claude Desktop install.
- GitHub Actions workflow to republish to the MCP Registry via OIDC on each release.

### Fixed / changed
- Corrected provider/tool counts and the "default preset" description across README, CLAUDE.md, server.json, and the `docs/` wiki (the default is the `free` preset, now 19 providers / ~165 tools).
- `zod` widened to `^3.25 || ^4.0` (resolves to v4); `npm audit fix` → **0 vulnerabilities**.
- `sportsdata-io` now encodes path segments (`pathSegment()`); HTTP transport rejects a literal `*` CORS origin and warns when bound to a non-loopback host.
- New `fetchText` HTTP helper; provider catalog/presets centralized in `src/shared/catalog.ts`.

## [1.2.0] — 2025-05-07
- Added Lichess, Chess.com, and Squiggle (AFL) providers; security hardening and bug fixes.

## [1.1.0]
- Default `free` preset, in-memory cache, CI, `npx` support, HTTP/SSE transport.

[1.3.0]: https://github.com/lacausecrypto/mcp-sports-hub/releases/tag/v1.3.0
[1.2.0]: https://github.com/lacausecrypto/mcp-sports-hub/releases/tag/v1.2.0
