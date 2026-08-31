/**
 * Health check — verifies the KYB contract is registered, responsive,
 * and the egress grant is active. Run this before/after deployments
 * or as a cron job for monitoring.
 *
 * Exit code 0 = healthy, 1 = degraded.
 */
import { getScriptVersion, BASE_UNITS_PER_TOKEN } from "@terminal3/t3n-sdk";
import { openT3nSession } from "./lib/session.js";

const CONTRACT_TAIL = "kyb";

async function main(): Promise<void> {
  const s = await openT3nSession();
  const tenantId = s.did.slice("did:t3n:".length);
  const scriptName = `z:${tenantId}:${CONTRACT_TAIL}`;

  const checks: Array<{ name: string; ok: boolean; detail: string }> = [];

  // Check 1: contract exists
  const contracts = (await s.tenant.contracts.list()) as string[];
  const exists = contracts.includes(scriptName);
  checks.push({ name: "contract_registered", ok: exists, detail: exists ? scriptName : "NOT FOUND" });

  if (!exists) {
    console.log(JSON.stringify({ healthy: false, checks }, null, 2));
    process.exitCode = 1;
    return;
  }

  // Check 2: contract is callable (lightweight verify-vat)
  const scriptVersion = await getScriptVersion(s.baseUrl, scriptName);
  try {
    const out = await s.t3n.execute({
      script_name: scriptName,
      script_version: scriptVersion,
      function_name: "verify-vat",
      input: { country: "NL", vat_number: "002230884B01" },
    });
    const parsed = JSON.parse(out as string);
    checks.push({ name: "verify_vat_responsive", ok: true, detail: `valid=${parsed.valid}` });
  } catch (e: unknown) {
    checks.push({ name: "verify_vat_responsive", ok: false, detail: (e as Error).message.slice(0, 100) });
  }

  // Check 3: balance sufficient
  const bal = ((await s.t3n.getBalance()) as { available: number }).available;
  const balTokens = bal / BASE_UNITS_PER_TOKEN;
  checks.push({ name: "balance_sufficient", ok: balTokens > 500, detail: `${balTokens.toFixed(2)} tokens` });

  const healthy = checks.every((c) => c.ok);
  console.log(JSON.stringify({ healthy, timestamp: new Date().toISOString(), checks }, null, 2));
  if (!healthy) process.exitCode = 1;
}

main().catch((e: unknown) => {
  console.error("Health check crashed:", e);
  process.exitCode = 1;
});