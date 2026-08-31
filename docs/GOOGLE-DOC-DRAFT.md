# Terminal 3 ADK Bounty #2 — Submission Document

## Author
Ikhsan Ramadhan
Date: 31 August 2026
Repo: https://github.com/ikhsanRamadhan/terminal3-kyb-agent
Tenant DID: did:t3n:bdf0434dfcd541ec2af899ad28599f6653421694

## 0. Summary

Built and deployed a **Confidential KYB (Know-Your-Business) Verification Agent**
on T3N testnet. The agent verifies company identity via EU VIES (VAT validation)
and GLEIF (Legal Entity Identifier lookup), entirely inside a TEE. Company data
never leaves the enclave.

- Quickstart — Complete
- Set Up Dev Environment — Complete
- Walkthrough steps 1–5 — Complete (adapted for KYB use case)
- Enterprise agent deployed and tested: 4/4 tests passing
- Issues filed: 6 (2 major, 4 minor)
- Health check: passing
- Maintenance plan: will continue running post-challenge

**Headline finding:** The KV map value size limit (~500 bytes) is misreported
as "access denied", causing developers to debug permissions when the actual
issue is a payload size constraint. This affects any use case storing
structured data in KV maps.

## 1. Environment

| Field | Value |
|---|---|
| OS | Windows 11 (git-bash) |
| Node | v24.0.0 |
| npm | 11.8.0 |
| @terminal3/t3n-sdk | 4.46.0 |
| Rust | 1.96.0 |
| Target | wasm32-wasip2 |
| wasm-tools | 1.258.0 |
| Environment target | setEnvironment("testnet") |

## 2. Quickstart

Followed the Quickstart exactly. One deviation: `trustAnchor` must be passed
explicitly (the docs example omits it but the field is required). Used
`fetchTrustedManifest("testnet")` with fallback to `{ unsafe_trust_server: true }`.

Result: authenticated successfully, received tenant DID, balance confirmed.

## 3. Enterprise Agent: KYB Verification

### 3.1 Use case justification

KYB (Know Your Business) verification is a compliance requirement for any
enterprise onboarding third-party vendors, partners, or customers. The
standard checks are:

1. **VAT validation** — Is the company's VAT number valid in the EU VIES registry?
2. **LEI verification** — Does the company have a valid Legal Entity Identifier?
3. **Risk scoring** — Combining both signals into a risk assessment.

This is a real enterprise need (AML/KYC compliance teams do this daily) and
it exercises multiple T3N capabilities: HTTP egress, KV storage, Merkle audit,
and TEE data isolation.

### 3.2 Why TEE is required

Company identifiers (VAT numbers, LEI codes, legal names) are sensitive
business data. In a conventional backend:
- The data sits in server memory
- It may be logged
- If an AI agent processes it, it enters the LLM context window
- Third-party API responses (VIES, GLEIF) are held in plaintext

Inside a TEE:
- Company data is processed in an attested enclave
- Only the verification result (valid/invalid, risk score) leaves
- The Merkle audit trail provides independent verification
- No API keys needed (VIES and GLEIF are free public APIs)

### 3.3 Contract implementation

Three exported functions:
- `verify-vat` — calls VIES REST API, returns validation result
- `verify-lei` — calls GLEIF API, returns entity details
- `kyb-screen` — orchestrates both, computes risk score, persists result,
  commits SHA-256 digest to Merkle trail

### 3.4 Test results

| Test | Input | Result |
|---|---|---|
| verify-vat (valid) | IE/6388047V | `{"valid":true,"name":"GOOGLE IRELAND LIMITED",...}` |
| verify-lei | 5299004MG7BJU2QS6Q75 | `{"legal_name":"Siemens Energy AG","status":"ISSUED",...}` |
| kyb-screen | NL/002230884B01 | `{"vat_valid":true,"risk_score":0,"risk_level":"LOW",...}` |
| verify-vat (invalid) | DE/999999999 | `{"valid":false,"name":"---",...}` |

All 4 tests passing. Token costs: ~63 tokens per simple call, ~130 for
kyb-screen (two HTTP calls + KV write + digest commit).

## 4. Issues filed

See BUGS.md in the repository. Summary:

| ID | Severity | Issue |
|---|---|---|
| B1 | Major | KV value size limit misreported as "access denied" |
| B2 | Minor | maps.create error only mentions `writers`, not `readers` |
| B3 | Major | maps.update cannot restore permissive ACL (one-way restriction) |
| B4 | Minor | tenant.maps.list() does not exist |
| B5 | Minor | Minified bundle makes debugging impossible |
| B6 | Minor | getScriptVersion vs getContractVersion naming mismatch |

## 5. Maintenance & post-challenge operation

**I will continue running this agent.** Rationale:

- Zero credential management (VIES + GLEIF are keyless)
- No external dependencies beyond the T3N SDK
- Health check script can be cron'd for monitoring
- Redeploy script handles version bumps atomically
- Contract is stateless except for the audit log

If Terminal 3 prefers to maintain it: the entire agent is the repository.
`npm run register-kyb` re-registers from scratch. The WASM artifact is
deterministic from `cargo build --target wasm32-wasip2 --release`.

## 6. Screenshots

*(To be added: registration output, test results, health check, activity log)*

## 7. Repo contents

| Path | What it is |
|---|---|
| contract-kyb/ | Rust TEE contract |
| agent/ | TypeScript SDK scripts (register, test, health) |
| scripts/ | Deployment automation |
| BUGS.md | Bug findings |
| README.md | Architecture + usage |