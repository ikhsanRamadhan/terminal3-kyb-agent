# Terminal 3 ADK Bounty — Confidential KYB Verification Agent

**Author:** Ikhsan Ramadhan
**Date:** 1 September 2026
**Repo:** https://github.com/ikhsanRamadhan/terminal3-kyb-agent
**Tenant DID:** `did:t3n:04306a8025385e404902f1c7e988abd849265eec`
**Contract:** `z:04306a8025385e404902f1c7e988abd849265eec:kyb` — id **835**, v0.2.0

[SCREENSHOT: npm run state output showing contract 835 v0.2.0]

---

## 0. Summary

Built, deployed and verified an enterprise agent that answers the question a
compliance team asks constantly — *is this company real, and is its identity
still in good standing?* — inside a TEE, so the counterparty identifiers being
checked never pass through the calling application.

- Quickstart, dev environment, walkthrough 1–5 — complete
- Enterprise agent live on testnet at v0.2.0, `npm run test-kyb` 4/4 passing
- 7 issues filed with measured repros (4 major, 3 minor)
- `cargo test` 7/7 offline; certificate digest verified off-chain
- Health check passing; redeploy script + handover runbook included
- **I intend to keep running it** (see §7)

**Headline platform finding:** a KV value-size ceiling of 508 bytes is reported
as `access denied: StorageRouterOnBehalfOf(...) cannot write map`. A permission
decision cannot depend on payload length, so the message sends developers to
their ACL — which is correct and unchanged — instead of to their payload. This
killed the original design of this agent and cost about an hour before a size
bisection revealed the truth. Details in §6, B1.

**Headline engineering finding:** EU VIES overloads `isValid: false` to mean
both "not registered" and "the member state throttled you". v0.2.0 exists to
stop that becoming a false accusation against a real company, and the bug fired
live during this deployment's own test run. Details in §3.

---

## 1. What it is

An enterprise KYB (Know Your Business) compliance agent for the Terminal 3
T3N testnet. A compliance officer sends a company's VAT number and optional
LEI code. The agent verifies them against two public registries — EU VIES
and GLEIF — entirely inside a TEE, scores the result, persists a certificate,
and commits its digest to the transaction's Merkle leaf. Only the structured
verdict leaves the enclave.

**Why TEE:** A KYB lookup reveals your commercial pipeline — the suppliers you
are onboarding, the target you are diligencing, the customer you are
re-checking. Running it through a normal backend puts that question and its
full answer in application logs, APM traces, and any LLM context window in
the chain. In a TEE, only the verdict crosses the boundary.

## 2. Architecture

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

Three exported functions:

| Function | What it does | Cost |
|---|---|---|
| `verify-vat` | VIES VAT validation (three-state: VALID/INVALID/UNKNOWN) | ~20 tokens |
| `verify-lei` | GLEIF LEI lookup (registration + entity status) | ~20 tokens |
| `kyb-screen` | Combined + scoring + KV + digest | ~190 tokens |

[SCREENSHOT: verify-vat live output — status VALID for Google Ireland]

[SCREENSHOT: kyb-screen live output with digest]

## 3. The bug this version exists to fix

VIES overloads `isValid: false`. It means "not registered" **only** when
`userError == "INVALID"`. The same field is false when the member state
throttled or dropped the query — `MS_MAX_CONCURRENT_REQ`, `MS_UNAVAILABLE`,
`TIMEOUT`. Observed live: three requests seconds apart returned VALID,
MS_MAX_CONCURRENT_REQ, VALID for the same number.

Version 0.1.1 read `isValid` as a boolean. That turned a busy Dutch registry
into *"ALBERT HEIJN B.V.'s VAT number is fake"* — scoring +40 risk against a
real supermarket chain because a government API was throttling.

Version 0.2.0 classifies into three states. `UNKNOWN` means "no answer", not
"no". It fired during the deployment test itself:

```json
{ "vat_status": "UNKNOWN", "vat_name": "---",
  "lei_registration_status": "NOT_PROVIDED",
  "lei_entity_status": "NOT_PROVIDED", "lei_name": "",
  "risk_score": 0, "risk_level": "UNKNOWN",
  "inconclusive": ["vat:MS_MAX_CONCURRENT_REQ"],
  "timestamp": 1788251994, "contract_id": 835,
  "digest": "22329c9722f76af11fdbb188c7e38a540f0395ab2deb0e7d4fc743532616573a" }
```

The correct response is re-run, and the output says so unambiguously.

## 4. Why this is useful to an enterprise

Every B2B onboarding flow needs KYB screening. Today it is either:
- Manual lookup on VIES/GLEIF websites (slow, no audit trail)
- A SaaS compliance API (sends identifiers to a third party)
- An internal service (identifiers in application logs)

This agent does it in one call, inside a TEE, with a verifiable audit trail.
The certificate is persisted and its SHA-256 is committed to the transaction
Merkle leaf, so an auditor can independently verify the result without
trusting the operator's database.

**Digest verification is reproducible.** Anyone holding a certificate can
recompute the hash off-chain:

```bash
node -e '
const {createHash} = require("crypto");
const cert = JSON.parse(process.argv[1]);
console.log(createHash("sha256")
  .update(JSON.stringify({ ...cert, digest: "" }))
  .digest("hex") === cert.digest ? "MATCH" : "MISMATCH");
' '<certificate JSON>'
```

Tested against the live deployment: **MATCH**.

Risk scoring is a pure function — same inputs, same score, on any node:

| Signal | Weight |
|---|---|
| VAT number explicitly INVALID in VIES | +40 |
| LEI supplied but not resolved | +30 |
| LEI registration LAPSED/RETIRED | +20 |
| Entity status INACTIVE | +20 |
| Name mismatch between registries | +10 |
| **Any source did not answer** | **band forced to UNKNOWN** |

The last row matters most: an unanswered source is never scored as a negative.

## 5. Ease of maintenance

This is the criterion I designed for. The answer is structural:

- **No credentials.** VIES and GLEIF need no API key. There is no `secrets`
  map, nothing to rotate, nothing to leak.
- **No mutable state on the read path.** `verify-vat` and `verify-lei` are
  pure request/response. Only `kyb-screen` writes, and only append-only
  certificates.
- **Offline test suite.** `cargo test` — 7 unit tests, zero tokens, zero
  network. Run before any deploy.
- **Health check:** `npm run health` — one JSON line, exit 1 if degraded.
  A throttled upstream reports as healthy-with-noise, not as an outage.
- **State probe:** `npm run state` — 0 tokens, the authoritative answer to
  "what is deployed right now".
- **Redeploy is one command:** `scripts/redeploy.sh 0.2.1` — tests offline
  before spending, proves end-to-end after.
- **No web UI, no database, no CI secrets.** The whole agent is one repo plus
  a token balance.

[SCREENSHOT: npm run health output showing healthy=true]

[SCREENSHOT: cargo test output — 7 passed]

## 6. Bugs found

Seven findings, all reproduced on live testnet. Full details with repro steps
are in BUGS.md in the repository. Summary:

| ID | Severity | One-line summary |
|---|---|---|
| B1 | Major | KV value-size limit reported as `access denied` |
| B2 | Major | `maps.update` cannot widen a narrowed ACL (one-way) |
| B3 | Major | Re-registering orphans map ACLs |
| B4 | Major | `getScriptVersion` renamed without deprecation |
| B5 | Minor | `maps.create` validates `writers` after warning about `readers` |
| B6 | Minor | `tenant.maps.list()` does not exist |
| B7 | Minor | Unhandled SDK rejections print 2 MB minified bundle |

Plus documentation observations: undocumented token costs, missing SDK
changelog, WASI-target imports not explained in capability model.

The v0.2.0 rework itself was driven by a finding that did not make BUGS.md
because it is upstream behaviour, not a T3N bug: VIES overloading `isValid`
(see section 3). It is documented in the contract source and README because
anyone building a compliance agent on this platform will hit it.

[SCREENSHOT: B1 repro showing access denied at 512 bytes]

## 7. Post-challenge operation

**I intend to keep running this agent.** The reasoning is structural, not
enthusiastic: there is nothing here that can rot. No credentials to rotate,
no mutable state on the read path, one command to redeploy.

If Terminal 3 would rather take it over, that is a clean handover. The whole
agent is this repository plus a token balance. See HANDOVER.md for the full
runbook.

## 8. Test results

All four end-to-end tests pass on live testnet (contract 835, v0.2.0):

```
Test 1: verify-vat (Google Ireland, IE/6388047V)
  status: VALID, name: GOOGLE IRELAND LIMITED ✓

Test 2: verify-lei (Siemens Energy, 5299004MG7BJU2QS6Q75)
  registration_status: ISSUED, entity_status: ACTIVE ✓

Test 3: kyb-screen (Albert Heijn, NL/002230884B01)
  vat_status: UNKNOWN (VIES throttled — correctly reported, not scored)
  risk_level: UNKNOWN, inconclusive: ["vat:MS_MAX_CONCURRENT_REQ"]
  digest: 22329c97…573a — recomputed off-chain: MATCH ✓

Test 4: verify-vat (invalid, DE/999999999)
  status: INVALID ✓
```

Token costs measured during this deployment:

| Operation | Tokens |
|---|---|
| contracts.register (229 KB wasm) | 1380.18 |
| maps.create (existing, no-op) | 40.07 |
| updateAgentAuth | 130.31 |
| verify-vat | 20.04 |
| verify-lei | 20.10 |
| kyb-screen | 190.17 |
| Full deployment | 1550.56 |

[SCREENSHOT: full test-kyb output]

## 9. Environment

| Field | Value |
|---|---|
| OS | Windows 11, git-bash |
| Node / npm | v24.0.0 / 11.8.0 |
| SDK | `@terminal3/t3n-sdk` 4.46.0 |
| Rust / target | 1.96.0 / `wasm32-wasip2` |
| `wasm-tools` | 1.258.0 |
| WASM artifact | 229 206 bytes, `wasm-tools validate` clean |

## 10. Repository

Public GitHub: https://github.com/ikhsanRamadhan/terminal3-kyb-agent

The repo is self-contained. Everything needed to understand, run, or take
over the agent is there: README, BUGS.md with repros, HANDOVER.md runbook,
operator scripts, and the contract source.

## Pre-submit checklist

- [ ] Screenshots captured and inserted above
- [ ] Google Doc is set to "anyone with link can view"
- [ ] Doc links to repo; README links back to the published doc URL
- [ ] B1 and B3 reported in the developer Telegram — both are the kind of
      thing worth telling them before judging
- [ ] Shared on X tagging @terminal3io
- [ ] Final proofread
