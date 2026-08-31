/**
 * Probe — verify the API key still authenticates on SDK 4.46.0, report
 * balance, registered contracts and maps. Read-only apart from the handshake.
 */
import { openT3nSession } from "./lib/session.js";

const s = await openT3nSession();

console.log("\n--- balance ---");
console.log(await s.t3n.getBalance());

console.log("\n--- registered contracts ---");
try {
  console.log(await s.tenant.contracts.list());
} catch (e: unknown) {
  console.error("contracts.list failed:", (e as Error).message);
}

console.log("\n--- maps ---");
try {
  console.log(await s.tenant.maps.list());
} catch (e: unknown) {
  console.error("maps.list failed:", (e as Error).message);
}

console.log("\n--- TenantClient surface ---");
console.log(Object.getOwnPropertyNames(Object.getPrototypeOf(s.tenant)));
console.log("own:", Object.keys(s.tenant));

console.log("\n--- T3nClient surface ---");
console.log(Object.getOwnPropertyNames(Object.getPrototypeOf(s.t3n)).sort());
