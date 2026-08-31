/**
 * ACL probe — bounty #1 seeded `secrets` through the control plane while the
 * map's `writers` was `{ only: [contractId] }`. On 4.46.0 a map created with
 * `writers: "all"` REFUSES that same control-plane write:
 *
 *   access denied: StorageRouterOnBehalfOf(Contract(tee:tenant/contracts))
 *     cannot write map "z:<tid>:sizeprobe"
 *
 * This script flips `sizeprobe` to `{ only: [<attest contract id>] }` and
 * retries, to establish which is the permissive setting.
 */
import { BASE_UNITS_PER_TOKEN } from "@terminal3/t3n-sdk";
import { openT3nSession } from "./lib/session.js";

const MAP_TAIL = "sizeprobe";
const ATTEST_ID = 629; // registered in bounty #1, still listed on this tenant

const s = await openT3nSession();
const bal = async (): Promise<number> =>
  ((await s.t3n.getBalance()) as { available: number }).available;

let last = await bal();
const spend = async (label: string): Promise<void> => {
  const now = await bal();
  console.log(`  [tokens] ${label}: ${((last - now) / BASE_UNITS_PER_TOKEN).toFixed(2)}`);
  last = now;
};

console.log("--- A: writers 'all' (current) -> entrySet ---");
try {
  await s.tenant.maps.entrySet(MAP_TAIL, "k", "v");
  console.log("  OK");
} catch (e: unknown) {
  console.log(`  DENIED: ${(e as Error).message}`);
}
await spend("entrySet under writers:all");

console.log(`\n--- B: writers { only: [${ATTEST_ID}] } -> entrySet ---`);
await s.tenant.maps.update(MAP_TAIL, {
  readers: { only: [ATTEST_ID] },
  writers: { only: [ATTEST_ID] },
});
await spend("maps.update to only:[id]");

for (const kib of [1, 16, 64, 192]) {
  const value = "x".repeat(kib * 1024);
  const t0 = Date.now();
  try {
    await s.tenant.maps.entrySet(MAP_TAIL, `probe_${kib}k`, value);
    const ms = Date.now() - t0;
    const before = last;
    const now = await bal();
    last = now;
    const cost = (before - now) / BASE_UNITS_PER_TOKEN;
    console.log(
      `  ${kib} KiB -> OK in ${ms}ms, ${cost.toFixed(2)} tokens (${(cost / kib).toFixed(2)}/KiB)`,
    );
  } catch (e: unknown) {
    console.log(`  ${kib} KiB -> FAILED after ${Date.now() - t0}ms: ${(e as Error).message}`);
    await spend(`failed ${kib}KiB`);
    break;
  }
}

console.log(`\nend balance: ${((await bal()) / BASE_UNITS_PER_TOKEN).toFixed(2)} tokens`);
