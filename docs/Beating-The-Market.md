# Can this beat the best traders on an exchange?

Not by forecasting. That is not modesty, it is the conclusion of every
measurement in this repository, and the evidence chain is short.

## The evidence against

| Measurement | Result |
|---|---|
| This model vs bookmaker closing line, 679 matches | **-9.2%** in RPS |
| This model vs bookmaker opening line | -8.2% |
| Elo — a separate method, built by other people | lands within 0.0001 of this model |
| Blending either into the market, any weight | makes the market **worse** |
| Betting the model's disagreements, 2-20% edge thresholds | **-13.6% to -27.5%** ROI |
| Closing-line value of those bets | about **-6.5%** |

A system that loses to a bookmaker's price cannot beat the traders who set a
sharper one. And a prediction market on a liquid event is sharper: there is no
margin in it, so the price is the crowd's actual estimate rather than the
crowd's estimate plus a 5% toll.

## Why an exchange is the harder target, not the easier one

Against a bookmaker you beat a **price**. The desk quotes, takes a margin, and
manages its book; it does not need you to be wrong, only to pay the toll.

Against an exchange you beat **the person on the other side of your fill**, and
you do not choose who that is. Your order rests until someone wants it — and
the someone who wants it is disproportionately the one who knows something you
do not. That is adverse selection, and it is why removing the margin does not
make the game easier. It removes the handicap and leaves you playing the best
opponents in the room, at their choosing.

The one constraint the exchange does remove is the one that kills bookmaker
edges: **it cannot restrict you for winning**. That matters enormously if you
have an edge, and not at all if you do not.

## What would have to be true

An edge on a liquid exchange comes from one of four places. Three are not
forecasting.

1. **Information the market has not priced.** Shot quality, lineups, injuries,
   minutes before kick-off. Not reachable from here, and on a major match the
   top traders already have it. Plausible only in thin markets nobody is
   watching — which are also the markets where you cannot get size down.
2. **Speed.** Reacting to news before the book adjusts. An infrastructure
   problem, not a modelling one, and the winners are measured in milliseconds.
3. **Structure.** Cross-venue arbitrage, or the longshot bias if it exists here
   as it does on bookmakers (documented at 4.5% on short favourites rising to
   15.9% on longshots — see [Thinking Like a Book](Thinking-Like-A-Book.md)).
   Testable, and nothing to do with predicting matches.
4. **Market making.** Earning the spread instead of predicting the outcome. A
   different business, with inventory risk and infrastructure requirements, and
   the top traders on any exchange are mostly doing this.

Of these, only (3) can be tested with what is reachable, and only with
Polymarket's own resolved-market history — which this environment cannot fetch.
Nothing in this repository has measured it.

## What is built here, and what it is for

Seven `polymarket_` tools, none of which predict anything:

- `polymarket_get_markets` / `_get_market` — prices as probabilities with the
  decimal odds alongside, so they sit next to a sportsbook's.
- `polymarket_get_order_book` — the size behind each price, and what a round
  trip costs. A bookmaker reveals its limit only by refusing you.
- `polymarket_get_quote` — midpoint, spread and last traded price together. The
  midpoint is what the book thinks; the last trade is what someone paid.
- `polymarket_get_trades` — the public tape, volume-weighted. A quote nobody has
  traded at is an opinion, not a price.
- `polymarket_compare_to_book` — which venue pays more after the fee, and
  whether the two are far enough apart to back both sides.
- `polymarket_explain` — what transfers from bookmaker betting and what does not.

The point of the tape and the book is not to find a signal in them. It is to
stop you mistaking a thin quote for a market, which is the most common way
money is lost on an exchange without anyone out-trading you.

## The only honest scoreboard

If you do build something, the question is not what it returned. Over a few
hundred trades, return is noise: `trading_edge_requirements` puts a 2% edge at
1.30 at **2,857 bets** before it separates from zero.

Score it against the market's own later price instead — closing-line value.
`trading_closing_line_value` takes the price you got and the price at
settlement time and tells you whether you were systematically ahead of the
market. It converges in hundreds of trades rather than thousands, because it
measures the thing directly rather than through the noise of outcomes.

The protocol, in order:

1. Record every trade's price and the market's midpoint at the moment you
   traded. Not later. Not from memory.
2. When the market settles, take its price shortly before settlement.
3. Run `trading_closing_line_value` over the set.
4. If average CLV is not clearly positive after a few hundred trades, there is
   no edge — whatever the P&L says. A profitable run with negative CLV is a
   lucky run, and it will revert.
5. Only if CLV is positive does the size question arise, and then
   `trading_edge_requirements` sets the stake and the ruin risk.

That sequence is the system I can honestly build: an apparatus that would
detect an edge, prove it, and size it. What it cannot do is supply the edge,
and anything claiming to do that against the best traders on a zero-margin
venue — with a goals model measured 9% behind a bookmaker — would be a story,
not a system.
