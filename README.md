# T3N KYB Agent — confidential company verification inside a TEE

An enterprise agent for the [Terminal 3](https://docs.terminal3.io) ADK. It
answers one question a compliance team asks constantly — *is this company real,
and is its identity still in good standing?* — and answers it inside a
Trusted Execution Environment, so the counterparty identifiers being checked
never pass through the calling application.

Live on T3N testnet: `z:04306a8025385e404902f1c7e988abd849265eec:kyb`,
contract id **835**, version **0.2.0**.

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
← { vat_status, vat_name, lei_*, risk_score, risk_level, inconclusive[], digest }
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
   The recipe is below and it reproduces byte-for-byte.
3. **There is nothing to leak.** VIES and GLEIF are free and keyless, so this
   agent stores no credential at all. Compare the ADK's reference flight
   contract, which must hold a Duffel key in `z:<tid>:secrets`.

Point 3 is also the maintenance argument — see [Maintenance](#maintenance).

## The bug this version exists to prevent

VIES overloads one field. `isValid: false` means "this VAT number is not
registered" **only** when `userError == "INVALID"`. The same field is also false
when the member state's registry throttled or dropped the query —
`MS_MAX_CONCURRENT_REQ`, `MS_UNAVAILABLE`, `TIMEOUT`. Observed live: three
requests seconds apart returned `VALID`, `MS_MAX_CONCURRENT_REQ`, `VALID` for
the same number.

Read as a boolean, that turns a busy registry into *"this company's VAT number
is fake"* — for a compliance tool, the worst direction to be wrong in. So
`verify-vat` returns a three-state `status`, and `kyb-screen` collects every
source that failed to answer in `inconclusive[]`, which forces
`risk_level: "UNKNOWN"`. A caller must treat UNKNOWN as *re-run this*, never as
a pass and never as a fail.

This is not hypothetical. It fired during the deployment test run of this very
version — see [`kyb-screen`](#kyb-screen--combined-verdict-persisted-and-digested)
below, where the live output is a throttled Dutch registry reported honestly
instead of a false accusation against ALBERT HEIJN B.V.

## Trust model

- Both upstreams are called with `host:interfaces/http@2.1.0` from inside the
  contract. Egress is authorised per-caller by an `agent-auth` grant naming
  `ec.europa.eu` and `api.gleif.org`; without it the contract still runs but
  the call is refused with `host/http.egress_denied`.
- `http-with-placeholders` is deliberately **not** imported. It exists to keep
  `{{profile.*}}` PII out of WASM memory on the way out; these are GET requests
  against public registries carrying no personal data, so importing it would
  widen the contract's capability set for nothing.
- Certificates are written to `z:<tid>:kyb-results`, a private map. Its ACL is
  deliberately left permissive (`writers: "all"`, which restricts *contracts*,
  not the owner) rather than scoped to contract ids — see
  [Why the map ACL is permissive](#why-the-map-acl-is-permissive).
- Risk scoring is a pure function of the two upstream responses — no I/O, no
  clock, no randomness. Same inputs, same score, on any node.
- The certificate is bounded: every field that comes from an upstream is clipped
  so the serialized value provably fits the cluster's 508-byte KV ceiling
  (`BUGS.md` B1), asserted by a unit test rather than hoped for.

## API

Three exports on the `contracts` interface. Each takes the standard
`generic-input` envelope and returns JSON bytes. Every response below is
**verbatim live testnet output** from `npm run test-kyb` against contract 835.

### `verify-vat` — EU VIES VAT validation

```jsonc
// in
{ "country": "IE", "vat_number": "6388047V" }
// out
{ "status": "VALID", "valid": true, "inconclusive": false,
  "upstream_code": "VALID",
  "name": "GOOGLE IRELAND LIMITED",
  "address": "3RD FLOOR, GORDON HOUSE, BARROW STREET, DUBLIN 4",
  "request_date": "2026-09-01T08:39:52.944Z",
  "country": "IE", "vat_number": "6388047V" }
```

`status` is the field to branch on: `VALID` | `INVALID` | `UNKNOWN`. `valid` is
kept only as a convenience for `status == "VALID"`, and `upstream_code` carries
the raw VIES `userError` so an operator can see *why* an answer was inconclusive.

A genuinely unregistered number is a successful call, not an error:

```jsonc
// in  { "country": "DE", "vat_number": "999999999" }
// out { "status": "INVALID", "valid": false, "inconclusive": false,
//       "upstream_code": "INVALID", "name": "---", … }
```

Member states also differ in what they disclose: DE returns `status: "VALID"`
with `name: "---"`, while IE, NL, SE and LU return the registered name. That is
upstream behaviour, surfaced as-is.

### `verify-lei` — GLEIF Legal Entity Identifier lookup

```jsonc
// in
{ "lei": "5299004MG7BJU2QS6Q75" }
// out
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

GLEIF keeps these in two places and there is no `data.attributes.status`;
getting that wrong is silent, because the missing field deserializes to an
empty string. `HANDOVER.md` records the exact paths for whoever edits this next.

### `kyb-screen` — combined verdict, persisted and digested

```jsonc
// in
{ "company": "ALBERT HEIJN B.V.", "vat_country": "NL",
  "vat_number": "002230884B01", "lei": null }
// out
{ "vat_status": "UNKNOWN", "vat_name": "---",
  "lei_registration_status": "NOT_PROVIDED",
  "lei_entity_status": "NOT_PROVIDED", "lei_name": "",
  "risk_score": 0, "risk_level": "UNKNOWN",
  "inconclusive": ["vat:MS_MAX_CONCURRENT_REQ"],
  "timestamp": 1788251994, "contract_id": 835,
  "digest": "22329c9722f76af11fdbb188c7e38a540f0395ab2deb0e7d4fc743532616573a" }
```

**Read that output carefully — it is the whole argument for this version.** The
Dutch registry throttled the query. Version 0.1.1 would have returned
`vat_valid: false` and scored +40, reporting a real supermarket chain as a KYB
risk because a government API was busy. 0.2.0 reports `vat_status: "UNKNOWN"`,
names the upstream code, and refuses to issue a verdict at all
(`risk_level: "UNKNOWN"`, score suppressed). The correct operator response is to
re-run, and the output says so unambiguously.

Scoring is additive and deliberately boring — `LOW` (0), `MEDIUM` (1–40),
`HIGH` (>40), and `UNKNOWN` whenever `inconclusive[]` is non-empty:

| Signal | Weight |
|---|---|
| VAT number explicitly `INVALID` in VIES | +40 |
| A LEI was supplied but could not be resolved | +30 |
| LEI registration `LAPSED` or `RETIRED` | +20 |
| Entity status `INACTIVE` | +20 |
| VIES name and GLEIF legal name disagree (both present) | +10 |
| **Any source did not answer** | **band forced to `UNKNOWN`** |

The last row is the important one: an unanswered source is never scored as a
negative finding. Weights live in one `match` and a handful of `if`s in
`contract-kyb/src/kyb_screen.rs`. Changing policy means changing numbers there,
rebuilding, and redeploying — no scoring service, no rules engine, no config
store, because a policy that can change without a redeploy is a policy you
cannot audit against the Merkle trail.

### Verifying a certificate yourself

The digest is SHA-256 over the certificate with `digest` set to the empty
string, in declaration order. Anyone holding a returned certificate can
reproduce it — no access to the tenant required:

```bash
node -e '
const {createHash} = require("crypto");
const cert = JSON.parse(process.argv[1]);
const unsigned = JSON.stringify({ ...cert, digest: "" });
console.log(createHash("sha256").update(unsigned).digest("hex") === cert.digest
  ? "MATCH" : "MISMATCH");
' '{"vat_status":"UNKNOWN","vat_name":"---","lei_registration_status":"NOT_PROVIDED","lei_entity_status":"NOT_PROVIDED","lei_name":"","risk_score":0,"risk_level":"UNKNOWN","inconclusive":["vat:MS_MAX_CONCURRENT_REQ"],"timestamp":1788251994,"contract_id":835,"digest":"22329c9722f76af11fdbb188c7e38a540f0395ab2deb0e7d4fc743532616573a"}'
# MATCH
```

That same hash is what `set-claims-digest` committed to the transaction's Merkle
leaf, which is what makes the certificate auditable rather than merely stored.

## Running it

```bash
# offline, free, no network and no tokens — run this first
cd contract-kyb && cargo test          # 7 unit tests

cd ../agent && npm install
npm run state                          # what is actually deployed (0 tokens)

# one-time: register the contract, create its map, grant egress (~1550 tokens)
CONTRACT_VERSION=0.2.0 npm run register-kyb

npm run test-kyb   # the four calls whose output is quoted above (~250 tokens)
npm run health     # single JSON health line, exit 1 if degraded (~20 tokens)
```

`.env.local` at the repo root supplies `T3N_API_KEY` (and `DID`); it is
git-ignored and is the only file you need to create.

`npm run state` is the one to reach for first and the one to trust. It costs
nothing, and it is the only authoritative answer to *what is deployed right
now* — there is no API to read a tail's current `contract_id` (`BUGS.md` B2)
or a map's ACL (B5), so anything else is inference:

```jsonc
{ "tenant_did": "did:t3n:04306a8025385e404902f1c7e988abd849265eec",
  "contract_tail": "z:04306a8025385e404902f1c7e988abd849265eec:kyb",
  "live_script_version": "0.2.0",
  "results_map_status": "active",
  "balance_tokens": 15787.44 }
```

## Layout

| Path | What it is |
|---|---|
| `contract-kyb/wit/world.wit` | Exported interface, host imports, output shapes |
| `contract-kyb/src/lib.rs` | `wit_bindgen` entry point, `Guest` impl |
| `contract-kyb/src/verify_vat.rs` | VIES call, `classify()`, tri-state result |
| `contract-kyb/src/verify_lei.rs` | GLEIF call + response shaping |
| `contract-kyb/src/kyb_screen.rs` | Orchestration, scoring, size bound, KV write, digest |
| `agent/lib/session.ts` | Shared handshake → authenticate → `TenantClient` |
| `agent/state.ts` | Read-only deployment probe, 0 tokens |
| `agent/register-kyb.ts` | Register + map + egress grant (re-runnable) |
| `agent/test-kyb.ts` | End-to-end suite with per-call token accounting |
| `agent/health.ts` | Monitoring probe, exit 1 if degraded |
| `agent/fix-acl.ts` | Narrows a map ACL to given contract ids — read B2 and B8 first |
| `agent/verify-bugs.ts` | Re-runs all eight `BUGS.md` findings against the live tenant; exits 1 if a claim no longer holds |
| `agent/hunt.ts` | The exploratory probe suite that turned up B7 and B8 |
| `agent/*probe.ts` | The scripts that produced the `BUGS.md` repros, kept as evidence |
| `scripts/redeploy.sh` | Bump → test → build → validate → register → prove |
| `BUGS.md` | Eight findings, every one re-verified against the live tenant |
| `HANDOVER.md` | Runbook, whether I keep running it, how to take it over |

## Tests you can run without spending anything

`cargo test` covers the two pure decision functions and the size bound. No
network, no tokens, no tenant — which matters, because these are exactly the
places where a mistake is silent in production.

```
running 7 tests
test kyb_screen::tests::bands_follow_the_score ... ok
test kyb_screen::tests::clip_is_byte_bounded_and_never_splits_a_codepoint ... ok
test kyb_screen::tests::inconclusive_overrides_every_band ... ok
test kyb_screen::tests::worst_case_certificate_fits_kv_limit ... ok
test verify_vat::tests::only_explicit_invalid_is_a_negative ... ok
test verify_vat::tests::throttling_and_outages_are_unknown ... ok
test verify_vat::tests::valid_is_valid_regardless_of_code ... ok
```

`throttling_and_outages_are_unknown` is the regression guard for the VIES
overload described above. `worst_case_certificate_fits_kv_limit` builds a
certificate with every field at its *type* maximum and asserts it serializes
under 508 bytes, so adding a field cannot quietly reintroduce `BUGS.md` B1.

## Cost, measured

Every number is a `getBalance()` delta on live testnet during the v0.2.0
deployment, not an estimate.

| Operation | Tokens |
|---|---|
| `contracts.register` (229 206-byte WASM) | 1380.18 |
| `maps.create` | 40.07 when the map already exists (150 on first create) |
| `updateAgentAuth` | 130.31 |
| `verify-vat` (one outbound GET) | 20.04 |
| `verify-lei` (one outbound GET) | 20.10 |
| `kyb-screen` (GET + KV write + claims digest) | 190.17 |
| `getBalance`, `contracts.list`, `getContractVersion`, `getActivityLog` | 0 |
| Any rejected write | 0 |

Full deployment: **1550.56 tokens** (17 628.43 → 16 077.86). A verified cycle
including the four end-to-end calls: **~1801 tokens**.

Steady-state operation is ~20 tokens per single check and ~190 per full
screening. The expensive events are deployments, not queries — an hourly health
cron is ~480 tokens/day.

## Why the map ACL is permissive

`kyb-results` is created with `writers: "all"`, which the ADK docs define as
restricting *contracts*, not the owner. It would be tempting to scope it to the
owning contract id instead. Don't, for one measured reason:

Re-registering a contract allocates a **new** `contract_id` (`BUGS.md` B2,
confirmed again by this deployment: the tail went from v0.1.0 to v0.2.0 and came
back as id 835). A contract-scoped ACL names ids, so it breaks on every single
redeploy — and only `kyb-screen` writes, so a read-only smoke test will not
notice. There is also no API to read an ACL back afterwards (`BUGS.md` B5), so
you cannot check what the current one says.

Narrowing therefore buys a recurring manual step and no safety. `agent/fix-acl.ts`
still ships, because a tenant that *has* a scoped map needs it, and
`scripts/redeploy.sh` explains when the step applies. This deployment does not
need it, and step 5 of the redeploy proves that by writing a real certificate.

There is one more reason, found while probing for this: `maps.update` accepts a
contract id that no contract has (`BUGS.md` B8 — id `999999999` on a tenant with
exactly one contract, accepted and charged). So a narrow ACL can be wrong in a
way nothing reports, cannot be read back (B5), and only fails on the next
`kyb-screen` write. Permissive is the configuration with no silent failure mode.

## Maintenance

**I intend to keep running this**, and the reason is structural rather than
enthusiastic: there is very little here that can rot.

- **No credentials.** VIES and GLEIF need no key, so there is nothing to
  rotate, nothing to leak, and no `secrets` map in the deployment at all.
- **No mutable state on the hot path.** `verify-vat` and `verify-lei` are pure
  request/response. Only `kyb-screen` writes, and only append-only certificates.
- **The failure mode that matters is now impossible to miss.** An upstream that
  does not answer produces `risk_level: "UNKNOWN"` and a named upstream code,
  not a wrong verdict.
- **Two upstreams to watch.** Both are government/GLEIF-operated and versioned
  in their paths (`/vies/rest-api/…`, `/api/v1/…`). `npm run health` exercises
  the VIES path end-to-end through the enclave and exits non-zero on failure, so
  a cron entry is sufficient monitoring. A throttled upstream is reported as
  healthy-with-noise rather than as an outage, so the check does not cry wolf.
- **Redeploy is one command** — `scripts/redeploy.sh 0.2.1` — which tests
  offline before it spends anything, and proves the result end-to-end after.

Full runbook, failure modes and the handover path are in
[HANDOVER.md](HANDOVER.md).

## Environment this was built and verified on

| Field | Value |
|---|---|
| OS | Windows 11, git-bash (MSYS) |
| Node / npm | v24.0.0 / 11.8.0 |
| `@terminal3/t3n-sdk` | 4.46.0 (`^4.46.0` in `agent/package.json`) |
| Rust / target | 1.96.0 / `wasm32-wasip2` |
| `wasm-tools` | 1.258.0 |
| Environment | `setEnvironment("testnet")`, node `cn-api.sg.testnet.t3n.terminal3.io` |
| WASM artifact | `z_tenant_kyb.wasm`, 229 206 bytes, `wasm-tools validate` clean |

Host imports, read back out of the compiled component:
`host:tenant/tenant-context@1.0.0`, `host:interfaces/logging@2.1.0`,
`host:interfaces/kv-store@2.1.0`, `host:interfaces/http@2.1.0`.
Export: `z:tenant-kyb/contracts@0.2.0`.

## Verified testnet state

Captured from `npm run state` and `npm run health` after deploying 0.2.0:

- Tenant `did:t3n:04306a8025385e404902f1c7e988abd849265eec`
- Contract `z:04306a80…65eec:kyb` — id **835**, v0.2.0, `live_script_version`
  resolves to `0.2.0`
- Map `z:04306a80…65eec:kyb-results` — active, permissive writers
- Egress grant — `ec.europa.eu`, `api.gleif.org`, functions
  `verify-vat` / `verify-lei` / `kyb-screen`
- `cargo test` — 7/7 offline
- `npm run test-kyb` — 4/4, outputs quoted verbatim above
- `npm run health` — `healthy: true`, 3/3 checks
- Certificate digest `22329c97…573a` recomputed off-chain: **match**

Earlier ids under a previous tenant (`did:t3n:bdf0434d…21694`, contract ids 812
and 813) are where `BUGS.md` B1–B6 were originally reproduced. They are
history, not the current deployment; `BUGS.md` says which tenant each finding
came from.






