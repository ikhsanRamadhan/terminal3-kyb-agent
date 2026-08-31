/**
 * Shared authenticated-session bootstrap for the quickstart + walkthrough
 * scripts. Both `quickstart.ts` and `p2.ts` (and later `p4.ts`) need the
 * same dance: read the API key → resolve testnet → load WASM → fetch trust
 * manifest → handshake → authenticate → build a `TenantClient` over the
 * session. Kept here so the narrative scripts stay short and the auth path
 * is exercised identically everywhere.
 */
import {
  T3nClient,
  TenantClient,
  setEnvironment,
  getNodeUrl,
  loadWasmComponent,
  eth_get_address,
  metamask_sign,
  createEthAuthInput,
  fetchTrustedManifest,
  isUnsafeTrustServer,
  LogLevel,
  type TrustAnchorOrUnsafe,
} from "@terminal3/t3n-sdk";

export interface T3nSession {
  t3n: T3nClient;
  tenant: TenantClient;
  /** Key-derived signing address. */
  address: string;
  /** Authenticated DID — also the tenant DID on testnet self-admit. */
  did: string;
  baseUrl: string;
}

export async function openT3nSession(
  environment: "testnet" = "testnet",
): Promise<T3nSession> {
  const apiKey = process.env.T3N_API_KEY;
  if (!apiKey) {
    throw new Error("T3N_API_KEY required (copy it from the claim page)");
  }

  setEnvironment(environment);

  const address = eth_get_address(apiKey);
  console.log(`Signing address: ${address}`);

  const wasmComponent = await loadWasmComponent();
  console.log("WASM component loaded.");

  let trustAnchor: TrustAnchorOrUnsafe;
  try {
    trustAnchor = await fetchTrustedManifest(environment);
  } catch (e: unknown) {
    console.warn(`Trust manifest fetch failed: ${(e as Error).message}`);
    trustAnchor = { unsafe_trust_server: true };
  }

  if (isUnsafeTrustServer(trustAnchor)) {
    console.warn("!! unsafe_trust_server: DKG attestation is NOT verified.");
  } else {
    console.log("Trust manifest verified.");
  }

  const t3n = new T3nClient({
    wasmComponent,
    trustAnchor,
    handlers: { EthSign: metamask_sign(address, undefined, apiKey) },
    logLevel: LogLevel.INFO,
  });

  console.log("\n--- Handshake ---");
  const hs = await t3n.handshake();
  console.log(`Session ${hs.sessionId.value} | authenticated: ${hs.authenticated}`);

  console.log("\n--- Authenticate ---");
  const didValue = await t3n.authenticate(createEthAuthInput(address));
  const did = didValue.toString();
  console.log(`DID returned by server: ${did}`);

  const tenant = new TenantClient({
    environment,
    t3n,
    tenantDid: did,
    baseUrl: getNodeUrl(),
  });
  console.log(`Tenant control-plane baseUrl: ${tenant.config.baseUrl}`);

  return { t3n, tenant, address, did, baseUrl: tenant.config.baseUrl ?? getNodeUrl() };
}