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

Captured from `npm run state` (costs 0 tokens) on 2026-09-01 after deploying
v0.2.0. **If this table and `npm run state` ever disagree, `state` is right** —
regenerate the table from it.

| Thing | Value |
|---|---|
| Tenant DID | `did:t3n:04306a8025385e404902f1c7e988abd849265eec` |
| Node | `https://cn-api.sg.testnet.t3n.terminal3.io` (`setEnvironment("testnet")`) |
| Contract | `z:04306a8025385e404902f1c7e988abd849265eec:kyb` |
| Contract id | **835** (v0.2.0, live — `live_script_version` resolves `0.2.0`) |
| Map | `z:04306a8025385e404902f1c7e988abd849265eec:kyb-results`, active, `writers: "all"` |
| Egress grant | `ec.europa.eu`, `api.gleif.org` for `verify-vat`, `verify-lei`, `kyb-screen` |
| WASM | `z_tenant_kyb.wasm`, 229 206 bytes |
| Balance after deploy | 15 787.44 tokens |

Historical, on a **different** tenant (`did:t3n:bdf0434d…21694`): contract ids
812 (v0.1.0) and 813 (v0.1.1), with `kyb-results` scoped to `{ only: [812, 813] }`.
That tenant is where `BUGS.md` B2 and B3 were reproduced. It is not the current
deployment and the current API key does not authenticate as it — mentioned only
so the ids in `BUGS.md` are traceable.

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
cd ../contract-kyb && cargo test    # 7/7, offline, free — do this before anything
```

## Daily operation

Nothing to do. The contract is invoked on demand and holds no background
process. Steady-state cost is ~20 tokens per single lookup, ~190 per full
`kyb-screen`.

### First command, every time

```bash
cd agent && npm run state
```

Zero tokens, read-only, and the only authoritative answer to *what is actually
deployed*. There is no API to read a tail's current `contract_id` (`BUGS.md` B3)
or a map's ACL (B6), so every other answer is inference from a document that may
be stale — including this one.

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
  "timestamp": "2026-09-01T08:46:44.193Z",
  "checks": [
    { "name": "contract_registered",   "ok": true, "detail": "z:04306a80…65eec:kyb" },
    { "name": "verify_vat_responsive", "ok": true, "detail": "v0.2.0 status=VALID" },
    { "name": "balance_sufficient",    "ok": true, "detail": "15647.12 tokens" }
  ] }
```

A throttled VIES member state is reported as healthy, with the upstream code in
the detail (`status=UNKNOWN (upstream MS_MAX_CONCURRENT_REQ) — upstream hiccup,
agent OK`). That is deliberate: the agent is working correctly when it reports
that it got no answer, and a monitor that pages on upstream noise gets muted.

Cron it as often as you like — the VAT check costs 20 tokens, the other two
checks are free. Hourly is ~480 tokens/day; daily is negligible.

### Topping up tokens

The balance only moves on deployments and calls. When
`balance_sufficient` goes false, claim more test tokens from
<https://go.terminal3.io/adk-community> against the same DID. A redeploy
needs ~1550 tokens of headroom (measured: 1550.56 = register 1380.18 +
map no-op 40.07 + grant 130.31), plus ~250 to prove it end to end.

## Redeploying after a code change

```bash
./scripts/redeploy.sh 0.2.1
```

Five steps: bump the version in `Cargo.toml` + `wit/world.wit`, run `cargo test`
(free, offline — it fails the deploy before you spend anything), build, validate
the component, register + re-assert the egress grant, then `state.ts` and
`test-kyb.ts` to prove the result end to end.

The end-to-end step is not optional politeness. Only `kyb-screen` writes to KV,
so `verify-vat` and `verify-lei` keep working even when the write path is broken
— a read-only smoke test cannot detect the failure below.

### The map ACL: when to touch it, and when touching it makes things worse

Re-registering allocates a **new** `contract_id`. This is documented platform
behaviour, not a bug. What follows from it depends on how `kyb-results` was
created:

**Permissive map (`writers: "all"`) — the current deployment.** Nothing to do.
Step 5 of the redeploy already wrote a certificate with the new id. **Do not run
`fix-acl`.** It narrows the ACL, and narrowing is a one-way door (`BUGS.md` B2):
`maps.update` can restrict an ACL but cannot widen it again — it returns success,
charges ~70 tokens, and the map stays unwritable, with no recovery except a new
map under a new tail. Narrowing would convert a working deployment into one that
needs a manual, irreversible step on every future redeploy.

**Contract-scoped map (`writers: { only: [...] }`).** Then `kyb-screen` in step 5
will have failed with a message that reads like a permissions mistake:

```
access denied: TenantContract(did:t3n:<tid>/<new id>) cannot write map
  "z:<tid>:kyb-results"
```

Only in that case:

```bash
cd agent && CONTRACT_IDS=<every historical id>,<new id> npm run fix-acl
npm run test-kyb        # must be 4/4, including kyb-screen
```

Keep every historical id in the list until you are certain nothing references
the old versions.

Either way: **record the new `contract_id` in the table at the top of this
file.** There is no API to read a tail's current `contract_id` (`BUGS.md` B3) or
a map's current ACL (B6), so this document and `npm run state` are the only
record — and `state` cannot see the ACL.

Background and repro: `BUGS.md` B2 and B3.

## Failure modes and what they mean

| Symptom | Cause | Fix |
|---|---|---|
| `access denied: TenantContract(…/<id>) cannot write map` | Map ACL predates the current contract id | `CONTRACT_IDS=… npm run fix-acl` |
| `host/http.egress_denied` | Egress grant missing or scoped to an older version | Re-run `npm run register-kyb` (idempotent) |
| `verify-vat` returns `status: "UNKNOWN"` for a known-good number | Upstream VIES member-state throttle or outage — VIES is per-country and individual states go offline | Retry later; not an agent fault. v0.2.0 reports this honestly instead of as `valid: false` |
| VIES returns `valid: true` with `name: "---"` | Normal: some member states (DE) do not disclose the name | Nothing to fix |
| `NotFound` from `verify-lei` | LEI genuinely absent from GLEIF | Nothing to fix |
| `access denied … StorageRouterOnBehalfOf` on a write you expect to work | KV value exceeded ~508 bytes | Shrink the value; `BUGS.md` B1 |
| ~1.25 MB of minified JS on stderr | Unhandled SDK rejection, no source maps | Filter with `awk 'length($0)<400'`; `BUGS.md` B7 |
| `does not provide an export named 'getScriptVersion'` | SDK ≥4.46 renamed it | Use `getContractVersion`; `BUGS.md` B4 |

## Upstream dependencies

| Dependency | Risk | Mitigation |
|---|---|---|
| EU VIES REST API | Per-member-state availability varies; no SLA | Three-state classification (VALID/INVALID/UNKNOWN) in `verify_vat.rs`; an unanswered source goes into `inconclusive[]` and forces `risk_level: UNKNOWN` — never scored as a negative |
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
   cd contract-kyb && cargo test && cargo build --target wasm32-wasip2 --release
   cd ../agent && npm install
   CONTRACT_VERSION=0.2.0 npm run register-kyb
   npm run test-kyb          # kyb-screen must write — proves the map works
   ```
   Total cost of a cold deploy: ~1800 tokens. No `fix-acl` needed on a fresh
   map created with `writers: "all"` (see the redeploy section above).
4. **Update this file** with your tenant DID, contract ids, and map ACL.

No data migration is needed. `kyb-results` is an append-only audit log of
certificates; a fresh tenant starts empty and every certificate is
independently verifiable from its digest, so there is nothing to carry over.

## Changing the risk policy

The weights are a single `match` and a handful of `if`s in
`contract-kyb/src/kyb_screen.rs`. There is no rules engine and no config store
— deliberately, because a scoring policy that can change without a redeploy is
a scoring policy you cannot audit against the Merkle trail. Edit, bump the
version, redeploy.

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