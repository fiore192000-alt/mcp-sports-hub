#!/usr/bin/env node
/**
 * The multiple-testing ledger.
 *
 *   npm run budget -- register "<hypothesis>" [--count N] [--scope "19 leagues, 0506-2627"]
 *   npm run budget -- resolve <id> --verdict validated|rejected [--p 0.013] [--note "..."]
 *   npm run budget -- token <id>
 *   npm run budget -- status [--odds 2] [--edge 2]
 *
 * Registering issues a TOKEN. trading_audit_signal needs it: without one the
 * multiple-testing gate stays shut, because a count the caller supplied itself
 * is not a small search, it is an unknown one.
 *
 * A research swarm that is not charged for the size of its own search will
 * always find something. This file is the charge. Every hypothesis you test is
 * registered BEFORE you see its result, the count is append-only, and the bar
 * every future finding must clear is derived from that count.
 *
 * It is deliberately inconvenient. Registering a hypothesis after looking at
 * the answer defeats the whole mechanism, and nothing in software can detect
 * that — only the discipline of writing it down first.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const LOG = join(root, "research", "hypotheses.json");

const argv = process.argv.slice(2);
const cmd = argv[0];
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
};

function load() {
  if (!existsSync(LOG)) return [];
  try {
    const parsed = JSON.parse(readFileSync(LOG, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.error(`research/hypotheses.json is not readable (${err.message}). Refusing to overwrite it — fix or move it by hand.`);
    process.exit(1);
  }
}

function save(rows) {
  mkdirSync(dirname(LOG), { recursive: true });
  writeFileSync(LOG, JSON.stringify(rows, null, 2) + "\n");
}

// Acklam's inverse normal CDF, same as src/shared/evidence.ts.
function normalQuantile(p) {
  const a = [-3.969683028665376e+1, 2.209460984245205e+2, -2.759285104469687e+2,
             1.383577518672690e+2, -3.066479806614716e+1, 2.506628277459239e+0];
  const b = [-5.447609879822406e+1, 1.615858368580409e+2, -1.556989798598866e+2,
             6.680131188771972e+1, -1.328068155288572e+1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838e+0,
             -2.549732539343734e+0, 4.374664141464968e+0, 2.938163982698783e+0];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996e+0, 3.754408661907416e+0];
  const pLow = 0.02425;
  let q, r;
  if (p < pLow) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) / ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1);
  }
  if (p > 1 - pLow) {
    q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) / ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1);
  }
  q = p - 0.5; r = q * q;
  return (((((a[0]*r+a[1])*r+a[2])*r+a[3])*r+a[4])*r+a[5]) * q / (((((b[0]*r+b[1])*r+b[2])*r+b[3])*r+b[4])*r+1);
}
/** Must match tokenFor() in src/shared/research-ledger.ts. */
const tokenFor = (e) =>
  `h${e.id}-${createHash("sha256").update(`${e.id}|${e.hypothesis}|${e.registered_at}|${e.count ?? 1}`).digest("hex").slice(0, 12)}`;

const bar = (k, alpha = 0.05) => normalQuantile(1 - alpha / (2 * Math.max(1, k)));
/** Total hypotheses charged, where a sweep registered once may count as many. */
const consumed = (rows) => rows.reduce((n, r) => n + (Number.isInteger(r.count) && r.count > 0 ? r.count : 1), 0);

function betsNeeded(odds, edgePct, z) {
  const p = (1 + edgePct / 100) / odds;
  const sd = odds * Math.sqrt(p * (1 - p));
  return Math.ceil((z * sd / (edgePct / 100)) ** 2);
}

if (cmd === "register") {
  const text = argv[1];
  if (!text || text.startsWith("--")) {
    console.error('Usage: npm run budget -- register "<hypothesis>" [--scope "..."]');
    process.exit(1);
  }
  const count = Math.max(1, Math.floor(Number(flag("count", 1))));
  if (!Number.isFinite(count)) { console.error("--count must be a positive integer"); process.exit(1); }
  const rows = load();
  const before = consumed(rows);
  const row = {
    id: rows.length + 1,
    registered_at: new Date().toISOString(),
    hypothesis: text,
    // A sweep tests many hypotheses under one description. Counting it as one
    // would be the exact dishonesty this ledger exists to prevent.
    count,
    scope: flag("scope", null),
    verdict: null,
    note: null,
    resolved_at: null,
  };
  rows.push(row);
  save(rows);
  const k = consumed(rows);
  console.log(`Registered #${row.id}: ${text}`);
  if (count > 1) console.log(`  counts as ${count} hypotheses`);
  if (row.scope) console.log(`  scope: ${row.scope}`);
  console.log(`\nHypotheses consumed: ${k}`);
  console.log(`Every finding from here on must clear t >= ${bar(k).toFixed(3)} (was ${bar(before).toFixed(3)}).`);
  console.log(`\nToken: ${tokenFor(row)}`);
  console.log("Pass it to trading_audit_signal as research_token. Without it the multiple-testing gate stays shut.");
  process.exit(0);
}

if (cmd === "resolve") {
  const id = Number(argv[1]);
  const verdict = flag("verdict");
  if (!Number.isInteger(id) || !["validated", "rejected"].includes(verdict)) {
    console.error("Usage: npm run budget -- resolve <id> --verdict validated|rejected [--note \"...\"]");
    process.exit(1);
  }
  const rows = load();
  const row = rows.find((r) => r.id === id);
  if (!row) { console.error(`No hypothesis #${id}.`); process.exit(1); }
  if (row.verdict) { console.error(`#${id} is already ${row.verdict}. The log is append-only; register a new hypothesis instead of rewriting this one.`); process.exit(1); }
  row.verdict = verdict;
  const pRaw = flag("p", null);
  if (pRaw !== null) {
    const pv = Number(pRaw);
    if (!(pv >= 0 && pv <= 1)) { console.error(`--p must be a probability in [0,1], got ${pRaw}`); process.exit(1); }
    row.p_value = pv;
  }
  row.note = flag("note", null);
  row.resolved_at = new Date().toISOString();
  save(rows);
  console.log(`#${id} -> ${verdict}${row.p_value !== undefined ? `  p=${row.p_value}` : ""}${row.note ? `  (${row.note})` : ""}`);
  const withP = load().filter((r) => typeof r.p_value === "number").length;
  if (row.p_value === undefined) {
    console.log("No --p recorded. Without p-values the FDR route is unavailable and only Bonferroni applies, which at this ledger size is punishing.");
  } else {
    console.log(`${withP} of ${load().length} entries now carry a p-value.`);
  }
  process.exit(0);
}

if (cmd === "token") {
  const id = Number(argv[1]);
  const row = load().find((r) => r.id === id);
  if (!row) { console.error(`No hypothesis #${argv[1]}.`); process.exit(1); }
  console.log(tokenFor(row));
  process.exit(0);
}

if (cmd === "status" || cmd === undefined) {
  const rows = load();
  const k = consumed(rows);
  const odds = Number(flag("odds", 2));
  const edge = Number(flag("edge", 2));
  const z = bar(Math.max(1, k));
  console.log(`Hypotheses consumed: ${k}  (across ${rows.length} registered entries)`);
  const validated = rows.filter((r) => r.verdict === "validated").length;
  const rejected = rows.filter((r) => r.verdict === "rejected").length;
  console.log(`  entries: validated ${validated}   rejected ${rejected}   open ${rows.length - validated - rejected}`);
  const withP = rows.filter((r) => typeof r.p_value === "number").length;
  console.log(`  ${withP} carry a p-value (Benjamini-Hochberg needs them, failures included)`);
  if (k === 0) {
    console.log("\nNothing registered yet. Register a hypothesis BEFORE you look at its result — that is the only thing that makes this count mean anything.");
    process.exit(0);
  }
  console.log(`\nBar for any finding from this search: t >= ${z.toFixed(3)} (uncorrected 1.96)`);
  console.log(`A ${edge}% edge at odds ${odds} needs ${betsNeeded(odds, edge, z)} settled bets to clear it, against ${betsNeeded(odds, edge, 1.96)} uncorrected.`);
  console.log("");
  for (const r of rows.slice(-25)) {
    const mark = r.verdict === "validated" ? "OK " : r.verdict === "rejected" ? "NO " : "?  ";
    const n = Number.isInteger(r.count) && r.count > 1 ? ` [x${r.count}]` : "";
    console.log(`${mark}#${String(r.id).padStart(4)}  ${r.registered_at.slice(0, 10)}  ${r.hypothesis}${n}${r.note ? `  — ${r.note}` : ""}`);
  }
  if (rows.length > 25) console.log(`\n(showing the last 25 of ${rows.length} entries)`);
  process.exit(0);
}

console.error(`Unknown command "${cmd}". Use register, resolve, token or status.`);
process.exit(1);
