# Thinking like a bookmaker

What a book actually does, measured on 235,806 matches and roughly 700,000
priced outcomes from the archive — and what follows from it for anyone trying
to beat one.

## 1. The book does not price outcomes. It prices *you*.

A bookmaker's margin is not spread evenly. Comparing every average price
against the fair value implied by the best price across all books:

| Odds band | Selections | The average price sits below fair by |
|---|---|---|
| 1.00-1.20 | 3,795 | **4.47%** |
| 1.20-1.40 | 14,270 | 5.04% |
| 1.40-1.60 | 24,824 | 5.49% |
| 1.60-2.00 | 69,643 | 6.01% |
| 2.00-2.50 | 98,277 | 6.55% |
| 2.50-3.50 | 261,646 | 6.97% |
| 3.50-5.00 | 163,556 | 7.63% |
| 5.00-8.00 | 52,530 | 10.63% |
| 8.00+ | 18,877 | **15.88%** |

The longshot is taxed three and a half times harder than the favourite. This is
the favourite-longshot bias, and from the book's side it is not a mistake: it
is where the recreational money goes, so it is where the margin is put.
`trading_price_market` reproduces it — its default `power` method cuts a 0.10
outcome's price by 19% while cutting a 0.70 outcome's by 2.8%.

**What follows:** the cheapest place to buy is the short favourite, and the
most expensive is the lottery ticket. That is not an opinion about football.

## 2. A high hit rate is a price, not a skill

| Odds band | Hit rate | ROI at average price | ROI at best price |
|---|---|---|---|
| 1.00-1.20 | **87.4%** | -0.48% | **+2.37%** |
| 1.20-1.40 | **75.7%** | -1.81% | +1.47% |
| 1.40-1.60 | 64.7% | -3.34% | +0.29% |
| 1.60-2.00 | 53.3% | -4.85% | -0.91% |
| 2.00-2.50 | 42.6% | -5.83% | -1.36% |
| 2.50-3.50 | 30.5% | -7.20% | -2.50% |
| 3.50-5.00 | 23.1% | -9.95% | -4.09% |
| 5.00-8.00 | 14.7% | -14.23% | -5.41% |
| 8.00+ | 7.1% | -27.74% | -15.82% |

**A 70%+ hit rate takes no model at all** — bet anything priced under 1.40 and
you will have one, over a quarter of a million selections. It loses money.
A tipster advertising 75% accuracy is advertising their odds band.

Break-even at 1.30 is **76.9%**. At 1.20 it is 83.3%. The hit rate that sounds
impressive is below the one that pays.

## 3. The only bands that are beatable are the ones the book taxes least

Read the last column of that table again. Everything from 1.60 up loses even at
the best price available anywhere. Only under 1.60 is positive, and only just:
+2.37%, +1.47%, +0.29%. That is the whole opportunity, and it exists because
the book puts its margin on the longshots.

Independent confirmation from the pattern search over 606 filters
([Evaluation](Evaluation.md)): the six combinations that survived validation
were all short favourites at the best price, +1.8% over 5,766 bets — and the
same bets at the average price returned -1.2%.

## 4. The closing line is the book's finished opinion, and it is better than its first

On 760 Premier League matches with both prices recorded:

- Opening line RPS **0.18612**, closing line **0.18459** — the close is 0.82%
  better.
- The median price moves 3.7% between open and close; 15% of outcomes move more
  than 10%.

Controlling for odds band, the direction of that movement carries information:

| Band | Shortened >3% | Stable | Drifted >3% |
|---|---|---|---|
| 1.00-2.00 | 74.5% hit, +19.9% | 66.5%, -3.7% | 67.6%, +4.0% |
| 2.00-3.50 | 40.4%, +4.9% | 36.5%, +1.7% | 25.2%, **-33.6%** |
| 3.50-6.00 | 24.9%, +4.3% | 22.5%, -7.7% | 19.6%, -12.6% |

Outcomes the money moved toward beat outcomes it moved away from, in every band
where there is enough data. *(Cell sizes are 94-356 bets; the +19.9% is 94 bets
and means nothing on its own. The ordering across bands is the signal, not any
single number.)*

**What follows:** the market's final price is the thing to beat, not its first
one. Which is why every scoring tool here benchmarks against the close, and why
closing-line value is the metric that tells you whether a process works long
before the P&L does.

## 5. The conditions for profit, as arithmetic

`trading_edge_requirements` computes these for any price. At the odds where an
edge actually exists:

| Price | Edge claimed | Break-even hit rate | Hit rate needed | Bets to prove it (2σ) | Full Kelly |
|---|---|---|---|---|---|
| 1.30 | 2% | 76.9% | 78.5% | **2,857** | 6.7% |
| 1.30 | 5% | 76.9% | 80.8% | 420 | 16.7% |
| 2.00 | 2% | 50.0% | 51.0% | **9,996** | 2.0% |
| 3.50 | 5% | 28.6% | 30.0% | 4,116 | 2.0% |

Two things fall out of this table.

**A record shorter than that column proves nothing.** Three hundred winning
bets at 1.30 is entirely consistent with having no edge. Anyone showing you a
season of results at short odds is showing you noise with a narrative.

**And the stake decides whether a real edge survives.** Risk of the bank ever
halving, given the edge is real and known:

| Staking | Bank halves | Bank drops 75% | Bank drops 90% |
|---|---|---|---|
| Full Kelly | **50%** | 25% | 10% |
| Half Kelly | 12.5% | 1.6% | 0.1% |
| Quarter Kelly | 0.8% | 0.006% | ~0 |

Measured on the one pattern that survived validation, staking a flat percentage
across 6,183 bets turned 100 into 1,561 at 5% of bank — while spending most of
the period more than half underwater — into 114 at 10%, and into nothing at
25%. Same edge, same bets, three different endings.

## 6. What this adds up to

Beating a book is possible in exactly one documented place: **short-priced
favourites, bought at the best price available**, worth somewhere around 1-2%
before costs. Everything required to collect it:

- **Accounts at many books**, because the edge is the difference between the
  best price and the average one — nothing else.
- **Speed**, because the price you need is the opening one, before the money
  moves it.
- **Thousands of bets** before you know whether it is working, during which
  losing runs of 5-10 at these odds are routine.
- **Quarter-Kelly staking or flatter**, unless a 50% drawdown is acceptable.
- **Accounts that survive.** This is the one condition no model can supply:
  customers who consistently take top-of-market on short favourites are the
  first ones limited, and a limited account has no edge at any size.

And what is not possible on this evidence: beating the closing line with a
goals-based model. Ours loses to it by 9%, Elo loses by the same margin, and
blending either into the market makes the market worse
([Evaluation](Evaluation.md)). A hit rate above 70% is available immediately
and is worth nothing by itself.

Anyone promising both — high hit rate *and* long-run profit *and* short-term
consistency — is describing something this data says does not exist.

## 7. What the one real edge actually pays

The only pattern that survived validation — home/favourite under 1.50, at the
best available price — across 19 leagues, 2006 to 2025:

| | |
|---|---|
| Qualifying bets per year | **793** (between 522 and 1,073) |
| Strike rate | 77.0% |
| Average price | 1.33 |
| ROI | **+2.04%** |
| Average annual ROI | +1.84% |
| Losing years | **4 of 20** |

Expected annual profit, flat staking:

| Bankroll | Stake | Profit/year | % of bank | **Turnover** |
|---|---|---|---|---|
| €1,000 | 1% (€10) | €162 | 16.2% | €7,930 |
| €5,000 | 1% (€50) | €810 | 16.2% | €39,650 |
| €5,000 | 2% (€100) | €1,620 | 32.4% | €79,300 |
| €20,000 | 2% (€400) | €6,481 | 32.4% | €317,200 |

Three things in that table decide whether any of it is real.

**The turnover column is the problem, not the profit column.** Making €1,620
means pushing €79,300 through bookmaker accounts, at the best price in the
market, on short favourites. That is the exact customer profile every trading
desk flags. The edge does not die because the model stops working; it dies
because the accounts get limited to €5 stakes, usually within months.

**One year in five loses money.** Four of the last twenty did, and the
theoretical rate is about 15%. Two losing years back to back is perfectly
ordinary and tells you nothing about whether the edge is still there.

**Every bet must be at the best price.** The identical selections at the market
average return -1.2%. One bet placed lazily at the average price costs roughly
what one and a half bets at the best price earn. This is not a strategy with a
price-shopping bonus — the price shopping *is* the strategy.

So: 793 bets a year, two or three a day, every day, each placed at the best
price across a dozen accounts, for 16-32% of a bankroll before tax, with a 20%
chance of a losing year and a limit notice at the end of it. That is the best
this data supports. Whether it is worth doing is not a question the data can
answer — but it should be answered with those numbers in front of you, not with
a hit rate.

### Two corrections to the paragraph above

An earlier version of this page said to place "within minutes of the opening
price". **A later measurement says the opposite.** On 1,186 matches across 22
divisions with nine named bookmakers quoting both an opening and a closing
price, the best *opening* price has a closing-line value of **-0.77%** while
the best *closing* price has **+1.58%**. Waiting is worth 2.35 points over
anticipating. The folklore is wrong, at least on this month.

And the "best available price" is half the time the Betfair Exchange **gross of
commission**. Net of 5% it adds nothing over the best bookmaker, and a 5%
commission is exactly the erosion that takes this edge from +2.23% to +0.94%.

Both are measured in [The Price of the Best Price](The-Price-Of-The-Best-Price.md),
along with the reason chasing a price far above consensus is the one thing the
data punishes monotonically.
