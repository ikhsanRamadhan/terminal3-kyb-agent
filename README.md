# T3N KYB Agent — Confidential Know-Your-Business Verification

**Enterprise agent for Terminal 3 T3N testnet.**

Company identity verification (VAT + LEI) executed entirely inside a
Trusted Execution Enclave. Company identifiers never leave the enclave —
only structured verification results cross the WIT boundary.

```
browser/agent → t3n.execute("kyb-screen", {company, vat_country, vat_number, lei})
                    ┌─ inside TEE ─────────────────────────────────────┐
                    │ http GET ec.europa.eu/.../vies/rest-api/...      │
                    │ http GET api.gleif.org/api/v1/lei-records/{LEI}  │
                    │ risk_score()           pure function, no I/O     │
                    │ sha256(result)                                   │
                    │ kv_store::put(kyb-results, key, cert)            │
                    │ kv_store::set_claims_digest(hash)                │
                    └──────────────────────────────────────────────────┘
                ← { company, vat_valid, lei_valid, risk_score, risk_level, digest }
```

## Why this needs a TEE

KYB/compliance checks handle sensitive company data (VAT numbers, LEI codes,
legal entity names). A conventional backend holds this data in memory, logs it,
and potentially exposes it to third-party LLM context windows. A TEE contract
ensures:

1. **Data isolation** — company identifiers are processed inside an attested
   enclave; the calling application never sees raw API responses.
2. **Auditability** — every verification commits a SHA-256 digest via
   `set-claims-digest`, landing in the transaction's Merkle leaf for
   independent verification.
3. **No API key management** — VIES and GLEIF are free public APIs. No
   secrets to rotate, no credential store to maintain.

## Trust model

- VIES (EU VAT validation) and GLEIF (LEI lookup) are called from within
  the TEE via `host:interfaces/http`. The contract never holds credentials.
- Egress is gated by per-user `agent-auth` grants (self-grant for direct calls).
- Results are persisted to a contract-only KV map (`kyb-results`) and
  committed to the Merkle audit trail.
- Risk scoring is a pure function — no I/O, fully deterministic.

## API

### `verify-vat`
```json
Input:  { "country": "IE", "vat_number": "6388047V" }
Output: { "valid": true, "name": "GOOGLE IRELAND LIMITED", "address": "---", ... }
```

### `verify-lei`
```json
Input:  { "lei": "5299004MG7BJU2QS6Q75" }
Output: { "lei": "5299004MG7BJU2QS6Q75", "legal_name": "Siemens Energy AG", "status": "ISSUED", ... }
```

### `kyb-screen` (combined)
```json
Input:  { "company": "ALBERT HEIJN B.V.", "vat_country": "NL", "vat_number": "002230884B01", "lei": null }
Output: { "company": "...", "vat_valid": true, "lei_valid": false, "risk_score": 0, "risk_level": "LOW", "digest": "..." }
```

## Quickstart

```bash
cd agent
npm install
npm run register-kyb   # register contract + create maps + grant egress
npm run test-kyb       # run end-to-end tests
npm run health         # health check
```

## Repository layout

| Path | What |
|---|---|
| `contract-kyb/` | Rust TEE contract (WASM component) |
| `contract-kyb/src/lib.rs` | Entry point + WIT bindings |
| `contract-kyb/src/verify_vat.rs` | VIES VAT validation |
| `contract-kyb/src/verify_lei.rs` | GLEIF LEI lookup |
| `contract-kyb/src/kyb_screen.rs` | Combined screening + risk scoring |
| `agent/` | TypeScript SDK scripts |
| `agent/register-kyb.ts` | Registration + map setup + egress grants |
| `agent/test-kyb.ts` | End-to-end test suite |
| `agent/health.ts` | Health check for monitoring |
| `scripts/redeploy.sh` | Version-bump + redeploy script |
| `BUGS.md` | Bugs found during development |

## Maintenance & post-challenge operation

**I will continue running this agent.** The maintenance burden is minimal:

- No API keys to rotate (VIES + GLEIF are free, keyless APIs)
- No external dependencies beyond the T3N SDK
- Health check script (`npm run health`) can be cron'd
- Redeploy script handles version bumps atomically
- Contract is stateless except for the `kyb-results` audit log

If Terminal 3 prefers to maintain it: the entire agent is this repo.
`npm run register-kyb` re-registers from scratch. The WASM artifact is
deterministic from `cargo build --target wasm32-wasip2 --release`.

## Environment

| Field | Value |
|---|---|
| OS | Windows 11 (git-bash) |
| Node | v24.0.0 |
| npm | 11.8.0 |
| @terminal3/t3n-sdk | 4.46.0 |
| Rust | 1.96.0 |
| Target | wasm32-wasip2 |
| wasm-tools | 1.258.0 |
| Environment | testnet |

## Verified testnet state

- Contract registered: `z:bdf0434dfcd541ec2af899ad28599f6653421694:kyb` (id 634)
- Maps: `kyb-results` (contract-only ACL)
- Egress: `ec.europa.eu`, `api.gleif.org`
- Tests: 4/4 passing (valid VAT, LEI lookup, combined screen, invalid VAT)