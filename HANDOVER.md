# Handover & runbook — T3N KYB Agent

Everything an operator needs to run, redeploy, or take over this agent.

## Decision: I intend to keep running it

I would like to continue operating this agent and would be interested in the
startup program / listing page. The reasoning is in the README's maintenance
section and comes down to there being no credential to rotate, no mutable
state on the read path, and one command to redeploy.

**If Terminal 3 would rather take it over, that is a clean handover** — the
whole agent is this repository plus a token balance. There is no external
service, no database, no dashboard, no DNS, no CI secret. See
[Taking it over](#taking-it-over).

## Current deployment

| Thing | Value |
|---|---|
| Tenant DID | `did:t3n:bdf0434dfcd541ec2af899ad28599f6653421694` |
| Node | `https://cn-api.sg.testnet.t3n.terminal3.io` (`setEnvironment("testnet")`) |
| Contract | `z:bdf0434dfcd541ec2af899ad28599f6653421694:kyb` |
| Contract ids | **813** (v0.1.1, live) · 812 (v0.1.0, superseded) |
| Map | `z:bdf0434dfcd541ec2af899ad28599f6653421694:kyb-results`, ACL `{ only: [812, 813] }` |
| Egress grant | `ec.europa.eu`, `api.gleif.org` for `verify-vat`, `verify-lei`, `kyb-screen` |
| WASM | `z_tenant_kyb.wasm`, 222 235 bytes |

Secrets: **none.** `.env.local` holds only `T3N_API_KEY` and `DID` — the
tenant credential, not an application secret. No `secrets` map is deployed.

## Prerequisites for an operator

```bash
node --version    # v24.x  (v24.0.0 verified)
rustc --version   # 1.96.0 verified
rustup target add wasm32-wasip2
cargo install wasm-tools --locked   # ~4 min, silent for most of it
```

Then create `.env.local` in the repo root:

```
T3N_API_KEY=<tenant API key from the claim page>
DID=<tenant DID>
```

```bash
cd agent && npm install
```

## Daily operation

Nothing to do. The contract is invoked on demand and holds no background
process. Steady-state cost is ~20 tokens per single lookup, ~170 per full
`kyb-screen`.

### Monitoring

```bash
cd agent && npm run health
```

Emits one JSON object and exits non-zero if anything is wrong. It checks
three things: the contract is registered under the expected tail, a real
`verify-vat` call round-trips through the enclave to VIES, and the token
balance is above 500.

```jsonc
{ "healthy": true,
  "timestamp": "…",
  "checks": [
    { "name": "contract_registered",   "ok": true, "detail": "z:…:kyb" },
    { "name": "verify_vat_responsive", "ok": true, "detail": "valid=true" },
    { "name": "balance_sufficient",    "ok": true, "detail": "244.43 tokens" }
  ] }
```

Cron it as often as you like — the VAT check costs 20 tokens, the other two
checks are free. Hourly is ~480 tokens/day; daily is negligible.

### Topping up tokens

The balance only moves on deployments and calls. When
`balance_sufficient` goes false, claim more test tokens from
<https://go.terminal3.io/adk-community> against the same DID. A redeploy
needs ~1550 tokens of headroom (register 1380 + map/grant/ACL ~320).

## Redeploying after a code change

```bash
./scripts/redeploy.sh 0.1.2
```

That bumps the version in `Cargo.toml` and `wit/world.wit`, builds, validates
the component, registers, and runs the health check.

### The one manual step you cannot skip

Re-registering allocates a **new** `contract_id` (this is documented platform
behaviour, not a bug). The `kyb-results` map ACL names contract ids, so the
new contract cannot write to its own map until you add it:

```bash
# note the contract_id that `register` printed, then:
cd agent && CONTRACT_IDS=812,813,<new id> npm run fix-acl
```

Skip it and `kyb-screen` fails with a message that looks like a permissions
misconfiguration:

```
access denied: TenantContract(did:t3n:<tid>/<new id>) cannot write map
  "z:<tid>:kyb-results"
```

`verify-vat` and `verify-lei` keep working, because they never write. That
asymmetry makes the failure easy to miss — a smoke test that only hits the
read-only functions will pass. `npm run test-kyb` covers `kyb-screen`, so run
the full suite after every deploy.

**Keep every historical id in the `CONTRACT_IDS` list** until you are certain
nothing references the old versions. There is no API to list a map's current
ACL, so the list in this document is the record. Update it here when you deploy.

Background and repro: `BUGS.md` B3.

## Failure modes and what they mean

| Symptom | Cause | Fix |
|---|---|---|
| `access denied: TenantContract(…/<id>) cannot write map` | Map ACL predates the current contract id | `CONTRACT_IDS=… npm run fix-acl` |
| `host/http.egress_denied` | Egress grant missing or scoped to an older version | Re-run `npm run register-kyb` (idempotent) |
| `verify-vat` returns `valid: false` for a known-good number | Upstream VIES member-state outage — VIES is per-country and individual states go offline | Retry later; not an agent fault |
| VIES returns `valid: true` with `name: "---"` | Normal: some member states (DE) do not disclose the name | Nothing to fix |
| `NotFound` from `verify-lei` | LEI genuinely absent from GLEIF | Nothing to fix |
| `access denied … StorageRouterOnBehalfOf` on a write you expect to work | KV value exceeded ~508 bytes | Shrink the value; `BUGS.md` B1 |
| ~2 MB of minified JS on stderr | Unhandled SDK rejection, no source maps | Filter with `awk 'length($0)<400'`; `BUGS.md` B7 |
| `does not provide an export named 'getScriptVersion'` | SDK ≥4.46 renamed it | Use `getContractVersion`; `BUGS.md` B4 |

## Upstream dependencies

| Dependency | Risk | Mitigation |
|---|---|---|
| EU VIES REST API | Per-member-state availability varies; no SLA | Errors surface as structured `HttpError`; scoring treats an unresolvable VAT as +40 risk rather than crashing |
| GLEIF API v1 | Stable, versioned path, no key | Response parsing tolerates missing optional fields (`Option<…>` throughout) |
| `@terminal3/t3n-sdk` | Renames land without deprecation (B4) and the changelog carries no SDK history | Pinned `^4.46.0` in `agent/package.json`; pin exactly if a break is disruptive |
| Host interfaces `@2.1.0` | Vendored under `contract-kyb/wit/deps/` | Copy matching versions from the cluster before bumping |

GLEIF's JSON shape is worth one note for whoever edits `verify_lei.rs`:
status lives in two places — `data.attributes.entity.status` (ACTIVE/INACTIVE)
and `data.attributes.registration.status` (ISSUED/LAPSED/RETIRED). There is no
`data.attributes.status`. An earlier version of this contract read the wrong
path and silently returned empty strings for both.

## Taking it over

1. **Fork or transfer the repository.** It is self-contained; there is nothing
   outside it.
2. **Use your own tenant.** Claim an API key and DID, put them in
   `.env.local`. Nothing in the code hardcodes my tenant — the DID is read
   back from the authenticated session and map paths are built at runtime from
   `tenant_context::tenant_did()`.
3. **Deploy from scratch:**
   ```bash
   cd contract-kyb && cargo build --target wasm32-wasip2 --release
   cd ../agent && npm install
   CONTRACT_VERSION=0.1.1 npm run register-kyb
   CONTRACT_IDS=<id printed above> npm run fix-acl
   npm run test-kyb
   ```
   Total cost of a cold deploy: ~1700 tokens.
4. **Update this file** with your tenant DID, contract ids, and map ACL.

No data migration is needed. `kyb-results` is an append-only audit log of
certificates; a fresh tenant starts empty and every certificate is
independently verifiable from its digest, so there is nothing to carry over.

## Changing the risk policy

The weights are a single `match` and a handful of `if`s in
`contract-kyb/src/kyb_screen.rs`. There is no rules engine and no config store
— deliberately, because a scoring policy that can change without a redeploy is
a scoring policy you cannot audit against the Merkle trail. Edit, bump the
version, redeploy, re-point the ACL.

## What is intentionally not here

- **No `secrets` map.** Both upstreams are keyless. Adding a paid data source
  later would mean creating one and seeding it via the control plane.
- **No `http-with-placeholders` import.** It exists to keep `{{profile.*}}` PII
  out of WASM memory; these are GETs against public registries with no personal
  data, so importing it would widen the capability surface for no benefit.
- **No web UI.** The deliverable is a contract plus scripts. A frontend would
  be another thing to host, patch and keep online — which is precisely the
  maintenance cost this submission is trying not to incur.
- **No sanctions screening.** It was the original design and was cut: the name
  lists (EU consolidated 6297 names, OFAC SDN 19296) do not fit in KV at ~508
  bytes per value (`BUGS.md` B1), and fetching 5 MB of CSV per call inside the
  enclave is not a defensible design. Identity verification is the honest scope
  for this contract; sanctions matching wants a different storage primitive.