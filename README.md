# T3N KYB Agent — confidential company verification inside a TEE

An enterprise agent for the [Terminal 3](https://docs.terminal3.io) ADK. It
answers one question a compliance team asks constantly — *is this company real,
and is its identity still in good standing?* — and answers it inside a
Trusted Execution Environment, so the counterparty identifiers being checked
never pass through the calling application.

Live on T3N testnet: `z:bdf0434dfcd541ec2af899ad28599f6653421694:kyb`,
contract id **813**, version **0.1.1**.

```
caller → t3n.execute("kyb-screen", { company, vat_country, vat_number, lei? })
   ┌─ inside the enclave ────────────────────────────────────────────────┐
   │ http GET ec.europa.eu/…/vies/rest-api/ms/{CC}/vat/{NUM}             │
   │ http GET api.gleif.org/api/v1/lei-records/{LEI}        (if supplied)│
   │ risk()                     pure function, no I/O, no allocation     │
   │ sha256(certificate)                                                 │
   │ kv_store::put("z:<tid>:kyb-results", key, certificate)              │
   │ kv_store::set_claims_digest(hash)   → Merkle leaf of this tx        │
   └─────────────────────────────────────────────────────────────────────┘
← { company, vat_valid, vat_name, lei_*, risk_score, risk_level, digest, … }
```

The caller sends identifiers and receives a verdict. Raw VIES and GLEIF
responses — which carry registered addresses, legal forms, jurisdictions,
predecessor/successor entity links — exist only inside the enclave.

## Why a TEE is the right place for this

Verifying a counterparty is not a secret operation in itself. What matters is
*who learns what you asked*. A KYB lookup reveals your commercial pipeline: the
suppliers you are onboarding, the acquisition target you are diligencing, the
customer whose credit you are re-checking. Run through a normal backend, that
question and its full answer land in application memory, in request logs, in
an APM trace, and — increasingly — in the context window of whatever LLM the
agent is built on.

Three properties follow from doing it in a contract instead:

1. **The question and the raw answer stay inside the enclave.** The calling
   application supplies identifiers and gets back a verdict. It never holds
   the upstream registry payload.
2. **Every verdict is independently verifiable.** `set-claims-digest` commits
   the SHA-256 of the certificate into the transaction's Merkle leaf, so an
   auditor can later confirm that a given verdict was produced by this
   contract at that sequence number, without trusting the operator's database.
3. **There is nothing to leak.** VIES and GLEIF are free and keyless, so this
   agent stores no credential at all. Compare the ADK's reference flight
   contract, which must hold a Duffel key in `z:<tid>:secrets`.

Point 3 is also the maintenance argument — see below.

## Trust model

- Both upstreams are called with `host:interfaces/http@2.1.0` from inside the
  contract. Egress is authorised per-caller by an `agent-auth` grant naming
  `ec.europa.eu` and `api.gleif.org`; without it the contract still runs but
  the call is refused with `host/http.egress_denied`.
- `http-with-placeholders` is deliberately **not** imported. It exists to keep
  `{{profile.*}}` PII out of WASM memory on the way out; these are GET requests
  against public registries carrying no personal data, so importing it would
  widen the contract's capability set for nothing.
- Certificates are written to `z:<tid>:kyb-results`, ACL-restricted to the
  contract ids that own it.
- Risk scoring is a pure function of the two upstream responses — no I/O, no
  clock, no randomness. Same inputs, same score, on any node.

## API

Three exports on the `contracts` interface. Each takes the standard
`generic-input` envelope and returns JSON bytes.

### `verify-vat` — EU VIES VAT validation

```jsonc
// in
{ "country": "IE", "vat_number": "6388047V" }
// out (live testnet response)
{ "valid": true,
  "name": "GOOGLE IRELAND LIMITED",
  "address": "3RD FLOOR, GORDON HOUSE, BARROW STREET, DUBLIN 4",
  "request_date": "2026-08-31T12:28:39.593Z",
  "country": "IE", "vat_number": "6388047V" }
```

An invalid number is a successful call with `valid: false` — not an error.
Note that VIES member states differ in what they disclose: DE returns
`valid: true` with `name: "---"`, while IE, NL, SE and LU return the
registered name. That is upstream behaviour, surfaced as-is.

### `verify-lei` — GLEIF Legal Entity Identifier lookup

```jsonc
// in
{ "lei": "5299004MG7BJU2QS6Q75" }
// out (live testnet response)
{ "lei": "5299004MG7BJU2QS6Q75",
  "legal_name": "Siemens Energy AG",
  "registration_status": "ISSUED",     // ISSUED | LAPSED | RETIRED | …
  "entity_status": "ACTIVE",           // ACTIVE | INACTIVE
  "hq_country": "CH", "jurisdiction": "CH",
  "initial_registration_date": "2020-01-13T08:25:38Z" }
```

The two statuses answer different questions and both matter: `entity_status`
is whether the company still exists, `registration_status` is whether anyone
is still maintaining its LEI record. A `LAPSED` LEI on an `ACTIVE` entity is
a normal, mild red flag — nobody renewed it.

### `kyb-screen` — combined verdict, persisted and digested

```jsonc
// in
{ "company": "ALBERT HEIJN B.V.", "vat_country": "NL",
  "vat_number": "002230884B01", "lei": null }
// out (live testnet response)
{ "company": "ALBERT HEIJN B.V.",
  "vat_valid": true, "vat_name": "ALBERT HEIJN B.V.",
  "lei_valid": false, "lei_name": "",
  "lei_registration_status": "NOT_PROVIDED",
  "lei_entity_status": "NOT_PROVIDED",
  "risk_score": 0, "risk_level": "LOW",
  "timestamp": 1788179320, "contract_id": 813,
  "digest": "b70ee890e8a0c0c37add38dfb6790150a50c087127b04e69766b0e1ad7dece14" }
```

Scoring is additive and deliberately boring — `LOW` (0), `MEDIUM` (1–40),
`HIGH` (>40):

| Signal | Weight |
|---|---|
| VAT number not valid in VIES | +40 |
| A LEI was supplied but could not be resolved | +30 |
| LEI registration `LAPSED` or `RETIRED` | +20 |
| Entity status `INACTIVE` | +20 |
| VIES name and GLEIF legal name disagree (both present) | +10 |

Weights live in one `match` in `contract-kyb/src/kyb_screen.rs`. Changing
policy means changing numbers there, rebuilding, and redeploying — no
scoring service, no rules engine, no config store.

## Running it

```bash
cd agent && npm install

# one-time: register the contract, create its map, grant egress
CONTRACT_VERSION=0.1.1 npm run register-kyb

npm run test-kyb   # the four calls whose output is quoted above
npm run health     # single JSON health line, exit 1 if degraded
```

`.env.local` at the repo root supplies `T3N_API_KEY` (and `DID`); it is
git-ignored.

## Layout

| Path | What it is |
|---|---|
| `contract-kyb/wit/world.wit` | Exported interface + the four host imports |
| `contract-kyb/src/lib.rs` | `wit_bindgen` entry point, `Guest` impl |
| `contract-kyb/src/verify_vat.rs` | VIES call + response shaping |
| `contract-kyb/src/verify_lei.rs` | GLEIF call + response shaping |
| `contract-kyb/src/kyb_screen.rs` | Orchestration, scoring, KV write, digest |
| `agent/lib/session.ts` | Shared handshake → authenticate → `TenantClient` |
| `agent/register-kyb.ts` | Register + map + egress grant (re-runnable) |
| `agent/test-kyb.ts` | End-to-end suite with per-call token accounting |
| `agent/health.ts` | Monitoring probe |
| `agent/fix-acl.ts` | Re-points map ACLs after a redeploy (see BUGS.md B3) |
| `scripts/redeploy.sh` | Version bump → build → validate → register → health |
| `BUGS.md` | Seven findings from this build, with repros |
| `HANDOVER.md` | Runbook, whether I keep running it, how to take it over |

## Cost, measured

Every number below is a `getBalance()` delta on live testnet, not an estimate.

| Operation | Tokens |
|---|---|
| `contracts.register` (222 KB WASM) | 1380 |
| `maps.create` | 150 (40 when the map already exists) |
| `updateAgentAuth` | 130 |
| `verify-vat` / `verify-lei` (one outbound GET) | 20 |
| `kyb-screen` (two GETs + KV write + claims digest) | 170 |
| `getActivityLog` | 0 |
| Any rejected write | 0 |

So steady-state operation is ~20 tokens per single check and ~170 per full
screening. The expensive events are deployments, not queries.

## Maintenance

**I intend to keep running this**, and the reason is structural rather than
enthusiastic: there is very little here that can rot.

- **No credentials.** VIES and GLEIF need no key, so there is nothing to
  rotate, nothing to leak, and no `secrets` map in the deployment at all.
- **No mutable state on the hot path.** `verify-vat` and `verify-lei` are pure
  request/response. Only `kyb-screen` writes, and only append-only certificates.
- **Two upstream contracts to watch.** Both are government/GLEIF-operated and
  versioned in their paths (`/vies/rest-api/…`, `/api/v1/…`). `npm run health`
  exercises the VIES path end-to-end through the enclave and exits non-zero on
  failure, so a cron entry is sufficient monitoring.
- **Redeploy is one command** (`scripts/redeploy.sh 0.1.2`) with one manual
  follow-up documented in `HANDOVER.md`: re-point the map ACL at the new
  `contract_id`, because re-registration allocates a new one (BUGS.md B3).

Full runbook, failure modes and the handover path are in
[HANDOVER.md](HANDOVER.md).

## Environment this was built and verified on

| Field | Value |
|---|---|
| OS | Windows 11, git-bash (MSYS) |
| Node / npm | v24.0.0 / 11.8.0 |
| `@terminal3/t3n-sdk` | 4.46.0 |
| Rust / target | 1.96.0 / `wasm32-wasip2` |
| `wasm-tools` | 1.258.0 |
| Environment | `setEnvironment("testnet")`, node `cn-api.sg.testnet.t3n.terminal3.io` |
| WASM artifact | `z_tenant_kyb.wasm`, 222 235 bytes, `wasm-tools validate` clean |

Host imports, read back out of the compiled component:
`host:tenant/tenant-context@1.0.0`, `host:interfaces/logging@2.1.0`,
`host:interfaces/kv-store@2.1.0`, `host:interfaces/http@2.1.0`.
Export: `z:tenant-kyb/contracts@0.1.1`.

## Verified testnet state

- Contract `z:bdf0434d…21694:kyb` — id **813**, v0.1.1 (id 812 was v0.1.0)
- Map `z:bdf0434d…21694:kyb-results` — active, ACL `{ only: [812, 813] }`
- Egress grant — `ec.europa.eu`, `api.gleif.org`, functions
  `verify-vat` / `verify-lei` / `kyb-screen`
- `npm run test-kyb` — 4/4 passing, outputs quoted verbatim above