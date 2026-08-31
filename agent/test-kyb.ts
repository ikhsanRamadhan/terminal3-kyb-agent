/**
 * KYB happy-path test — invoke verify-vat, verify-lei, and kyb-screen
 * against real companies to prove the agent works end-to-end.
 */
import { getScriptVersion, BASE_UNITS_PER_TOKEN } from "@terminal3/t3n-sdk";
import { openT3nSession, type T3nSession } from "./lib/session.js";

const CONTRACT_TAIL = "kyb";

async function tokens(s: T3nSession, label: string, lastRaw: number): Promise<number> {
  const bal = (await s.t3n.getBalance()) as { available: number };
  const delta = lastRaw - bal.available;
  console.log(`  [tokens] ${label}: ${(delta / BASE_UNITS_PER_TOKEN).toFixed(4)}`);
  return bal.available;
}

async function main(): Promise<void> {
  const s = await openT3nSession();
  const tenantId = s.did.slice("did:t3n:".length);
  const scriptName = `z:${tenantId}:${CONTRACT_TAIL}`;
  let bal = ((await s.t3n.getBalance()) as { available: number }).available;
  console.log(`balance: ${(bal / BASE_UNITS_PER_TOKEN).toFixed(2)} tokens`);

  const scriptVersion = await getScriptVersion(s.baseUrl, scriptName);

  // Test 1: verify-vat (Google Ireland)
  console.log("\n=== Test 1: verify-vat (Google Ireland, IE/6388047V) ===");
  try {
    const out = await s.t3n.execute({
      script_name: scriptName,
      script_version: scriptVersion,
      function_name: "verify-vat",
      input: { country: "IE", vat_number: "6388047V" },
    });
    console.log("  result:", out);
  } catch (e: unknown) {
    console.error("  FAILED:", (e as Error).message.slice(0, 200));
  }
  bal = await tokens(s, "verify-vat", bal);

  // Test 2: verify-lei (Siemens Energy)
  console.log("\n=== Test 2: verify-lei (Siemens Energy, 5299004MG7BJU2QS6Q75) ===");
  try {
    const out = await s.t3n.execute({
      script_name: scriptName,
      script_version: scriptVersion,
      function_name: "verify-lei",
      input: { lei: "5299004MG7BJU2QS6Q75" },
    });
    console.log("  result:", out);
  } catch (e: unknown) {
    console.error("  FAILED:", (e as Error).message.slice(0, 200));
  }
  bal = await tokens(s, "verify-lei", bal);

  // Test 3: kyb-screen (combined)
  console.log("\n=== Test 3: kyb-screen (Albert Heijn, NL/002230884B01) ===");
  try {
    const out = await s.t3n.execute({
      script_name: scriptName,
      script_version: scriptVersion,
      function_name: "kyb-screen",
      input: {
        company: "ALBERT HEIJN B.V.",
        vat_country: "NL",
        vat_number: "002230884B01",
        lei: null,
      },
    });
    console.log("  result:", out);
  } catch (e: unknown) {
    console.error("  FAILED:", (e as Error).message.slice(0, 200));
  }
  bal = await tokens(s, "kyb-screen", bal);

  // Test 4: invalid VAT (should return valid=false)
  console.log("\n=== Test 4: verify-vat (invalid, DE/999999999) ===");
  try {
    const out = await s.t3n.execute({
      script_name: scriptName,
      script_version: scriptVersion,
      function_name: "verify-vat",
      input: { country: "DE", vat_number: "999999999" },
    });
    console.log("  result:", out);
  } catch (e: unknown) {
    console.error("  FAILED:", (e as Error).message.slice(0, 200));
  }
  bal = await tokens(s, "verify-vat (invalid)", bal);

  console.log(`\nfinal balance: ${((await s.t3n.getBalance()) as { available: number }).available / BASE_UNITS_PER_TOKEN} tokens`);
}

main().catch((e: unknown) => {
  console.error("\nKYB test FAILED:", e);
  process.exitCode = 1;
});