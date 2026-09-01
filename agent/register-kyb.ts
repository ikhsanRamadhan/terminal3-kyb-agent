/**
 * Register the KYB contract on T3N testnet, create its result map,
 * and set up egress grants for VIES + GLEIF.
 *
 * Usage: CONTRACT_VERSION=0.2.0 npm run register-kyb
 * Idempotent: map creation and egress grant are safe to re-run.
 */
import { readFile } from "node:fs/promises";
import { getContractVersion, BASE_UNITS_PER_TOKEN } from "@terminal3/t3n-sdk";
import { openT3nSession, type T3nSession } from "./lib/session.js";

const CONTRACT_TAIL = "kyb";
const CONTRACT_VERSION = process.env.CONTRACT_VERSION ?? "0.1.0";
const WASM_PATH = "../contract-kyb/target/wasm32-wasip2/release/z_tenant_kyb.wasm";
const VIES_HOST = "ec.europa.eu";
const GLEIF_HOST = "api.gleif.org";

async function tokens(s: T3nSession, label: string, lastRaw: number): Promise<number> {
  const bal = (await s.t3n.getBalance()) as { available: number };
  const delta = lastRaw - bal.available;
  console.log(`  [tokens] ${label}: ${(delta / BASE_UNITS_PER_TOKEN).toFixed(4)} (raw ${delta})`);
  return bal.available;
}

async function main(): Promise<void> {
  const s = await openT3nSession();
  const tenantId = s.did.slice("did:t3n:".length);
  const scriptName = `z:${tenantId}:${CONTRACT_TAIL}`;

  let bal = ((await s.t3n.getBalance()) as { available: number }).available;
  console.log(`balance: ${(bal / BASE_UNITS_PER_TOKEN).toFixed(2)} tokens`);

  const existing = (await s.tenant.contracts.list()) as string[];

  // Always register — re-registering at a higher version allocates a new contract_id
  console.log(`\n--- Registering ${CONTRACT_TAIL} v${CONTRACT_VERSION} ---`);
  const wasm = await readFile(WASM_PATH);
  console.log(`  wasm bytes: ${wasm.byteLength}`);
  try {
    const reg = await s.tenant.contracts.register({
      tail: CONTRACT_TAIL,
      version: CONTRACT_VERSION,
      wasm,
    });
    console.log(`  registered: ${reg.name} (contract_id ${reg.contract_id})`);
    bal = await tokens(s, "contracts.register", bal);
  } catch (e: unknown) {
    const msg = (e as Error).message;
    if (msg.includes("is not higher than current version")) {
      console.log(`  version ${CONTRACT_VERSION} already registered — skipping`);
    } else {
      throw e;
    }
  }

  // Resolve the live contract_id via the script version
  const scriptVersion = await getContractVersion(s.baseUrl, scriptName);
  console.log(`  live script_version: ${scriptVersion}`);

  // Create kyb-results map (contract-only ACL) — need the contract_id
  // Use the activity log to find it, or just try with a known ID
  console.log("\n--- Creating kyb-results map ---");
  try {
    // Get contract list to find the ID
    const listResult = await s.tenant.contracts.list();
    console.log(`  contracts: ${(listResult as string[]).filter((c: string) => c.includes(CONTRACT_TAIL))}`);

    await s.tenant.maps.create({
      tail: "kyb-results",
      visibility: "private",
      readers: "all",
      writers: "all",
    });
    console.log("  kyb-results map created");
  } catch (e: unknown) {
    const msg = (e as Error).message;
    if (msg.includes("map already exists")) {
      console.log("  kyb-results map already exists (idempotent)");
    } else {
      throw e;
    }
  }
  bal = await tokens(s, "maps.create kyb-results", bal);

  // Grant egress
  console.log("\n--- Granting egress to ec.europa.eu + api.gleif.org ---");
  await s.t3n.updateAgentAuth(s.did, {
    scriptName,
    versionReq: scriptVersion,
    functions: ["verify-vat", "verify-lei", "kyb-screen"],
    allowedHosts: [VIES_HOST, GLEIF_HOST],
  });
  console.log("  egress granted");
  bal = await tokens(s, "updateAgentAuth", bal);

  console.log(`\nfinal balance: ${(bal / BASE_UNITS_PER_TOKEN).toFixed(2)} tokens`);
}

main().catch((e: unknown) => {
  console.error("\nRegistration FAILED:", e);
  process.exitCode = 1;
});