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

**`npm run track`** (`scripts/season-tracker.mjs`) runs the loop from a shell with no MCP client: `predict` logs a round to `predictions/<LEAGUE>-<SEASON>.json` (append-only — a forecast you can edit after the result is not a forecast), `score` grades what has been played, and `hindcast` re-predicts every match already played this season using only what was known before each one.

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
- 22 tests covering projection, slimming, capping, retries, coalescing and cache isolation, plus 62 for the trading maths, the archive's odds columns, the backtest engine, the predict/score loop and the source fallback (262 total).

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
