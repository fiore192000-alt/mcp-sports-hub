import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { buildUrl, fetchJson, pathSegment, safe, toolResult } from "../shared/http.js";
import { asOdds, asPct, asProb, round } from "../shared/betting-math.js";

// ---------------------------------------------------------------------------
// Polymarket — 5 tools
// Base: https://gamma-api.polymarket.com (markets) + https://clob.polymarket.com (order book)
// Auth: none for reading. Trading needs a wallet; nothing here trades.
//
// Why a prediction market belongs in a toolkit full of bookmakers: it prices
// the same events through a different mechanism. A book quotes you a price and
// can refuse your business; an exchange shows an order book and cannot. The
// measured edge in docs/Evaluation.md is the gap between the best bookmaker
// price and the average one — a disagreement between books — so it does not
// transfer here automatically. What does transfer is the use of a second,
// independent price: to check a book against, and to arbitrage against when
// the two venues disagree by more than their combined costs.
//
// Read the caveats in trading terms, not marketing ones: coverage is thin
// outside big matches, and a quoted price with no size behind it is not a
// price. Every tool here reports the book depth so that can be judged.
// ---------------------------------------------------------------------------

const GAMMA = "https://gamma-api.polymarket.com";
const CLOB = "https://clob.polymarket.com";

/** Gamma returns some array fields as JSON-encoded strings. Accept both. */
function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

const numeric = (v: unknown): number | undefined => {
  const n = typeof v === "number" ? v : Number.parseFloat(String(v));
  return Number.isFinite(n) ? n : undefined;
};

/** A probability between 0 and 1 becomes the decimal odds a book would quote. */
function toOdds(probability: number | undefined): number | undefined {
  if (probability === undefined || probability <= 0 || probability >= 1) return undefined;
  return asOdds(1 / probability);
}

interface GammaMarket {
  id?: string; slug?: string; question?: string; conditionId?: string;
  outcomes?: unknown; outcomePrices?: unknown; clobTokenIds?: unknown;
  volume?: unknown; liquidity?: unknown; endDate?: string; active?: boolean; closed?: boolean;
  bestBid?: unknown; bestAsk?: unknown; spread?: unknown;
}

function summarize(m: GammaMarket) {
  const outcomes = asArray(m.outcomes).map(String);
  const prices = asArray(m.outcomePrices).map(numeric);
  const tokens = asArray(m.clobTokenIds).map(String);
  const total = prices.reduce<number>((a, p) => a + (p ?? 0), 0);
  return {
    id: m.id,
    slug: m.slug,
    question: m.question,
    ...(m.endDate ? { ends: m.endDate } : {}),
    outcomes: outcomes.map((name, i) => ({
      name,
      probability: prices[i] !== undefined ? asProb(prices[i] as number) : undefined,
      implied_odds: toOdds(prices[i]),
      ...(tokens[i] ? { token_id: tokens[i] } : {}),
    })),
    // On a book this would be the overround. Here it is how far the two sides
    // sum from 1: the cost of crossing both, not a margin someone charges.
    booksum: total ? round(total, 4) : undefined,
    ...(numeric(m.spread) !== undefined ? { spread: round(numeric(m.spread) as number, 4) } : {}),
    liquidity_usd: numeric(m.liquidity) !== undefined ? round(numeric(m.liquidity) as number, 2) : undefined,
    volume_usd: numeric(m.volume) !== undefined ? round(numeric(m.volume) as number, 2) : undefined,
    ...(m.closed ? { closed: true } : {}),
  };
}

export function register(server: McpServer): void {
  // 1. list markets
  server.tool(
    "polymarket_get_markets",
    "List Polymarket prediction markets with their current prices, implied odds and liquidity. Prices are probabilities (0-1) set by traders, not by a bookmaker — the implied odds let you compare them directly against a sportsbook.",
    {
      search: z.string().optional().describe('Filter by text in the question, e.g. "Premier League" or "Inter"'),
      limit: z.number().int().min(1).max(100).optional().describe("Max markets to return (default 20)"),
      closed: z.boolean().optional().describe("Include settled markets (default false)"),
      order: z.enum(["volume", "liquidity", "endDate"]).optional().describe("Sort by (default volume — the ones with real money behind them)"),
    },
    safe(async ({ search, limit, closed, order }) => {
      const data = await fetchJson(buildUrl(`${GAMMA}/markets`, {
        limit: limit ?? 20,
        closed: closed ?? false,
        active: true,
        order: order ?? "volume",
        ascending: false,
        ...(search ? { search } : {}),
      }), { cacheTtl: 60 }) as GammaMarket[] | { data?: GammaMarket[] };
      const markets = Array.isArray(data) ? data : (data?.data ?? []);
      return toolResult({
        count: markets.length,
        markets: markets.map(summarize),
        note: "Liquidity is the number that decides whether a price is real. A market quoting 0.62 with $300 of liquidity cannot absorb a meaningful stake at that price.",
      });
    }),
  );

  // 2. one market
  server.tool(
    "polymarket_get_market",
    "Get one Polymarket market by its slug or id, with outcome prices, implied odds, liquidity and the token ids needed to read its order book.",
    {
      slug: z.string().optional().describe('Market slug, e.g. "will-inter-win-serie-a"'),
      id: z.string().optional().describe("Market id, if you have it instead of the slug"),
    },
    safe(async ({ slug, id }) => {
      if (!slug && !id) throw new Error("Give either a slug or an id");
      const url = id
        ? `${GAMMA}/markets/${pathSegment(id)}`
        : buildUrl(`${GAMMA}/markets`, { slug });
      const data = await fetchJson(url, { cacheTtl: 60 });
      const market = Array.isArray(data) ? data[0] : data;
      if (!market) throw new Error(`No market found for ${slug ?? id}`);
      return toolResult(summarize(market as GammaMarket));
    }),
  );

  // 3. order book
  server.tool(
    "polymarket_get_order_book",
    "Get the live order book for one outcome: the bids and asks with the size behind each. This is what a bookmaker never shows you — how much can actually be traded, and at what price it starts to move.",
    {
      token_id: z.string().describe("CLOB token id for the outcome (from polymarket_get_markets)"),
      depth: z.number().int().min(1).max(50).optional().describe("Levels of the book to return per side (default 5)"),
    },
    safe(async ({ token_id, depth }) => {
      const book = await fetchJson(buildUrl(`${CLOB}/book`, { token_id }), { cacheTtl: 15 }) as {
        bids?: Array<{ price?: unknown; size?: unknown }>;
        asks?: Array<{ price?: unknown; size?: unknown }>;
      };
      const levels = (side: Array<{ price?: unknown; size?: unknown }> = [], best: "high" | "low") =>
        side
          .map((l) => ({ price: numeric(l.price), size: numeric(l.size) }))
          .filter((l): l is { price: number; size: number } => l.price !== undefined && l.size !== undefined)
          .sort((a, b) => (best === "high" ? b.price - a.price : a.price - b.price))
          .slice(0, depth ?? 5)
          .map((l) => ({ price: round(l.price, 4), implied_odds: toOdds(l.price), size_usd: round(l.size, 2) }));

      const bids = levels(book.bids, "high");
      const asks = levels(book.asks, "low");
      const spread = bids[0] && asks[0] ? asks[0].price - bids[0].price : undefined;
      return toolResult({
        token_id,
        best_bid: bids[0], best_ask: asks[0],
        ...(spread !== undefined ? {
          spread: round(spread, 4),
          spread_pct: asPct(spread),
          cost_to_cross_pct: bids[0] ? asPct(spread / bids[0].price) : undefined,
        } : {}),
        bids, asks,
        depth_usd: {
          bid: round(bids.reduce((a, l) => a + l.size_usd, 0), 2),
          ask: round(asks.reduce((a, l) => a + l.size_usd, 0), 2),
        },
        note: "The spread here plays the role a bookmaker's margin plays elsewhere: it is what a round trip costs. Compare it against the 4-7% a book takes, and against the size available before the price moves.",
      });
    }),
  );

  // 4. compare against a bookmaker price
  server.tool(
    "polymarket_compare_to_book",
    "Put a Polymarket price next to a bookmaker's on the same outcome: which venue is offering more, by how much, and whether the two disagree enough to back one side at each. The arbitrage check accounts for the exchange fee.",
    {
      polymarket_probability: z.number().gt(0).lt(1).describe("Polymarket price for the outcome, as a probability (0-1)"),
      bookmaker_odds: z.number().gt(1).describe("The bookmaker's decimal odds for the SAME outcome"),
      bookmaker_odds_against: z.number().gt(1).optional().describe("The bookmaker's decimal odds for the opposite side, if you want the cross-venue arbitrage checked"),
      fee_pct: z.number().min(0).max(20).optional().describe("Exchange fee on winnings, % (default 0 — check the current schedule, it has changed)"),
    },
    safe(async ({ polymarket_probability, bookmaker_odds, bookmaker_odds_against, fee_pct }) => {
      const fee = (fee_pct ?? 0) / 100;
      const polyOdds = 1 / polymarket_probability;
      const polyNet = 1 + (polyOdds - 1) * (1 - fee);
      const bookProb = 1 / bookmaker_odds;
      const better = polyNet > bookmaker_odds ? "polymarket" : "bookmaker";

      // Cross-venue arbitrage: back the outcome where it is longer, back the
      // other side where that is longer.
      let arbitrage;
      if (bookmaker_odds_against) {
        const againstPoly = 1 / (1 - polymarket_probability);
        const againstPolyNet = 1 + (againstPoly - 1) * (1 - fee);
        const combos = [
          { name: "outcome on Polymarket + opposite at the book", a: polyNet, b: bookmaker_odds_against },
          { name: "outcome at the book + opposite on Polymarket", a: bookmaker_odds, b: againstPolyNet },
        ].map((c) => ({ ...c, booksum: 1 / c.a + 1 / c.b }));
        const best = combos.sort((x, y) => x.booksum - y.booksum)[0];
        arbitrage = {
          is_arbitrage: best.booksum < 1,
          route: best.name,
          booksum: round(best.booksum, 5),
          profit_pct: asPct(1 / best.booksum - 1),
        };
      }

      return toolResult({
        polymarket: { probability: asProb(polymarket_probability), implied_odds: asOdds(polyOdds), after_fee: asOdds(polyNet) },
        bookmaker: { odds: asOdds(bookmaker_odds), implied_probability: asProb(bookProb) },
        better_price: better,
        difference_pct: asPct(Math.abs(polyNet - bookmaker_odds) / Math.min(polyNet, bookmaker_odds)),
        ...(arbitrage ? { arbitrage } : {}),
        caveats: [
          "A better quoted price is not a better price unless there is size behind it — check polymarket_get_order_book.",
          "Cross-venue arbitrage means holding both positions until settlement, in two currencies, with the exchange leg on-chain. Count the transfer costs and the settlement delay before calling it risk-free.",
        ],
      });
    }),
  );

  // 5. what this venue is and is not
  server.tool(
    "polymarket_explain",
    "What a prediction market changes about betting economics compared with a bookmaker, and what it does not. Read this before assuming a move to Polymarket carries an edge across.",
    {},
    safe(async () =>
      toolResult({
        what_changes: {
          no_limits: "An exchange matches you against other traders. Winning does not get you restricted, which is the constraint that ends most bookmaker edges (docs/Thinking-Like-A-Book.md).",
          two_sided: "You can take either side of any market at any time, including selling a position before settlement.",
          transparent_depth: "The order book shows the size behind each price. A bookmaker's limit is discovered only when they refuse your stake.",
          no_built_in_margin: "Nobody adds an overround. The cost is the bid-ask spread plus whatever fee schedule is current.",
        },
        what_does_not_change: {
          the_measured_edge_does_not_transfer: "The edge in docs/Evaluation.md is the gap between the BEST bookmaker price and the AVERAGE one — a disagreement among books. A single exchange has one price, so that particular edge has nothing to arbitrage.",
          coverage: "Football markets concentrate on big matches. The measured pattern needs roughly 793 bets a year across 19 leagues including lower divisions, which this venue does not list.",
          liquidity_is_the_new_limit: "A thin market's effective spread can exceed a bookmaker's 4-7% margin. Size available at the quoted price replaces the account limit as the binding constraint.",
          you_still_need_an_edge: "Removing the margin removes the handicap, not the requirement. Against other traders you need to be right more often than they are.",
        },
        how_it_is_actually_useful_here: [
          "As a second independent price: a venue that disagrees with the bookmaker consensus is information, and trading_devig_odds plus this provider will show by how much.",
          "As an arbitrage counterparty: polymarket_compare_to_book checks whether the two venues are far enough apart to back both sides.",
          "As a benchmark for scoring: prediction-market prices are a strong forecast to measure a model against, alongside the closing line.",
        ],
        verification: "This provider was written from the public API shape and could not be called from the session that wrote it — that network blocks the host. Run `npm run verify:sources` where the host is reachable before trusting the field mapping.",
      }),
    ),
  );
}
