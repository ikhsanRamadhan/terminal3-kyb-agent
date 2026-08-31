/**
 * A2 — two questions, minimum spend (token budget is finite):
 *
 *  1. Is the control-plane-write-through-a-contract-only-ACL behaviour a
 *     regression? Bounty #1 seeded `z:<tid>:secrets` with
 *     `writers: { only: [622] }` via `maps.entrySet` on SDK 4.35.1 and it
 *     worked. Re-run the same call on 4.46.0.
 *  2. What does a 64 KiB value cost and how long does it take? 64 KiB is the
 *     chunk size the watchlist design would use, so one sample is enough.
 */
import { BASE_UNITS_PER_TOKEN } from "@terminal3/t3n-sdk";
import { openT3nSession } from "./lib/session.js";

const s = await openT3nSession();
const bal = async (): Promise<number> =>
  ((await s.t3n.getBalance()) as { available: number }).available;

let last = await bal();
const spend = async (label: string): Promise<number> => {
  const now = await bal();
  const cost = (last - now) / BASE_UNITS_PER_TOKEN;
  console.log(`  [tokens] ${label}: ${cost.toFixed(2)}`);
  last = now;
  return cost;
};

console.log("--- Q1: entrySet into `secrets` (writers {only:[622]} from bounty #1) ---");
console.log(`  secrets status: ${await s.tenant.maps.getStatus("secrets")}`);
try {
  await s.tenant.maps.entrySet("secrets", "_acl_probe", "1");
  console.log("  OK — control plane still writes through a contract-only ACL");
} catch (e: unknown) {
  console.log(`  DENIED: ${(e as Error).message}`);
  console.log("  => REGRESSION vs 4.35.1, where this same call succeeded");
}
await spend("entrySet secrets");

console.log("\n--- Q2: 64 KiB value into `sizeprobe` (restore writers:all first) ---");
await s.tenant.maps.update("sizeprobe", { readers: "all", writers: "all" });
await spend("maps.update back to all");

const value = "x".repeat(64 * 1024);
const t0 = Date.now();
try {
  await s.tenant.maps.entrySet("sizeprobe", "probe_64k", value);
  const ms = Date.now() - t0;
  const cost = await spend("entrySet 64 KiB");
  console.log(`  64 KiB OK in ${ms}ms — ${(cost / 64).toFixed(2)} tokens/KiB`);
} catch (e: unknown) {
  console.log(`  64 KiB FAILED after ${Date.now() - t0}ms: ${(e as Error).message}`);
  await spend("failed 64 KiB");
}

console.log(`\nend balance: ${((await bal()) / BASE_UNITS_PER_TOKEN).toFixed(2)} tokens`);
