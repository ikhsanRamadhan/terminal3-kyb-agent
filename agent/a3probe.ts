/**
 * A3 — isolate the `sizeprobe` denial: is it the value size or is
 * `maps.update` unable to restore a permissive ACL?
 *
 * Sequence so far on this map:
 *   create writers:"all"        -> entrySet 1 KiB  OK
 *   update writers:{only:[629]} -> entrySet 1 KiB  DENIED
 *   update writers:"all"        -> entrySet 64 KiB DENIED
 *
 * If 1 KiB is denied now, the ACL update is one-way (bug). If 1 KiB passes,
 * the 64 KiB denial is a size ceiling reported as an access error (also a bug,
 * just a different one). Then walk the size up to find the ceiling.
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

const set = async (map: string, key: string, kib: number): Promise<boolean> => {
  const t0 = Date.now();
  try {
    await s.tenant.maps.entrySet(map, key, "x".repeat(kib * 1024));
    const ms = Date.now() - t0;
    const cost = await spend(`${map}/${kib}KiB`);
    console.log(`  ${kib} KiB -> OK in ${ms}ms (${(cost / kib).toFixed(2)} tok/KiB)`);
    return true;
  } catch (e: unknown) {
    console.log(`  ${kib} KiB -> ${(e as Error).message.slice(0, 120)}`);
    await spend(`${map}/${kib}KiB failed`);
    return false;
  }
};

console.log("--- 1 KiB into sizeprobe (writers restored to 'all' last run) ---");
const smallOk = await set("sizeprobe", "probe_1k_again", 1);

if (!smallOk) {
  console.log("\n=> maps.update cannot restore a permissive ACL: one-way. Using `secrets`.");
  console.log("\n--- size walk on `secrets` (bounty-#1 map, control-plane writable) ---");
  for (const kib of [8, 32, 64]) {
    if (!(await set("secrets", `_szprobe_${kib}k`, kib))) break;
  }
} else {
  console.log("\n=> ACL fine; 64 KiB was a size ceiling. Walking up.");
  for (const kib of [16, 32, 48]) {
    if (!(await set("sizeprobe", `probe_${kib}k`, kib))) break;
  }
}

console.log(`\nend balance: ${((await bal()) / BASE_UNITS_PER_TOKEN).toFixed(2)} tokens`);
