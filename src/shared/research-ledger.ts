/**
 * The gate in front of the judge.
 *
 * The ledger in `research/hypotheses.json` only works if registration happens
 * BEFORE the result is seen, and nothing in software can prove that. What this
 * module can do is make the weaker guarantee that matters almost as much: a
 * claim cannot be audited against a hypothesis count it supplied itself.
 *
 * `npm run budget -- register` issues a token bound to the hypothesis text and
 * the moment it was written down. `trading_audit_signal` takes that token,
 * looks it up here, and reads the count off the ledger rather than off the
 * caller. An unregistered claim can still be audited — it just can never reach
 * CANDIDATE, because an undeclared search size is not a small one, it is an
 * unknown one.
 *
 * Forging a token means editing the ledger by hand. That is the point: it turns
 * a lapse of memory into a deliberate act.
 */

import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export interface LedgerEntry {
  id: number;
  registered_at: string;
  hypothesis: string;
  count?: number;
  scope?: string | null;
  verdict?: "validated" | "rejected" | null;
  note?: string | null;
  resolved_at?: string | null;
}

/** Where the ledger lives. Resolved per call so tests can point it elsewhere. */
export function ledgerPath(): string {
  return process.env.SPORTS_HUB_RESEARCH_LOG
    ?? join(process.cwd(), "research", "hypotheses.json");
}

export function readLedger(): LedgerEntry[] {
  const p = ledgerPath();
  if (!existsSync(p)) return [];
  try {
    const parsed = JSON.parse(readFileSync(p, "utf8"));
    return Array.isArray(parsed) ? parsed as LedgerEntry[] : [];
  } catch {
    return [];
  }
}

/** Hypotheses charged so far. A sweep registered once may count as many. */
export function consumed(rows: LedgerEntry[]): number {
  return rows.reduce((n, r) => n + (Number.isInteger(r.count) && (r.count as number) > 0 ? r.count as number : 1), 0);
}

/** Deterministic over the entry, so it cannot be produced without writing it down. */
export function tokenFor(entry: LedgerEntry): string {
  const material = `${entry.id}|${entry.hypothesis}|${entry.registered_at}|${entry.count ?? 1}`;
  return `h${entry.id}-${createHash("sha256").update(material).digest("hex").slice(0, 12)}`;
}

export interface Registration {
  verified: boolean;
  reason?: string;
  hypothesis?: string;
  registered_at?: string;
  /** Hypotheses the whole search has consumed, read from the ledger not the caller. */
  ledger_consumed?: number;
  /** What this one entry counts as. */
  entry_count?: number;
}

/**
 * Verify a token. Also checks the label against the registered hypothesis when
 * one is given, because registering "A" and auditing "B" is the obvious way
 * round a gate like this.
 */
export function verifyToken(token: string, label?: string): Registration {
  const rows = readLedger();
  if (rows.length === 0) {
    return { verified: false, reason: "No research ledger found. Register the hypothesis with `npm run budget -- register` before auditing it." };
  }
  const entry = rows.find((r) => tokenFor(r) === token);
  if (!entry) {
    return { verified: false, reason: `Token ${token} matches no entry in the ledger. A token is issued by \`npm run budget -- register\` and is bound to the hypothesis text and the moment it was written down.` };
  }
  const reg: Registration = {
    verified: true,
    hypothesis: entry.hypothesis,
    registered_at: entry.registered_at,
    ledger_consumed: consumed(rows),
    entry_count: Number.isInteger(entry.count) && (entry.count as number) > 0 ? entry.count as number : 1,
  };
  if (label && !looksLikeSameClaim(label, entry.hypothesis)) {
    return {
      ...reg,
      verified: false,
      reason: `Token #${entry.id} was registered for "${entry.hypothesis}", which does not look like "${label}". Register the claim you are actually auditing.`,
    };
  }
  return reg;
}

/**
 * Deliberately loose: wording drifts between registering an idea and writing it
 * up, and a strict match would just teach people to paste. It catches the case
 * that matters, which is auditing something unrelated to what was registered.
 */
function looksLikeSameClaim(a: string, b: string): boolean {
  const words = (s: string) => new Set(
    s.toLowerCase().replace(/[^a-z0-9.%<>= ]/g, " ").split(/\s+/)
      .filter((w) => w.length > 2 && !STOP.has(w)),
  );
  const wa = words(a), wb = words(b);
  if (wa.size === 0 || wb.size === 0) return true;
  let shared = 0;
  for (const w of wa) if (wb.has(w)) shared++;
  return shared / Math.min(wa.size, wb.size) >= 0.3;
}

const STOP = new Set(["the", "and", "for", "with", "any", "all", "that", "this", "from", "into", "over", "under", "when", "than", "then", "its"]);
