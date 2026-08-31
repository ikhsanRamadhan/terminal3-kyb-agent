/**
 * A5 — pin down the ceiling and what it measures.
 *
 * Established: value 256 B accepted, 512 B rejected with
 *   "access denied: StorageRouterOnBehalfOf(Contract(tee:tenant/contracts))
 *    cannot write map z:<tid>:secrets"
 * Failures cost nothing; each success costs ~70 tokens, so keep successes few.
 *
 * Questions:
 *   1. Exact boundary between 256 and 512.
 *   2. Does the key count toward it? (long key + tiny value)
 */
import { BASE_UNITS_PER_TOKEN } from "@terminal3/t3n-sdk";
import { openT3nSession } from "./lib/session.js";

const s = await openT3nSession();
const bal = async (): Promise<number> =>
  ((await s.t3n.getBalance()) as { available: number }).available;
const start = await bal();
const MAP = "secrets";

const put = async (key: string, value: string): Promise<boolean> => {
  try {
    await s.tenant.maps.entrySet(MAP, key, value);
    return true;
  } catch (e: unknown) {
    if (!(e as Error).message.includes("access denied")) {
      console.log(`    (different error: ${(e as Error).message.slice(0, 100)})`);
    }
    return false;
  }
};

// Probe the failing side first — rejections are free, so a descending walk
// costs one success total.
console.log("--- boundary between 256 and 512 B (value) ---");
let accepted = 256;
for (const n of [508, 500, 496, 480, 448, 384, 320, 288, 272, 264]) {
  const ok = await put(`_b_${n}`, "x".repeat(n));
  console.log(`  ${String(n).padStart(4)} B -> ${ok ? "OK" : "denied"}`);
  if (ok) {
    accepted = n;
    break;
  }
}
console.log(`largest accepted value in this walk: ${accepted} B`);

console.log("\n--- does the key count? 200 B key + 200 B value = 400 B total ---");
const longKey = "k".repeat(200);
console.log(`  -> ${(await put(longKey, "x".repeat(200))) ? "OK (key not counted)" : "denied (total counted)"}`);

console.log("\n--- control: 250 B key + 1 B value ---");
console.log(`  -> ${(await put("k".repeat(250), "x") ) ? "OK" : "denied"}`);

console.log(
  `\nspent ${((start - (await bal())) / BASE_UNITS_PER_TOKEN).toFixed(2)} tokens; ` +
    `left ${((await bal()) / BASE_UNITS_PER_TOKEN).toFixed(2)}`,
);
