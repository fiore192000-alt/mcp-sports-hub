import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { matchId, parseCsv, seasonWindow, teamSlug, write } from "../../scripts/collect.mjs";

let dir, prev;
before(() => {
  dir = mkdtempSync(join(tmpdir(), "collect-"));
  prev = process.env.SPORTS_HUB_COLLECT_DIR;
  process.env.SPORTS_HUB_COLLECT_DIR = dir;
});
after(() => {
  if (prev === undefined) delete process.env.SPORTS_HUB_COLLECT_DIR;
  else process.env.SPORTS_HUB_COLLECT_DIR = prev;
  rmSync(dir, { recursive: true, force: true });
});

describe("matchId", () => {
  it("is stable across the ways a source might spell the same fixture", () => {
    const want = matchId("I1", "2026-09-12", "Lazio", "Milan");
    for (const [h, a] of [["lazio", "milan"], ["  Lazio  ", "Milan"], ["LAZIO", "MiLaN"], ["Lazio!", "Milan."]]) {
      assert.equal(matchId("I1", "2026-09-12", h, a), want, `${h} v ${a}`);
    }
  });

  it("folds letters NFD will not decompose, so Bodø and Bodo are one team", () => {
    // These are letters in their own right, not a base plus a diacritic, so
    // NFD leaves them and a naive non-ASCII strip deletes them outright —
    // silently forking a club into two. Found by this test, not in production.
    assert.equal(matchId("N1", "2026-09-12", "Bodø/Glimt", "Ajax"), matchId("N1", "2026-09-12", "Bodo/Glimt", "Ajax"));
    for (const [odd, plain] of [["Bodø", "Bodo"], ["Łódź", "Lodz"], ["Đjurgården", "Djurgarden"], ["Fenerbahçe", "Fenerbahce"], ["Malmö", "Malmo"]]) {
      assert.equal(teamSlug(odd), teamSlug(plain), `${odd} should fold to ${plain}`);
    }
  });

  it("still folds ordinary accents", () => {
    for (const [a, b] of [["Atlético", "Atletico"], ["Beşiktaş", "Besiktas"], ["Köln", "Koln"]]) {
      assert.equal(teamSlug(a), teamSlug(b), `${a} vs ${b}`);
    }
  });

  it("takes the date from a full timestamp, so kickoff time does not fork the id", () => {
    assert.equal(
      matchId("E0", "2026-09-12T14:00:00.000Z", "Arsenal", "Chelsea"),
      matchId("E0", "2026-09-12", "Arsenal", "Chelsea"),
    );
  });

  it("keeps different fixtures apart, including the reverse tie", () => {
    const a = matchId("E0", "2026-09-12", "Arsenal", "Chelsea");
    assert.notEqual(a, matchId("E0", "2026-09-12", "Chelsea", "Arsenal"), "home and away are not interchangeable");
    assert.notEqual(a, matchId("E1", "2026-09-12", "Arsenal", "Chelsea"), "league matters");
    assert.notEqual(a, matchId("E0", "2026-09-13", "Arsenal", "Chelsea"), "date matters");
  });

  it("does not crash on a missing or empty team name", () => {
    for (const bad of [undefined, null, "", "   ", "!!!"]) {
      const id = matchId("E0", "2026-09-12", bad, "Chelsea");
      assert.match(id, /^E0-2026-09-12-UNK-CHELSE$/, `got ${id}`);
    }
  });
});

describe("seasonWindow", () => {
  it("spans the July-to-June window a season code names", () => {
    assert.deepEqual(seasonWindow("2425"), ["2024-07-01", "2025-06-30"]);
    assert.deepEqual(seasonWindow("0506"), ["2005-07-01", "2006-06-30"]);
  });
});

describe("parseCsv", () => {
  it("reads a header and trims, and tolerates a short final row", () => {
    const rows = parseCsv("Div, HomeTeam ,AwayTeam\r\nE0,Arsenal,Chelsea\nE0,Spurs\n");
    assert.equal(rows.length, 2);
    assert.equal(rows[0].HomeTeam, "Arsenal");
    assert.equal(rows[1].AwayTeam, "", "a missing trailing cell reads as empty, not undefined");
  });

  it("skips blank lines rather than emitting empty rows", () => {
    assert.equal(parseCsv("A,B\n1,2\n\n\n3,4\n").length, 2);
  });
});

describe("write", () => {
  it("appends and never rewrites, so a second run cannot lose the first", () => {
    write("odds", [{ match_id: "X", price: 2.0, observed_at: "2026-09-16T10:00:00.000Z" }]);
    write("odds", [{ match_id: "X", price: 2.1, observed_at: "2026-09-16T11:00:00.000Z" }]);
    const lines = readFileSync(join(dir, "odds", "2026-09-16.ndjson"), "utf8").split("\n").filter(Boolean);
    assert.equal(lines.length, 2, "the second observation must not overwrite the first");
    assert.deepEqual(lines.map((l) => JSON.parse(l).price), [2.0, 2.1]);
  });

  it("files rows by the day they were observed, not the day the process ran", () => {
    write("odds", [
      { match_id: "Y", price: 3, observed_at: "2026-01-01T23:59:00.000Z" },
      { match_id: "Y", price: 3, observed_at: "2026-01-02T00:01:00.000Z" },
    ]);
    const files = readdirSync(join(dir, "odds")).sort();
    assert.ok(files.includes("2026-01-01.ndjson") && files.includes("2026-01-02.ndjson"), `got ${files}`);
  });

  it("writes nothing at all for an empty batch", () => {
    const before = readdirSync(join(dir, "odds")).length;
    assert.equal(write("odds", []), 0);
    assert.equal(readdirSync(join(dir, "odds")).length, before);
  });

  it("emits one JSON object per line, which is what DuckDB reads", () => {
    write("results", [{ match_id: "Z", ft_home: 1, ft_away: 0, observed_at: "2026-03-03T12:00:00.000Z" }]);
    const text = readFileSync(join(dir, "results", "2026-03-03.ndjson"), "utf8");
    assert.ok(text.endsWith("\n"), "a trailing newline keeps the next append on its own line");
    for (const line of text.split("\n").filter(Boolean)) assert.doesNotThrow(() => JSON.parse(line));
  });
});
