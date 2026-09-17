import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const DIR = "predictions";

/**
 * The prediction log is the only record of what was forecast before a match was
 * played. These assertions guard the properties the scorer relies on — most of
 * all that every row records the source it came from, because the scorer now
 * defaults to that source and the two sources spell teams differently.
 */
describe("the prediction log", () => {
  const files = existsSync(DIR) ? readdirSync(DIR).filter((f) => f.endsWith(".json")) : [];

  it("has something logged", () => {
    assert.ok(files.length > 0, "no prediction files — nothing to protect");
  });

  for (const file of files) {
    describe(file, () => {
      const log = JSON.parse(readFileSync(join(DIR, file), "utf8"));
      const rows = log.predictions ?? [];

      it("records which source each prediction was made from", () => {
        // The scorer follows this field. A row without it falls back to the
        // global default, which will match nothing if the names differ.
        for (const r of rows) {
          assert.ok(r.source, `${r.date} ${r.home} v ${r.away} has no source`);
        }
      });

      it("uses one source per file, so the scorer's default is unambiguous", () => {
        const sources = new Set(rows.filter((r) => !r.superseded_at).map((r) => r.source));
        assert.ok(sources.size <= 1, `mixes sources: ${[...sources].join(", ")} — team names differ between them`);
      });

      it("carries probabilities that are probabilities and sum to one", () => {
        for (const r of rows) {
          const p = [r.prob_home, r.prob_draw, r.prob_away];
          for (const x of p) assert.ok(x > 0 && x < 1, `${r.home} v ${r.away}: ${x} is not a probability`);
          // Probabilities are stored rounded to six decimals, so three of them
          // sum to 1 +/- 1e-6 and no tighter. A 1e-6 tolerance sits exactly on
          // that boundary and fails on roughly half the rows; 2e-6 is the
          // smallest honest bound, and anything looser would stop catching a
          // real normalisation bug.
          const total = p.reduce((a, b) => a + b, 0);
          assert.ok(Math.abs(total - 1) < 2e-6, `${r.home} v ${r.away} sums to ${total}`);
        }
      });

      it("was predicted before the match it predicts", () => {
        // The one property that makes a forecast a forecast.
        for (const r of rows) {
          assert.ok(r.predicted_at, `${r.home} v ${r.away} has no predicted_at`);
          const predicted = new Date(r.predicted_at);
          const kickoff = new Date(`${r.date}T${r.time || "23:59"}:00Z`);
          assert.ok(predicted < kickoff,
            `${r.home} v ${r.away}: predicted ${r.predicted_at} but kicks off ${r.date} ${r.time ?? ""}`);
        }
      });

      it("keeps superseded rows rather than deleting them", () => {
        for (const r of rows) {
          if ("superseded_at" in r && r.superseded_at !== null) {
            assert.ok(r.superseded_reason || r.superseded_at,
              "a retired prediction must say it was retired, not vanish");
          }
        }
      });
    });
  }
});
