# Terminal 3 ADK Bounty — Confidential KYB Verification Agent

**Author:** Ikhsan Ramadhan
**Date:** 31 August 2026
**Repo:** https://github.com/ikhsanRamadhan/terminal3-kyb-agent
**Tenant DID:** `did:t3n:bdf0434dfcd541ec2af899ad28599f6653421694`
**Contract:** `z:bdf0434dfcd541ec2af899ad28599f6653421694:kyb` — id **813**, v0.1.1

---

## 0. Summary

Built, deployed and verified an enterprise agent that answers the question a
compliance team asks constantly — *is this company real, and is its identity
still in good standing?* — inside a TEE, so the counterparty identifiers being
checked never pass through the calling application.

- Quickstart — complete
- Set Up Dev Environment — complete
- Walkthrough 1–5 (write / build / register / invoke / test) — complete
- Enterprise agent live on testnet, `npm run test-kyb` 4/4 passing
- 7 issues filed with measured repros (4 major, 3 minor)
- Health check passing; redeploy script + handover runbook included
- **I intend to keep running it** (see §6)

**Headline finding:** a KV value-size ceiling of 508 bytes is reported as
`access denied: StorageRouterOnBehalfOf(...) cannot write map`. A permission
decision cannot depend on payload length, so the message sends developers to
their ACL — which is correct and unchanged — instead of to their payload. This
killed the original design of this agent and cost about an hour before a size
bisection revealed the truth. Details in §5, B1.

---

## 1. Environment

| Field | Value |
|---|---|
| OS | Windows 11, git-bash (MSYS) |
| Node / npm | v24.0.0 / 11.8.0 |
| `@terminal3/t3n-sdk` | **4.46.0** (npm latest at build time) |
| Rust / target | 1.96.0 / `wasm32-wasip2` |
| `wasm-tools` | 1.258.0 |
| Environment | `setEnvironment("testnet")` → `cn-api.sg.testnet.t3n.terminal3.io` |
| WASM artifact | `z_tenant_kyb.wasm`, 222 235 bytes, `wasm-tools validate` clean |

Worth recording: the whole ADK path — Rust → WASM component → registration →
enclave HTTP egress — works on Windows through git-bash. The docs assume a
POSIX shell and every published example is macOS/Linux, but nothing in the
toolchain actually required WSL or a VM.

---

## 2. Quickstart

Completed on 4.46.0 with two deliberate deviations from the published example,
both carried over from the previous challenge's findings and both still
necessary:

1. **`setEnvironment("testnet")` rather than an explicit `baseUrl`.** Passing
   `baseUrl: "https://testnet.terminal3.io"` makes the SDK probe `/status` on
   that host, which 404s and aborts the handshake.
2. **`trustAnchor` must be passed.** The docs example omits it, but the field
   is non-optional in `T3nClientConfig` and validated eagerly, so the example
   as published cannot construct a client. Used
   `fetchTrustedManifest("testnet")` with an explicit fallback to
   `{ unsafe_trust_server: true }` and a loud warning when the fallback fires.

Result: handshake, authentication, DID returned by the server, balance read.
The trust manifest verified cleanly on every run in this session — no fallback
was needed.

One note for the docs: the DID shown on the claim page is **not** the DID this
API key authenticates as. The quickstart script warns when they differ. The
authenticated DID is the one every later call needs.

---

## 3. The agent

### 3.1 Use case

KYB — Know Your Business — is the counterparty-side counterpart of KYC. Before
onboarding a supplier, diligencing an acquisition or re-checking a customer's
credit, someone verifies that the legal entity exists and its identity records
are current. The two authoritative, free, keyless sources for European
entities are:

- **EU VIES** — is this VAT number valid, and what name is registered to it?
- **GLEIF** — does this Legal Entity Identifier resolve, is the entity still
  ACTIVE, and is the LEI record still being maintained?

The agent exposes both individually and a combined screening that scores them.

### 3.2 Why this belongs in a TEE

Verifying a counterparty is not secret in itself. What matters is *who learns
what you asked*. A KYB lookup reveals commercial pipeline: the suppliers you
are onboarding, the target you are diligencing, the customer you are worried
about. Run through an ordinary backend, that question and its full answer land
in application memory, request logs, an APM trace, and — increasingly — the
context window of whatever LLM the agent is built on.

Three properties follow from doing it in a contract:

1. **The question and the raw answer stay in the enclave.** The caller sends
   identifiers and receives a verdict. The full VIES and GLEIF payloads —
   registered addresses, legal forms, jurisdictions, successor-entity links —
   never cross the WIT boundary.
2. **Every verdict is independently verifiable.** `set-claims-digest` commits
   the SHA-256 of the certificate into the transaction's Merkle leaf, so an
   auditor can confirm a verdict was produced by this contract at that
   sequence number without trusting the operator's database.
3. **There is nothing to leak.** Both upstreams are keyless, so the deployment
   holds no credential and has no `secrets` map at all — unlike the reference
   flight contract, which must hold a Duffel key.

Point 3 is also the maintenance argument, which is what this bounty asked for.

### 3.3 Contract

`wit/world.wit` imports exactly four host interfaces and no more:

```wit
package z:tenant-kyb@0.1.1;

world tenant-kyb {
    import host:tenant/tenant-context@1.0.0;
    import host:interfaces/logging@2.1.0;
    import host:interfaces/kv-store@2.1.0;
    import host:interfaces/http@2.1.0;
    export contracts;
}
```

`http-with-placeholders` is deliberately **not** imported. It exists to keep
`{{profile.*}}` PII out of WASM memory; these are GETs against public
registries carrying no personal data, so importing it would widen the
capability surface for nothing. Choosing *not* to take a capability seemed
worth stating explicitly, given the docs are clear that imports are the
capability set.

Three exports, each taking the standard `generic-input` envelope:

| Function | Does |
|---|---|
| `verify-vat` | VIES call, shaped response |
| `verify-lei` | GLEIF call, shaped response |
| `kyb-screen` | Both, plus risk score, KV persist, claims digest |

### 3.4 Live results (verbatim from `npm run test-kyb`)

```
script_version resolved: 0.1.1

=== Test 1: verify-vat (Google Ireland, IE/6388047V) ===
  {"valid":true,"name":"GOOGLE IRELAND LIMITED",
   "address":"3RD FLOOR, GORDON HOUSE, BARROW STREET, DUBLIN 4",
   "request_date":"2026-08-31T12:28:39.593Z","country":"IE",
   "vat_number":"6388047V"}
  [tokens] 20.04

=== Test 2: verify-lei (Siemens Energy, 5299004MG7BJU2QS6Q75) ===
  {"lei":"5299004MG7BJU2QS6Q75","legal_name":"Siemens Energy AG",
   "registration_status":"ISSUED","entity_status":"ACTIVE",
   "hq_country":"CH","jurisdiction":"CH",
   "initial_registration_date":"2020-01-13T08:25:38Z"}
  [tokens] 20.10

=== Test 3: kyb-screen (Albert Heijn, NL/002230884B01) ===
  {"company":"ALBERT HEIJN B.V.","vat_valid":true,
   "vat_name":"ALBERT HEIJN B.V.","lei_valid":false,"lei_name":"",
   "lei_registration_status":"NOT_PROVIDED",
   "lei_entity_status":"NOT_PROVIDED",
   "risk_score":0,"risk_level":"LOW","timestamp":1788179320,
   "contract_id":813,
   "digest":"b70ee890e8a0c0c37add38dfb6790150a50c087127b04e69766b0e1ad7dece14"}
  [tokens] 170.15

=== Test 4: verify-vat (invalid, DE/999999999) ===
  {"valid":false,"name":"---","address":"---",
   "request_date":"2026-08-31T12:28:44.246Z","country":"DE",
   "vat_number":"999999999"}
  [tokens] 20.03
```

*[SCREENSHOT: test-kyb 4/4 output]*
*[SCREENSHOT: register-kyb — contract_id 813, wasm 222235 bytes]*
*[SCREENSHOT: wasm-tools component wit — imports and export]*
*[SCREENSHOT: npm run health — healthy:true]*

Two observations from real data rather than fixtures:

- VIES member states differ in disclosure. IE, NL, SE and LU return the
  registered name; DE returns `valid: true` with `name: "---"`. A KYB tool
  that treats a missing name as a failure would flag every German company.
  Surfaced as-is, scored as valid.
- GLEIF carries two distinct statuses and both matter. `entity_status`
  (ACTIVE/INACTIVE) is whether the company still exists;
  `registration_status` (ISSUED/LAPSED/RETIRED) is whether anyone still
  maintains its LEI record. A LAPSED LEI on an ACTIVE entity is a mild, real
  red flag — nobody renewed it. Collapsing them into one field would lose that.

### 3.5 Risk scoring

Additive, deterministic, no I/O — `LOW` (0), `MEDIUM` (1–40), `HIGH` (>40):

| Signal | Weight |
|---|---|
| VAT number not valid in VIES | +40 |
| A LEI was supplied but could not be resolved | +30 |
| LEI registration LAPSED or RETIRED | +20 |
| Entity status INACTIVE | +20 |
| VIES name and GLEIF legal name disagree (both present) | +10 |

The weights are one `match` and a few `if`s in `kyb_screen.rs`. There is no
rules engine and no config store, deliberately: a policy that can change
without a redeploy is a policy you cannot audit against the Merkle trail.

### 3.6 Measured cost

Every figure is a `getBalance()` delta on live testnet, not an estimate.

| Operation | Tokens |
|---|---|
| `contracts.register` (222 KB WASM) | 1380 |
| `maps.create` | 150 (40 when the map exists) |
| `updateAgentAuth` | 130 |
| `verify-vat` / `verify-lei` (one outbound GET) | 20 |
| `kyb-screen` (two GETs + KV write + digest) | 170 |
| `getActivityLog` | 0 |
| Any rejected write | 0 |

Steady state is ~20 tokens per lookup, ~170 per full screening. The expensive
events are deployments, not queries. Token costs are documented nowhere in the
ADK docs; this table is the answer to a question every developer will have
before writing code.

---

## 4. What was cut, and why

The original design was sanctions screening — match a company against the EU
consolidated list and OFAC SDN. Both datasets were downloaded and analysed:
EU 8820 rows / 6297 distinct names / 148 KB, OFAC SDN 19 296 names / 518 KB.

It was cut after B1 (below) established that a KV value cannot exceed 508
bytes. Staging a name list in KV would need ~1300 entries and ~91 000 tokens
in write costs; fetching 5 MB of CSV per call inside the enclave instead is
not a defensible design at 20 tokens of budget per lookup.

Recording this because the reasoning is the useful part: identity verification
is the honest scope for a KV-backed contract at current limits. Sanctions
matching wants a storage primitive the platform does not have yet — a
tenant-scoped blob or a bulk-loaded index. That is a concrete platform gap,
and it is worth more to Terminal 3 stated plainly than hidden behind a demo
that pretended to screen against three names.

---

## 5. Issues filed

Full repros in [BUGS.md](https://github.com/ikhsanRamadhan/terminal3-kyb-agent/blob/master/BUGS.md).

| ID | Severity | Finding |
|---|---|---|
| B1 | **Major** | KV value-size ceiling (508 B) reported as `access denied` |
| B2 | **Major** | `maps.update` cannot widen an ACL it narrowed — one-way, unrecoverable |
| B3 | **Major** | Re-registering a contract silently orphans its map ACLs |
| B4 | **Major** | `getScriptVersion` removed in 4.46.0 with no alias or changelog entry |
| B5 | Minor | `maps.create` warns about `readers`, then fails on `writers` |
| B6 | Minor | `tenant.maps.list()` absent; `contracts.listDetailed()` returns a non-array |
| B7 | Minor | Unhandled SDK rejection prints the entire ~2 MB minified bundle |

### B1 — the value-size ceiling

Same map, same session, same caller, same ACL. Only the length changes:

```typescript
await tenant.maps.entrySet("secrets", "_a", "x".repeat(508)); // OK
await tenant.maps.entrySet("secrets", "_c", "x".repeat(512)); // access denied
```

Bisected: 508 accepted, 512 rejected. A 200-byte key with a 200-byte value
passes and a 250-byte key with a 1-byte value passes, so the limit is on the
**value only**. Rejected writes cost 0 tokens, which is what made bisection
affordable.

*Fix:* return `value_too_large: 512 bytes max` and state the limit on the
create-kv-maps page.

### B2 — one-way ACL narrowing

Create a map with `readers/writers: "all"` → writes work. Narrow it to
`{ only: [id] }` → writes denied, as expected. Widen it back to `"all"` →
**still denied.** The widening call reports success and costs 70 tokens.

This interacts with documented behaviour: create-kv-maps states the owner can
always write through the control plane even on a `writers: { only: [id] }`
map, and that holds for a map *created* that way (verified against the
previous challenge's `secrets` map). It does not hold for a map created
permissive and then narrowed. Two paths to the same declared ACL, two
different behaviours.

*Impact:* no recovery except a new map under a new tail. On a `secrets` map
holding a live key that means re-seeding and re-pointing every reader.

### B3 — redeploy orphans map ACLs

Register v0.1.0 → id 812. Create `kyb-results` with `writers: { only: [812] }`.
`kyb-screen` writes fine. Fix a bug, register v0.1.1 → **id 813** (new id, as
documented). Same tail, same code, version the node itself resolves:

```
access denied: TenantContract(did:t3n:…/813) cannot write map "z:…:kyb-results"
```

Worse than it looks: there is no API to read a tail's current `contract_id`.
`contracts.list()` returns names only and `contracts.listDetailed()` throws
(`detailed.find is not a function`, B6). After a redeploy the developer cannot
*discover* the id the ACL now needs — they must have recorded what `register`
printed, forever, for every version.

Recovery needed a purpose-written tool that takes the ids on the command line
and re-points the ACL at both generations — `agent/fix-acl.ts` in the repo,
which exists only because of this bug:

```
CONTRACT_IDS=812,813 npm run fix-acl
```

And note the failure is easy to miss: `verify-vat`/`verify-lei` keep working
because they never write, so a read-only smoke test passes. The previous
challenge's report flagged the missing contract_id endpoint as a platform gap;
this is that gap turning into an outage.

*Fix:* expose the current `contract_id` for a tail, or let map ACLs name tails
so they follow re-registration.

### B4 — silent breaking rename

Code that ran on 4.35.1 during the previous challenge:

```
SyntaxError: The requested module '@terminal3/t3n-sdk' does not provide
an export named 'getScriptVersion'
```

`getContractVersion` is the replacement, same signature, no alias. 4.46.0 has
131 exports; the old name is simply gone. The docs are self-consistent — the
invoke-contract page already uses the new name — and the changelog is honest
that it carries no SDK history. But a rename that breaks imports is precisely
the change that has to be written down somewhere.

---

## 6. Maintenance and post-challenge operation

**I intend to keep running this agent**, and would be interested in the
startup program / listing page. The reason is structural rather than
enthusiastic — there is very little here that can rot:

- **No credentials.** Both upstreams are keyless. Nothing to rotate, nothing
  to leak, no `secrets` map in the deployment.
- **No mutable state on the read path.** `verify-vat` and `verify-lei` are
  pure request/response. Only `kyb-screen` writes, append-only.
- **Two upstreams to watch**, both government/GLEIF-operated with versioned
  paths. `npm run health` exercises VIES end-to-end through the enclave and
  exits non-zero on failure — a cron entry is sufficient monitoring, at 20
  tokens per run.
- **Redeploy is one command** (`scripts/redeploy.sh 0.1.2`), with one manual
  follow-up the script prints and cannot do itself: re-point the map ACL at
  the new contract id (B3).

**If Terminal 3 would rather maintain it, the handover is clean.** The entire
agent is the repository plus a token balance — no external service, no
database, no dashboard, no DNS, no CI secret. A cold deploy on a fresh tenant
is four commands and ~1700 tokens; nothing hardcodes my tenant, since the DID
comes back from the authenticated session and map paths are built at runtime
from `tenant_context::tenant_did()`. `kyb-results` is an append-only audit log,
so there is no data to migrate — and every certificate is verifiable from its
digest anyway.

[HANDOVER.md](https://github.com/ikhsanRamadhan/terminal3-kyb-agent/blob/master/HANDOVER.md)
has the full runbook: prerequisites, monitoring, redeploy procedure, a
failure-mode table mapping each error string to its cause and fix, upstream
risk register, and the cold-deploy path.

---

## 7. Repository

| Path | What |
|---|---|
| `contract-kyb/wit/world.wit` | Exported interface + four host imports |
| `contract-kyb/src/lib.rs` | `wit_bindgen` entry, `Guest` impl |
| `contract-kyb/src/verify_vat.rs` | VIES |
| `contract-kyb/src/verify_lei.rs` | GLEIF |
| `contract-kyb/src/kyb_screen.rs` | Orchestration, scoring, KV, digest |
| `agent/lib/session.ts` | Handshake → authenticate → `TenantClient` |
| `agent/register-kyb.ts` | Register + map + egress grant (re-runnable) |
| `agent/test-kyb.ts` | End-to-end suite with token accounting |
| `agent/health.ts` | Monitoring probe |
| `agent/fix-acl.ts` | ACL repair after redeploy (B3) |
| `agent/a*probe.ts` | The probes that produced B1/B2 — kept as evidence |
| `scripts/redeploy.sh` | Bump → build → validate → register → health |
| `README.md` | Architecture, trust model, API, measured costs |
| `BUGS.md` | Seven findings with repros |
| `HANDOVER.md` | Runbook and handover |

---

## Pre-submit checklist

- [x] API key appears nowhere in the repo, this doc, or any screenshot
- [x] `.env.local` git-ignored; history clean of any key
- [x] Repo public — verify in a private window
- [x] Doc set to anyone-with-link-can-view — verify in a private window
- [x] Doc links to repo; README links back to doc
- [ ] Screenshots attached and matched to their sections
- [ ] B1 and B3 reported in the developer Telegram — both are the kind of
      thing worth telling them before judging
- [ ] Shared on X tagging @terminal3io