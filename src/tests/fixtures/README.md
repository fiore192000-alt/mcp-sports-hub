# Test fixtures — real data

These are real files from the public sources the toolkit reads, kept verbatim so
the offline test suite runs against the shapes and quirks production actually
meets, not against stubs written from memory.

| File | Source | Fetched | Why this one |
|---|---|---|---|
| `openfootball-it1-2024-25.json` | `https://raw.githubusercontent.com/openfootball/football.json/master/2024-25/it.1.json` | 2026-09-15 | A complete Serie A season (380 fixtures, 370 results) — and one with a real defect: the entire final matchday is missing its results, which is what the coverage checks are written against. |
| `openfootball-it1-2025-26.json` | `https://raw.githubusercontent.com/openfootball/football.json/master/2025-26/it.1.json` | 2026-09-15 | The same league one season later, written in a different shape: 36 of its 380 matches carry a bare `"score": [0,0]` instead of `{"ft":…,"ht":…}` — and those 36 are every 0-0 of the season. Reading only `.ft` dropped all of them and biased the ratings against goalless football. The regression test lives on this file. |

Do not "fix" the data in these files, and do not normalize the 2025-26 file's
score shapes. The 10 missing results in the 2024-25 file and the bare arrays in
the 2025-26 one are the point: they are what a volunteer-maintained mirror
actually looks like, and several tests assert that the code notices rather than
assumes.

Both files were cross-checked against an independent mirror of the same league
(`datasets/football-datasets`, derived from football-data.co.uk). After the
score-shape fix, 2025-26 agrees with it exactly: 380 matches, 148 home wins,
99 draws, 133 away wins, 922 goals. `npm run verify:sources` re-runs that
comparison against both live sources.

Refresh one only to track a deliberate upstream change, and update this table
when you do.
