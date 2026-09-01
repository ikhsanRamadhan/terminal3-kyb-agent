/**
 * Read-only deployment status probe. Costs 0 tokens: it only lists contracts,
 * resolves the live script version, reads the result-map status and the balance.
 *
 * Run it before touching anything, and paste its output into HANDOVER.md —
 * it is the only authoritative answer to "what is actually deployed right now".
 *
 *   cd agent && npm run state
 */
import { getContractVersion, BASE_UNITS_PER_TOKEN } from "@terminal3/t3n-sdk";
import { openT3nSession } from "./lib/session.js";

const CONTRACT_TAIL = "kyb";
const RESULTS_MAP_TAIL = "kyb-results";

async function main(): Promise<void> {
  const s = await openT3nSession();
  const tenantId = s.did.slice("did:t3n:".length);
  const scriptName = `z:${tenantId}:${CONTRACT_TAIL}`;

  const contracts = (await s.tenant.contracts.list()) as string[];
  const balRaw = ((await s.t3n.getBalance()) as { available: number }).available;

  let liveVersion = "UNRESOLVED";
  try {
    liveVersion = await getContractVersion(s.baseUrl, scriptName);
  } catch (e: unknown) {
    liveVersion = `ERROR: ${(e as Error).message.slice(0, 120)}`;
  }

  let mapStatus = "UNKNOWN";
  try {
    const st = await s.tenant.maps.getStatus(RESULTS_MAP_TAIL);
    mapStatus = typeof st === "string" ? st : JSON.stringify(st);
  } catch (e: unknown) {
    mapStatus = `ERROR: ${(e as Error).message.slice(0, 120)}`;
  }

  console.log(
    JSON.stringify(
      {
        tenant_did: s.did,
        signing_address: s.address,
        base_url: s.baseUrl,
        contract_tail: scriptName,
        live_script_version: liveVersion,
        contracts_registered: contracts,
        results_map: `z:${tenantId}:${RESULTS_MAP_TAIL}`,
        results_map_status: mapStatus,
        balance_tokens: Number((balRaw / BASE_UNITS_PER_TOKEN).toFixed(2)),
      },
      null,
      2,
    ),
  );
}

main().catch((e: unknown) => {
  console.error("state probe failed:", (e as Error).message);
  process.exitCode = 1;
});
