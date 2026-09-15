# Changelog

All notable changes to this project are documented here. This project follows [semantic versioning](https://semver.org/).

## [Unreleased]

Context cost, multi-client correctness, and a football trading toolkit.

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
