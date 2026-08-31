/**
 * KV sizing probe — the watchlist design depends on how big a single
 * map-entry value can be and what it costs. Writes progressively larger
 * values into a throwaway map and reports cost per KiB.
 *
 * Read-mostly budget guard: aborts if the balance drops below FLOOR.
 */
import { BASE_UNITS_PER_TOKEN } from "@terminal3/t3n-sdk";
import { openT3nSession } from "./lib/session.js";

const FLOOR = 4_000 * BASE_UNITS_PER_TOKEN;
const MAP_TAIL = "sizeprobe";

const s = await openT3nSession();

async function bal(): Promise<number> {
  return ((await s.t3n.getBalance()) as { available: number }).available;
}

let last = await bal();
console.log(`start balance: ${(last / BASE_UNITS_PER_TOKEN).toFixed(2)} tokens`);

const existing = (await s.tenant.contracts.list()) as string[];
console.log("contracts:", existing.length);

// Reuse the existing `secrets` map — creating a map costs ~150 tokens.
const statuses: Record<string, string> = {};
for (const tail of ["secrets", MAP_TAIL]) {
  try {
    statuses[tail] = (await s.tenant.maps.getStatus(tail)) as string;
  } catch (e: unknown) {
    statuses[tail] = `ERR ${(e as Error).message}`;
  }
}
console.log("map status:", statuses);

if (statuses[MAP_TAIL] !== "active") {
  console.log(`creating ${MAP_TAIL} (status was ${statuses[MAP_TAIL]})`);
  await s.tenant.maps.create({
    tail: MAP_TAIL,
    visibility: "private",
    readers: "all",
    writers: "all",
  });
  console.log(`  cost: ${((last - (await bal())) / BASE_UNITS_PER_TOKEN).toFixed(2)} tokens`);
  console.log(`  status now: ${await s.tenant.maps.getStatus(MAP_TAIL)}`);
}
const target = MAP_TAIL;
console.log(`probing into: ${target}`);

for (const kib of [1, 16, 64, 192]) {
  const value = "x".repeat(kib * 1024);
  const before = await bal();
  if (before < FLOOR) {
    console.log("budget floor reached — stopping");
    break;
  }
  try {
    const t0 = Date.now();
    await s.tenant.maps.entrySet(target, `probe_${kib}k`, value);
    const ms = Date.now() - t0;
    const after = await bal();
    const cost = (before - after) / BASE_UNITS_PER_TOKEN;
    console.log(`  ${kib} KiB -> OK in ${ms}ms, cost ${cost.toFixed(2)} tokens (${(cost / kib).toFixed(2)}/KiB)`);
  } catch (e: unknown) {
    const after = await bal();
    console.log(`  ${kib} KiB -> FAILED: ${(e as Error).message}`);
    console.log(`     cost of failure: ${((before - after) / BASE_UNITS_PER_TOKEN).toFixed(2)} tokens`);
    break;
  }
}

last = await bal();
console.log(`end balance: ${(last / BASE_UNITS_PER_TOKEN).toFixed(2)} tokens`);
