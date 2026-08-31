/**
 * A4 — the denial tracks VALUE SIZE, not the ACL.
 *
 * Evidence so far, same map, same session, same caller:
 *   secrets  <- 1 byte   OK
 *   secrets  <- 8 KiB    "access denied: StorageRouterOnBehalfOf(...) cannot write map"
 *   sizeprobe <- 1 byte  OK
 *   sizeprobe <- 1 KiB   same access-denied
 *
 * A permission check cannot depend on payload length, so the message is wrong:
 * this is a size limit reported as an authorisation failure. Bisect the
 * threshold on `secrets` (a map the control plane demonstrably can write).
 */
import { BASE_UNITS_PER_TOKEN } from "@terminal3/t3n-sdk";
import { openT3nSession } from "./lib/session.js";

const s = await openT3nSession();
const bal = async (): Promise<number> =>
  ((await s.t3n.getBalance()) as { available: number }).available;

const start = await bal();
const MAP = "secrets";

/** true = accepted. Cost is charged only on success. */
const tryBytes = async (n: number): Promise<boolean> => {
  const t0 = Date.now();
  try {
    await s.tenant.maps.entrySet(MAP, `_sz_${n}`, "x".repeat(n));
    console.log(`  ${String(n).padStart(6)} B -> OK (${Date.now() - t0}ms)`);
    return true;
  } catch (e: unknown) {
    const msg = (e as Error).message;
    const kind = msg.includes("access denied") ? "access-denied" : msg.slice(0, 80);
    console.log(`  ${String(n).padStart(6)} B -> ${kind} (${Date.now() - t0}ms)`);
    return false;
  }
};

console.log(`--- bisecting the accepted value size on z:<tid>:${MAP} ---`);
let lo = 1; // known good
let hi = 8192; // known bad
if (await tryBytes(4096)) lo = 4096;
else hi = 4096;

while (hi - lo > 256) {
  const mid = Math.floor((lo + hi) / 2);
  if (await tryBytes(mid)) lo = mid;
  else hi = mid;
}

console.log(`\nlargest accepted: ~${lo} B; smallest rejected: ~${hi} B`);
console.log(
  `spent: ${((start - (await bal())) / BASE_UNITS_PER_TOKEN).toFixed(2)} tokens; ` +
    `left: ${((await bal()) / BASE_UNITS_PER_TOKEN).toFixed(2)}`,
);
