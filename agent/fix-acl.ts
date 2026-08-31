/**
 * Point the `kyb-results` map ACL at the current contract id.
 *
 * Re-registering a contract allocates a NEW contract_id rather than replacing
 * the old one, so a map whose ACL names the old id silently denies the new
 * contract's writes:
 *
 *   access denied: TenantContract(did:t3n:<tid>/813) cannot write map
 *   "z:<tid>:kyb-results"
 *
 * There is no API to read a tail's current contract_id, so pass it in:
 *   CONTRACT_IDS=812,813 npm run fix-acl
 */
import { BASE_UNITS_PER_TOKEN } from "@terminal3/t3n-sdk";
import { openT3nSession } from "./lib/session.js";

const ids = (process.env.CONTRACT_IDS ?? "")
  .split(",")
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isInteger(n) && n > 0);

if (ids.length === 0) {
  console.error("usage: CONTRACT_IDS=812,813 npm run fix-acl");
  process.exit(1);
}

const s = await openT3nSession();
const before = ((await s.t3n.getBalance()) as { available: number }).available;

console.log(`kyb-results status: ${await s.tenant.maps.getStatus("kyb-results")}`);
console.log(`setting readers/writers to { only: [${ids.join(", ")}] }`);

await s.tenant.maps.update("kyb-results", {
  readers: { only: ids },
  writers: { only: ids },
});

const after = ((await s.t3n.getBalance()) as { available: number }).available;
console.log(`done — ${((before - after) / BASE_UNITS_PER_TOKEN).toFixed(2)} tokens`);
console.log(`balance: ${(after / BASE_UNITS_PER_TOKEN).toFixed(2)} tokens`);
