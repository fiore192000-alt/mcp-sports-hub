import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { consumed, readLedger, tokenFor, verifyToken } from "../../dist/shared/research-ledger.js";

const ROWS = [
  { id: 1, registered_at: "2026-01-01T10:00:00.000Z", hypothesis: "Flat strategy sweep", count: 14 },
  { id: 2, registered_at: "2026-01-02T10:00:00.000Z", hypothesis: "Situational pattern mine", count: 606 },
  { id: 3, registered_at: "2026-01-03T10:00:00.000Z", hypothesis: "Steam moves above 5% on away favourites" },
];

let dir, prev;
before(() => {
  dir = mkdtempSync(join(tmpdir(), "ledger-"));
  prev = process.env.SPORTS_HUB_RESEARCH_LOG;
  process.env.SPORTS_HUB_RESEARCH_LOG = join(dir, "hypotheses.json");
  writeFileSync(process.env.SPORTS_HUB_RESEARCH_LOG, JSON.stringify(ROWS));
});
after(() => {
  if (prev === undefined) delete process.env.SPORTS_HUB_RESEARCH_LOG;
  else process.env.SPORTS_HUB_RESEARCH_LOG = prev;
  rmSync(dir, { recursive: true, force: true });
});

describe("research ledger", () => {
  it("charges a sweep what it tested, not one", () => {
    assert.equal(consumed(ROWS), 14 + 606 + 1);
    assert.equal(readLedger().length, 3);
  });

  it("treats a missing or unreadable ledger as empty rather than throwing", () => {
    const saved = process.env.SPORTS_HUB_RESEARCH_LOG;
    process.env.SPORTS_HUB_RESEARCH_LOG = join(dir, "nope.json");
    assert.deepEqual(readLedger(), []);
    const junk = join(dir, "junk.json");
    writeFileSync(junk, "{not json");
    process.env.SPORTS_HUB_RESEARCH_LOG = junk;
    assert.deepEqual(readLedger(), []);
    process.env.SPORTS_HUB_RESEARCH_LOG = saved;
  });

  it("binds a token to the entry, so editing any field invalidates it", () => {
    const t = tokenFor(ROWS[1]);
    assert.equal(t, tokenFor(ROWS[1]), "deterministic");
    for (const tweak of [
      { ...ROWS[1], hypothesis: "Situational pattern mine " },
      { ...ROWS[1], count: 605 },
      { ...ROWS[1], registered_at: "2026-01-02T10:00:01.000Z" },
      { ...ROWS[1], id: 4 },
    ]) {
      assert.notEqual(tokenFor(tweak), t, "a tampered entry must not keep its token");
    }
  });

  it("verifies a real token and reports the whole search, not just this entry", () => {
    const r = verifyToken(tokenFor(ROWS[1]), "situational pattern mine");
    assert.equal(r.verified, true);
    assert.equal(r.entry_count, 606);
    assert.equal(r.ledger_consumed, 621, "the bar is set by everything searched, not by this one entry");
  });

  it("rejects a forged token", () => {
    const r = verifyToken("h2-000000000000", "Situational pattern mine");
    assert.equal(r.verified, false);
    assert.match(r.reason, /matches no entry/);
  });

  it("rejects a real token pointed at an unrelated claim", () => {
    const r = verifyToken(tokenFor(ROWS[2]), "outcomes priced at or below 1.50 at the best available price");
    assert.equal(r.verified, false);
    assert.match(r.reason, /does not look like/);
  });

  it("tolerates the wording drifting between registering an idea and writing it up", () => {
    const r = verifyToken(tokenFor(ROWS[2]), "steam moves over 5 percent, away favourites only");
    assert.equal(r.verified, true, "a strict match would only teach people to paste");
  });

  it("says so plainly when there is no ledger at all", () => {
    const saved = process.env.SPORTS_HUB_RESEARCH_LOG;
    process.env.SPORTS_HUB_RESEARCH_LOG = join(dir, "absent.json");
    const r = verifyToken("h1-abcdef123456", "anything");
    assert.equal(r.verified, false);
    assert.match(r.reason, /No research ledger found/);
    process.env.SPORTS_HUB_RESEARCH_LOG = saved;
  });
});
