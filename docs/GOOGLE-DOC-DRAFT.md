# Terminal 3 ADK Bounty #2 — Confidential KYB Verification Agent

**Author:** Ikhsan Ramadhan
**Date:** 1 September 2026
**Time zone:** UTC+7
**Repo:** https://github.com/ikhsanRamadhan/terminal3-kyb-agent
**Tenant DID:** `did:t3n:04306a8025385e404902f1c7e988abd849265eec`
**Contract:** `z:04306a8025385e404902f1c7e988abd849265eec:kyb` — id **835**, v**0.2.0**

---

## 0. Summary

Built, deployed and verified an enterprise agent that answers the question a
compliance team asks constantly — *is this company real, and is its identity
still in good standing?* — inside a TEE, so the counterparty identifiers being
checked never pass through the calling application.

- Quickstart — complete
- Set Up Dev Environment — complete
- Walkthrough steps 1–5 — complete, including step 5 (test) end to end
- Enterprise agent live on testnet at v0.2.0; `npm run test-kyb` 4/4 passing
- Issues filed: **8** (5 major, 3 minor), **every one re-verified against the
  live tenant** by a suite that ships in the repo — see §8
- Offline test suite: `cargo test` 7 unit tests + 1 doc-test, 0 tokens
- Certificate digest independently recomputed off-chain: **match**
- **I intend to keep running it**, and the handover process is written up
  anyway — see §10

**Headline platform finding.** A KV value-size ceiling of 508 bytes is reported
as `access denied: StorageRouterOnBehalfOf(...) cannot write map`. A permission
decision cannot depend on payload length, so the message sends developers to
their ACL — which is correct and unchanged — instead of to their payload. The
same `entrySet` call rejects an oversized *key* with
`key exceeds 256 bytes (got 1024)`, naming the field, the limit and the actual
value. One argument later in the same request, the truth is replaced by a
permissions error. This killed the original design of this agent and cost about
an hour before a size bisection revealed it. Details in §8, B1.

**Headline engineering finding.** EU VIES overloads `isValid: false` to mean both
"not registered" and "the member state throttled you". v0.2.0 exists to stop that
becoming a false accusation against a real company, and the bug fired live during
this deployment's own test run. Details in §5.

---

## 1. Environment

| Field | Value |
|---|---|
| OS | Windows 11 Pro 26200, x86_64 |
| Shell | git-bash (MINGW64) and PowerShell 7 |
| Node / npm | v24.0.0 / 11.8.0 |
| `@terminal3/t3n-sdk` | 4.46.0 — npm latest, installed with no version pin |
| Rust | 1.96.0 |
| Rust target | `wasm32-wasip2` |
| `wasm-tools` | 1.258.0 |
| Environment target | `setEnvironment("testnet")` |
| Node URL | `https://cn-api.sg.testnet.t3n.terminal3.io` |
| WASM artifact | 229 206 bytes, `wasm-tools validate` clean |

**Worth recording as a positive.** The Quickstart worked on npm latest, first
try, unmodified. The previous bounty's report found the documented Quickstart
completely blocked on 4.30.0 and had to pin back to 3.11.0; whatever changed
between then and 4.46.0 fixed it. Registration, map creation, the egress grant
and contract execution all worked on the first attempt too. The friction in this
report is concentrated in error *messages* and missing read paths, not in the
happy path.

**Scoping caveat.** This is one tenant on one cluster
(`cn-api.sg.testnet`), on Windows. The findings below are platform-level rather
than architecture-specific, so they are very likely general — but this report
does not prove that, and B1's exact byte ceiling in particular may be
per-cluster. Where a limit is quoted it is what this cluster did, measured, not
what the platform guarantees.

---

## 2. Quickstart and dev environment

### 2.1 Claim API key and credits

Signed in, claimed test tokens against the tenant DID above, received the API
key. Stored in `.env.local`, which is git-ignored and appears nowhere in the
repo, this document, or any screenshot.

### 2.2 Toolchain

```bash
rustup target add wasm32-wasip2
cargo install wasm-tools --locked      # 3m58s, silent for most of it
```

`cargo install wasm-tools --locked` produces no output for close to four
minutes. It reads as a hang. The previous bounty's report flagged this; it is
still true, and still worth one line in the docs.

### 2.3 Connect and authenticate

Authentication is a five-step dance — resolve environment, load the WASM
component, fetch the trust manifest, handshake, authenticate — and every script
in this repo goes through the same helper (`agent/lib/session.ts`) so the path is
exercised identically everywhere. Live output:

```
Signing address: 0xa164ffd6…22c0d8
WASM component loaded.
Trust manifest verified.

--- Handshake ---
Session dbb9fa85-… | authenticated: false

--- Authenticate ---
DID returned by server: did:t3n:04306a80…65eec
Tenant control-plane baseUrl: https://cn-api.sg.testnet.t3n.terminal3.io
```

`Trust manifest verified` rather than the `unsafe_trust_server` fallback, so DKG
attestation was actually checked.

[SCREENSHOT: npm run state — tenant DID, contract 835, live_script_version 0.2.0, balance]

### 2.4 TenantClient surface

Runtime introspection, because the SDK's read paths turned out to be narrower
than expected (§8, B5):

```
tenant.maps      → [client, create, update, delete, entrySet, entryGet, getStatus]
tenant.maps.list → absent
tenant.contracts.list()        → ["z:04306a80…65eec:kyb"]   (names only)
tenant.contracts.listDetailed() → object, Array.isArray = false
```

### 2.5 Build and validate

```bash
cargo build --target wasm32-wasip2 --release
wasm-tools validate target/wasm32-wasip2/release/z_tenant_kyb.wasm
```

Built clean. Artifact 229 206 bytes, validates as a genuine WASM component. Its
declared world exports `z:tenant-kyb/contracts@0.2.0`.

[SCREENSHOT: cargo build + wasm-tools validate, artifact size]

### 2.6 Register, grant egress, test

```bash
CONTRACT_VERSION=0.2.0 npm run register-kyb    # → contract_id 835
npm run test-kyb                               # → 4/4
```

Registration allocated a **new** `contract_id` even though the tail was
unchanged — documented platform behaviour, with an undocumented consequence for
map ACLs (§8, B2). Full results in §11.

---

## 3. What the agent is

An enterprise KYB (Know Your Business) compliance agent. A compliance officer
sends a company's VAT number and optional LEI code. The agent verifies them
against two public registries — EU VIES and GLEIF — entirely inside a TEE,
scores the result, persists a certificate, and commits its SHA-256 to the
transaction's Merkle leaf. Only the structured verdict leaves the enclave.

**Why this needs a TEE rather than a normal backend.** A KYB lookup reveals your
commercial pipeline — the suppliers you are onboarding, the acquisition target
you are diligencing, the customer you are re-checking. Running it through a
conventional backend puts that question *and* its full answer into application
logs, APM traces, and any LLM context window in the chain. The identifiers are
not secret in themselves; the *pattern of who you are checking* is the sensitive
asset, and it is exactly what leaks. In a TEE, only the verdict crosses the
boundary, and the enclave that produced it can be independently attested — so a
counterparty can verify what code touched their identifiers instead of trusting
the operator's word.

Three exported functions:

| Function | What it does | Measured cost |
|---|---|---|
| `verify-vat` | VIES VAT validation, three-state: VALID / INVALID / UNKNOWN | 20.04 tokens |
| `verify-lei` | GLEIF LEI lookup, registration + entity status | 20.10 tokens |
| `kyb-screen` | Both, plus scoring, KV certificate and claims digest | ~170 tokens |

[SCREENSHOT: verify-vat live output — status VALID for Google Ireland]

---

## 4. Architecture

```
caller → t3n.execute("kyb-screen", { company, vat_country, vat_number, lei? })
   ┌─ inside the enclave ────────────────────────────────────────────────┐
   │ http GET ec.europa.eu/…/vies/rest-api/ms/{CC}/vat/{NUM}             │
   │ http GET api.gleif.org/api/v1/lei-records/{LEI}        (if supplied) │
   │ classify()  →  VALID | INVALID | UNKNOWN     pure, no I/O            │
   │ risk_band() →  LOW | MEDIUM | HIGH | UNKNOWN pure, no I/O            │
   │ sha256(certificate)                                                  │
   │ kv_store::put("z:<tid>:kyb-results", key, certificate)               │
   │ kv_store::set_claims_digest(hash)   → Merkle leaf of this tx         │
   └─────────────────────────────────────────────────────────────────────┘
← { vat_status, vat_name, lei_*, risk_score, risk_level, inconclusive[], digest }
```

Host interfaces declared in `wit/world.wit`: `tenant-context@1.0.0`,
`logging@2.1.0`, `kv-store@2.1.0`, `http@2.1.0`.

**Deliberately not imported:** `http-with-placeholders@2.1.0`. It exists to keep
`{{profile.*}}` PII out of WASM memory. These are GET requests against public
registries carrying no personal data, so importing it would widen the contract's
capability surface for no benefit. Narrowing the declared world is the one
security decision a contract author fully controls, and it should be used.

**The certificate is bounded by construction.** Because a KV value cannot exceed
508 bytes on this cluster (§8, B1) and the failure is reported as a permissions
error rather than a size error, every field sourced from an upstream registry is
clipped, derivable fields are not stored at all, and the subject is identified by
the KV *key* rather than repeated in the value. A unit test
(`worst_case_certificate_fits_kv_limit`) builds the certificate with every field
at its type maximum and fails the build if it would breach the ceiling. That
test exists because of B1. A real certificate from this deployment measures
**331 bytes**, so there is 177 bytes of headroom in practice and the bound is
proven rather than hoped for at the extreme.

[SCREENSHOT: kyb-screen live output with digest]

---

## 5. The bug this version exists to fix

VIES overloads `isValid: false`. It means "not registered" **only** when
`userError == "INVALID"`. The same field is false when the member state
throttled or dropped the query — `MS_MAX_CONCURRENT_REQ`, `MS_UNAVAILABLE`,
`TIMEOUT`. Observed live: three requests seconds apart returned VALID,
MS_MAX_CONCURRENT_REQ, VALID for the same number.

Version 0.1.x read `isValid` as a boolean. That turned a busy Dutch registry
into *"ALBERT HEIJN B.V.'s VAT number is fake"* — scoring +40 risk against a real
supermarket chain because a government API was rate-limiting.

Version 0.2.0 classifies into three states. `UNKNOWN` means "no answer", not
"no". Anything inconclusive lands in `inconclusive[]` and forces
`risk_level: "UNKNOWN"`, which a caller must handle as "re-run this" rather than
as a pass or a fail. It fired during the deployment's own test run:

```json
{ "vat_status": "UNKNOWN", "vat_name": "---",
  "lei_registration_status": "NOT_PROVIDED",
  "lei_entity_status": "NOT_PROVIDED", "lei_name": "",
  "risk_score": 0, "risk_level": "UNKNOWN",
  "inconclusive": ["vat:MS_MAX_CONCURRENT_REQ"],
  "timestamp": 1788251994, "contract_id": 835,
  "digest": "22329c9722f76af11fdbb188c7e38a540f0395ab2deb0e7d4fc743532616573a" }
```

This is not a T3N bug, which is why it is not numbered in §8. It is recorded
here and in the contract source because anyone building a compliance agent on
this platform will hit it, and because a "compliance" agent that cannot tell
*no* from *no answer* is worse than no agent at all.

Two pure functions carry the logic — `classify()` and `risk_band()` — and both
are unit-tested offline, because these are exactly the places where a mistake is
silent in production.

---

## 6. Why this is useful to an enterprise

Every B2B onboarding flow needs KYB screening. Today it is one of:

- Manual lookup on the VIES and GLEIF websites — slow, no audit trail
- A SaaS compliance API — sends your counterparty identifiers to a third party
- An internal service — identifiers in application logs and traces

This agent does it in one call, inside a TEE, with a verifiable audit trail.

**The audit trail is real, not asserted.** The certificate is persisted and its
SHA-256 is committed to the transaction's Merkle leaf via `set_claims_digest`.
`getActivityLog` returned 53 entries for this tenant at the time of writing, each
carrying `seq_no, hash, timestamp_ms, caller_type, actor, on_behalf_of, org,
contract, function, outcome` — and 53 64-hex digests are present and readable
back. I checked, because a verifiability claim you have not read back is a
marketing claim.

**Digest verification is reproducible by anyone holding a certificate:**

```bash
node -e '
const {createHash} = require("crypto");
const cert = JSON.parse(process.argv[1]);
console.log(createHash("sha256")
  .update(JSON.stringify({ ...cert, digest: "" }))
  .digest("hex") === cert.digest ? "MATCH" : "MISMATCH");
' '<certificate JSON>'
```

Tested against the live deployment: **MATCH**, on a certificate of 331 bytes
against the 508-byte ceiling.

[SCREENSHOT: digest recomputed off-chain — claimed and recomputed sha256 identical, MATCH]

**Risk scoring is a pure function** — same inputs, same score, on any node, no
clock, no randomness, no I/O:

| Signal | Weight |
|---|---|
| VAT number explicitly `INVALID` in VIES | +40 |
| LEI supplied but not resolved | +30 |
| LEI registration `LAPSED` / `RETIRED` | +20 |
| Entity status `INACTIVE` | +20 |
| Name mismatch between the two registries | +10 |
| **Any source did not answer** | **band forced to `UNKNOWN`** |

The last row matters most: an unanswered source is never scored as a negative
finding. Weights live in one `match` and a handful of `if`s in
`contract-kyb/src/kyb_screen.rs`. There is no rules engine and no config store,
deliberately — a scoring policy that can change without a redeploy is a policy
you cannot audit against the Merkle trail.

---

## 7. Ease of maintenance

This is the criterion the bounty marks VERY IMPORTANT, and the answer here is
structural rather than a promise to be diligent.

- **No credentials.** VIES and GLEIF need no API key. There is no `secrets` map
  in the deployment, nothing to rotate, nothing to leak.
- **No mutable state on the read path.** `verify-vat` and `verify-lei` are pure
  request/response. Only `kyb-screen` writes, and only append-only certificates.
- **Offline test suite** — `cargo test`, 7 unit tests + 1 doc-test, zero tokens,
  zero network. Run before any deploy.
- **A regression test on the bug report itself** — `npm run verify-bugs`
  re-runs all eight findings against the live tenant and exits non-zero if any
  claim in BUGS.md stops being true. Details in §8.
- **Read-only state probe** — `npm run state`, 0 tokens, the authoritative
  answer to "what is actually deployed right now". This exists because the
  platform has no read path for it (§8, B2/B5).
- **Health check** — `npm run health`, one JSON line, exit 1 if degraded. A
  throttled upstream reports as healthy-with-noise, not as an outage, so a cron
  entry does not cry wolf.
- **Redeploy is one command** — `scripts/redeploy.sh 0.2.1` — which bumps both
  version files, tests offline *before* spending anything, validates the
  component, registers, and proves the result end to end after.
- **No web UI, no database, no CI secrets.** The whole agent is one repository
  plus a token balance.

The failure mode that used to be silent is now impossible to miss: an upstream
that does not answer produces `risk_level: "UNKNOWN"` and a named upstream code,
never a wrong verdict.

[SCREENSHOT: npm run health — healthy=true]

[SCREENSHOT: cargo test — 7 passed + 1 doc-test]

---

## 8. Findings

Eight findings. Before submitting, **every one was re-run against the live
tenant** with `npm run verify-bugs -- --paid` and `npm run hunt`. All eight
reproduce. An earlier draft carried a ninth that did not survive re-testing; it
was deleted rather than shipped, because a report is only worth the weakest claim
in it. Full details, repro steps and `request_id`s in BUGS.md.

**Severity key.** **Major** — documented behaviour is wrong, or the error names
the wrong subsystem and sends the developer to the wrong place. **Minor** —
cosmetic or a missing convenience.

| ID | Severity | One-line summary |
|---|---|---|
| B1 | Major | KV value-size limit reported as `access denied`, while the key limit on the same call reports itself correctly |
| B2 | Major | Re-registering orphans map ACLs; no API to read a tail's current contract id |
| B3 | Major | `getScriptVersion` renamed to `getContractVersion` with no deprecation or changelog entry |
| B4 | Minor | `maps.create` warns about `readers`, then the server rejects for `writers` |
| B5 | Minor | `tenant.maps.list()` does not exist; `listDetailed()` does not return an array |
| B6 | Minor | Unhandled SDK rejections print a 1.25 MB minified bundle |
| B7 | Major | `script_version` accepted without validation and does not select a version |
| B8 | Major | Map ACL accepts contract ids that do not exist, and charges for it |

### How they were verified

`agent/verify-bugs.ts` re-runs every claim and prints PASS/FAIL per finding.
Verbatim from `npm run verify-bugs -- --paid`:

```
  PASS B3   getScriptVersion is gone in 4.46.0, getContractVersion is the replacement, no
  PASS B6   SDK ships as a single ~1.25 MB minified line with no source map
  PASS B5   tenant.maps has no list(); contracts.listDetailed() does not return an array
  PASS B2a  contracts.list() returns names only — no way to read a tail's current contract
  PASS B2b  re-registering the same tail allocates a NEW contract_id
  PASS B4   maps.create warns about `readers` client-side, then the server rejects for mis
  PASS B1   508-byte value accepted, 512 rejected, and the rejection names the permission
  PASS B7   an unregistered script_version is accepted, and a requested version does not s
  PASS B8   readers/writers accept a contract id with no contract behind it, and charge fo

  9 still reproduce, 0 no longer true, 0 not run
  spent: 350.59 tokens
```

The suite is a regression test on the report, not a one-off script. It has
already earned its keep twice: it caught B6 overstating a bundle size by 60%
(claimed "~2 MB", measured 1.25 MB, and the file was `index.js` not
`index.esm.js`), and it is why the ninth finding was withdrawn.

### The finding behind the findings

Three subsystems share one failure pattern, and it is worth more than any single
bug on the list: **where this platform validates an input it produces an
excellent error, and where it does not, the failure surfaces from an unrelated
subsystem and blames the developer's permissions.**

| Same API surface, two inputs | Result |
|---|---|
| `entrySet` key over 256 bytes | `invalid key for map "…": key exceeds 256 bytes (got 1024)` |
| `entrySet` value over 508 bytes | `access denied: StorageRouterOnBehalfOf(…) cannot write map` |
| `execute` with unknown `function_name` | names every interface it searched, and the version |
| `execute` with unregistered `script_version` | accepted, silently runs a different version |
| `maps.update` with a real contract id | accepted |
| `maps.update` with id `999999999` | accepted, charged, unverifiable afterwards |

Each pair is the same call. A developer cannot tell from the error whether they
have hit a real permission problem or an unvalidated input — which is exactly
what cost about an hour of ACL debugging on B1 for what was a payload-size limit.
The fix is not eight fixes; it is one principle applied in three more places,
and the platform already demonstrates it in the key-length path.

### Documentation observations (not bugs)

- **Token costs are undocumented.** Measured on this tenant:
  `contracts.register` 1380.18, `maps.create` 40.07 when it no-ops on an
  existing map (~150 fresh), `map-entry-set` 70–90, `updateAgentAuth` 130.31,
  `verify-vat` 20.04, `verify-lei` 20.10, `kyb-screen` ~170,
  `getActivityLog` / `getBalance` / `contracts.list` 0. Rejected writes charge 0.
  A rough table on the reference page would let developers size a token grant
  before writing any code.
- **An undocumented 256-byte KV key limit** — discovered only because its error
  message is good (see B1).
- The [outbound-http-auth-by-user](https://docs.terminal3.io/developers/adk/tips/outbound-http-auth-by-user)
  page is the single most useful page in the ADK docs — "the code is fine, but no
  grant authorizes the host" is exactly the failure developers hit. Worth linking
  from the write-contract page's `http::call` section, not only from invoke.
- `wasm-tools component wit` shows 13 `wasi:io` / `wasi:cli` imports that
  `wit/world.wit` never declares, `wasi:cli/environment` among them. The host
  loads it fine, so they are evidently injected by the `wasm32-wasip2` target and
  ignored at load. The capability model page states imports *are* the capability
  set, so this deserves one sentence saying WASI-target imports are exempt. The
  previous bounty's report raised this for the reference contract; it reproduces
  on an independently written one.
- No supported Node version range is stated anywhere in the docs.

[SCREENSHOT: npm run verify-bugs — all eight PASS]

[SCREENSHOT: B1 — access denied at 512 bytes beside the correct key-size error]

[SCREENSHOT: B7 — script_version 9.9.9 running 0.2.0, beside the same call's function_name and script_name both being properly rejected]

---

## 9. Beyond this contract

### 9.1 What I would build next

**Name:** `kyb-watch`
**Exercises:** the same two upstreams plus scheduled re-screening and diffing
against the stored certificate history in `kyb-results`.

KYB is not a one-time check. An entity that was `ISSUED / ACTIVE` at onboarding
can lapse, be retired, or go inactive months later, and the obligation to notice
sits with the onboarding party. `kyb-screen` answers "is this company in good
standing *today*"; `kyb-watch` would answer "what changed since we last looked",
by re-screening a portfolio and emitting only the deltas — each delta carrying
its own claims digest so the *timeline* becomes auditable, not just individual
verdicts.

### 9.2 What is missing from the ADK to build it today

This is the section I would most want read, because these are not bugs but
absences, and they are what actually bound what can be built.

- **No scheduler, and no documented pattern for one.** A watch contract needs to
  run on a cadence. Everything in the ADK is caller-driven, so today the cadence
  has to live outside the TEE — which means an external cron holds the list of
  entities being monitored. That list is precisely the sensitive asset the TEE was
  supposed to protect (§3). A host-side timer that can invoke a contract, even a
  coarse one, would keep the portfolio inside the enclave.
- **KV cannot hold a portfolio.** At 508 bytes per value (B1) with no documented
  list or range-scan primitive, and no `maps.list()` (B5), there is no way to
  iterate "every entity I am watching". `entryGet` by exact key is the only read.
  This is the same wall that killed the original sanctions-screening design for
  this bounty: the EU consolidated list runs to roughly 6 300 names and OFAC SDN
  to roughly 19 300, and neither fits in a 508-byte value at any sane chunking.
  Sanctions matching wants a different storage primitive, and so does portfolio
  monitoring.
- **No outbound notification primitive.** A delta that nobody is told about is
  not monitoring. `http::call` can POST to a webhook, but the URL and any signing
  secret then need to live in a `secrets` map — and the walkthrough only covers
  secrets seeded manually by the developer, with no documented path for a third
  party to pre-provision them. The previous bounty's report hit the same absence
  from the opposite direction, with a Duffel API key it had no documented way to
  obtain.
- **No response-side redaction.** `http-with-placeholders` resolves placeholders
  on the way *out*. There is no equivalent for filtering an upstream response on
  the way back, so a contract that calls an API returning more than it should
  expose has to be trusted to drop the extra fields itself. For this agent that
  is fine — I control the parsing and only the verdict is returned. For a
  contract handling regulated data it is the difference between "the enclave
  cannot leak this" and "the enclave author remembered not to".

The honest summary: `kyb-screen` fits the ADK as it exists today because it is
stateless per call, keyless, and returns a small verdict. The moment a use case
needs *state that outlives one call*, the storage and scheduling primitives run
out well before the security model does.

---

## 10. Post-challenge operation

**I intend to keep running this agent.** The reasoning is structural, not
enthusiastic: there is very little here that can rot. No credentials to rotate,
no mutable state on the read path, two government-operated upstreams that are
versioned in their own paths, one command to redeploy, and a health check that
exits non-zero when something is actually wrong.

I would also be interested in the startup program / listing page.

**If Terminal 3 would rather take it over, that is a clean handover** — and the
runbook is written whether or not it is needed. The whole agent is this
repository plus a token balance. There is no external service, no database, no
dashboard, no DNS, no CI secret. `HANDOVER.md` covers prerequisites, daily
operation, monitoring, topping up tokens, the redeploy procedure and its one
manual step, failure modes and what they mean, upstream dependency risks, how to
change the risk policy, and a from-scratch deploy on a fresh tenant (~1700
tokens, no data migration — `kyb-results` is an append-only log and every
certificate is independently verifiable from its digest).

---

## 11. Test results

All four end-to-end tests pass on live testnet (contract 835, v0.2.0):

```
Test 1: verify-vat (Google Ireland, IE/6388047V)
  status: VALID, name: GOOGLE IRELAND LIMITED ✓

Test 2: verify-lei (Siemens Energy, 5299004MG7BJU2QS6Q75)
  registration_status: ISSUED, entity_status: ACTIVE ✓

Test 3: kyb-screen (Albert Heijn, NL/002230884B01)
  vat_status: VALID, vat_name: ALBERT HEIJN B.V.
  risk_score: 0, risk_level: LOW, inconclusive: []
  digest: ccb930eb…8975 — 331 bytes, within the 508-byte ceiling ✓

Test 4: verify-vat (invalid number, DE/999999999)
  status: INVALID ✓
```

Test 3 on this run hit a responsive VIES and returned a clean pass. The
deployment's own test run (§5) hit a throttle and correctly reported
`UNKNOWN` with `inconclusive: ["vat:MS_MAX_CONCURRENT_REQ"]` instead of a
verdict — both paths are the contract working as designed. The health check
(SHOT 4) also caught a live throttle during this capture session and reported
it as healthy-with-noise, not as an outage.

Token costs measured during this deployment:

| Operation | Tokens |
|---|---|
| `contracts.register` (229 KB wasm) | 1380.18 |
| `maps.create` (existing map, no-op) | 40.07 |
| `updateAgentAuth` (egress grant) | 130.31 |
| `verify-vat` | 20.04 |
| `verify-lei` | 20.10 |
| `kyb-screen` | 170.16 |
| **Full deployment** | **1550.56** |
| Bug re-verification suite | 350.59 |

Steady state is ~20 tokens per single lookup and ~170 per full screening. The
expensive events are deployments, not queries — an hourly health cron is about
480 tokens/day.

[SCREENSHOT: full npm run test-kyb output — 4/4]

---

## 12. Repo contents

| Path | What it is |
|---|---|
| `contract-kyb/src/verify_vat.rs` | VIES client + `classify()`, the three-state fix |
| `contract-kyb/src/verify_lei.rs` | GLEIF client, both status paths |
| `contract-kyb/src/kyb_screen.rs` | Scoring, certificate, digest, KV write, size bound |
| `contract-kyb/wit/world.wit` | Declared capability set |
| `agent/lib/session.ts` | Shared authenticated-session bootstrap |
| `agent/register-kyb.ts` | Register + map + egress grant, re-runnable |
| `agent/test-kyb.ts` | End-to-end suite with per-call token accounting |
| `agent/state.ts` | Read-only deployment probe, 0 tokens |
| `agent/health.ts` | Monitoring probe, exit 1 if degraded |
| `agent/verify-bugs.ts` | Re-runs all eight findings; exit 1 if a claim is stale |
| `agent/hunt.ts` | Exploratory probe suite that found B7 and B8 |
| `agent/fix-acl.ts` | Narrows a map ACL — read B2 and B8 before running it |
| `scripts/redeploy.sh` | Bump → test → build → validate → register → prove |
| `README.md` | Architecture, trust model, setup, usage |
| `BUGS.md` | All eight findings with repros, `request_id`s and measured costs |
| `HANDOVER.md` | Runbook, whether I keep running it, how to take it over |

---

## Pre-submit checklist

- [ ] API key appears nowhere in the repo, this doc, or any screenshot — check every screenshot twice
- [ ] `.env.local` git-ignored and git history verified clean of any key
- [ ] Screenshots captured, legible, and matched to their section
- [ ] Repo public — verified in a private window
- [ ] Doc set to anyone-with-link-can-view — verified in a private window
- [ ] Doc links to repo; README links back to the published doc URL
- [ ] B1 and B7 also reported in the developer Telegram — a misleading error and a silently-ignored version field are both worth telling them before judging
- [ ] Shared on X tagging @terminal3io
- [ ] `npm run verify-bugs -- --paid` re-run immediately before submitting; every claim still PASS
- [ ] Final proofread
