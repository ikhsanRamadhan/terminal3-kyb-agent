# T3N ADK — Bug & DX Findings (Bounty #2)

Field notes from building an enterprise KYB agent on Terminal 3 T3N testnet,
August 2026. SDK `@terminal3/t3n-sdk@4.46.0`, Node v24.0.0, Rust 1.96.0,
`wasm32-wasip2`, `wasm-tools` 1.258.0, Windows 11 / git-bash.

Every finding below was reproduced on live testnet. B1–B7 were originally
discovered against tenant `did:t3n:bdf0434d…21694` (contract ids 812/813);
the current deployment runs under `did:t3n:04306a80…65eec` (contract id 835,
v0.2.0) and exhibits the same platform behaviour. Where a token cost is quoted
it is a measured `getBalance()` delta, not an estimate.

> No secrets appear in this repo or its history. `.env.local` is git-ignored
> and never printed.

---

## B1 — A KV value-size limit is reported as `access denied`

| Field | Value |
|---|---|
| Severity | **Major** — the error names the wrong subsystem |
| Where | `tenant.maps.entrySet()` → control-plane `map-entry-set` |
| SDK | 4.46.0 |
| Already documented? | No — no size limit appears anywhere in the docs |

### Repro

Same map, same session, same caller, same ACL. Only the value length changes:

```typescript
await tenant.maps.entrySet("secrets", "_a", "x".repeat(256)); // OK
await tenant.maps.entrySet("secrets", "_b", "x".repeat(508)); // OK
await tenant.maps.entrySet("secrets", "_c", "x".repeat(512)); // throws
```

```
RpcError: RPC Error: access denied: StorageRouterOnBehalfOf(Contract(tee:tenant/contracts))
  cannot write map "z:bdf0434d…21694:secrets" [7dacdf22-…]
```

Measured boundary by bisection: **508 bytes accepted, 512 bytes rejected**.
A 200-byte key with a 200-byte value succeeds, and a 250-byte key with a
1-byte value succeeds, so the limit applies to the **value only** — the key
does not count toward it.

### Why this is the wrong error

An authorisation decision cannot depend on payload length. The write is
refused by a size check somewhere below the storage router, but the message
that surfaces names the *permission* subsystem and the map. That sends the
developer to their ACL — which is correct and unchanged — instead of to
their payload.

Cost note: rejected calls are charged **0 tokens**, so probing this is free;
accepted `map-entry-set` calls cost ~70 tokens each regardless of size.

### Impact

Any contract that wants to cache a structured value — a JSON config, an API
response, a certificate, a watchlist chunk — hits this. In this project it
killed a design that would have staged a sanctions-name list in KV: the
first 1 KiB chunk was refused, and the error pointed at permissions. Roughly
an hour went into ACL debugging before a size bisection revealed the truth.

### Suggested fix

Return a distinct error (`value_too_large: 512 bytes max`), and state the
limit on [Create tenant KV maps](https://docs.terminal3.io/developers/adk/tips/create-kv-maps).
If the ceiling is per-cluster rather than fixed, say so and name the current value.

---

## B2 — WITHDRAWN: an ACL-widening failure that no longer reproduces

| Field | Value |
|---|---|
| Severity | ~~Major~~ → **withdrawn**, kept for the record |
| Where | `tenant.maps.update()` |
| SDK | 4.46.0 |
| Status | Observed once on tenant `bdf0434d…21694`; **could not be reproduced** on `04306a80…65eec` |

This was filed as a Major finding: that `maps.update` can narrow a map's ACL
but not widen it again, leaving the map permanently unwritable. Before
submitting, every finding in this file was re-run against the current tenant
(`npm run verify-bugs`). Six reproduced. This one did not, so it is withdrawn
rather than quietly dropped.

### What was originally observed

On tenant `bdf0434d…21694`: a map created with `readers/writers: "all"`
accepted writes; after `update` to `{ only: [629] }` writes were denied; after
`update` back to `"all"` writes were **still** denied, with `getStatus` still
reporting `active` throughout. The widening call reported success and charged
70 tokens.

### What happens now

`agent/b2probe.ts` runs that exact sequence against the current tenant, using
a throwaway `b2probe` map and the live contract id 835:

```
1. create b2probe with readers=all, writers=all
2. entrySet('before_narrow')                            → ACCEPTED
3. update to { readers/writers: { only: [835] } }        → ok
4. entrySet('after_narrow')                             → ACCEPTED  ← not denied
5. update back to { readers/writers: "all" }             → ok
6. entrySet('after_widen')                              → ACCEPTED
```

Cost: 500.66 tokens.

Step 4 is the interesting line. The narrowing never denied the owner's write
at all, so the premise the original finding rested on — narrow, get denied,
widen, stay denied — did not occur. And that non-denial is precisely what
[create-kv-maps](https://docs.terminal3.io/developers/adk/tips/create-kv-maps)
documents: `writers`/`readers` restrict *contracts*, not the owner, and the
owner can always write entries through the control plane. The original B2 text
asserted that this documented behaviour "does not hold for a map that was
created permissive and then narrowed." On the current tenant it does hold.

### Why this is still worth reading

Two possibilities, and this repo cannot distinguish them:

1. The behaviour was fixed between the two tenants' lifetimes.
2. The original denial had a different cause that was misattributed to the ACL
   — the tenants differ, and the id used in the original narrowing (629) was
   not a contract on the tenant being tested, whereas 835 is.

Explanation 2 is the more likely one and it is a real trap either way: an ACL
naming a contract id that does not exist on the tenant is indistinguishable, at
the call site, from one naming a live id. Nothing validates the ids in an ACL
at `update` time, and B6 means you cannot read them back afterwards to check.
That is worth a platform answer even though the original claim is withdrawn.

### What this changes elsewhere in the repo

The argument for keeping `kyb-results` permissive does **not** depend on this
finding. It rests on B3, which reproduces: every redeploy allocates a new
`contract_id`, so a contract-scoped ACL breaks `kyb-screen` on every deploy,
and only `kyb-screen` writes — a read-only smoke test cannot see it. Narrowing
is still a per-deploy manual step with no read-back; it is simply not the
irreversible one-way door this finding claimed.

---

## B3 — Re-registering a contract silently orphans its map ACLs

| Field | Value |
|---|---|
| Severity | **Major** — working deployment breaks on redeploy |
| Where | `contracts.register` + map `readers`/`writers` |
| SDK | 4.46.0 |
| Already documented? | Partially — version-shadowing is documented; the ACL consequence is not |

### Repro

1. Register `kyb` v0.1.0 → `contract_id 812`.
2. Create `kyb-results` with `writers: { only: [812] }`.
3. `kyb-screen` writes its result — OK.
4. Fix a bug, register `kyb` v0.1.1 → **`contract_id 813`** (new id, as documented).
5. `kyb-screen` on the same tail, at the version the node itself resolves:

```
RPC Error: access denied: TenantContract(did:t3n:bdf0434d…21694/813)
  cannot write map "z:bdf0434d…21694:kyb-results" [b5306ff0-…]
```

The contract is the same code at the same tail. Its own map now refuses it
because the ACL names the previous incarnation's id.

### Why it is worse than it looks

There is no API to read a tail's current `contract_id`. `contracts.list()`
returns names only; `contracts.listDetailed()` does not return an array on
4.46.0 (`detailed.find is not a function`). So after a redeploy the developer
cannot discover the id they now need to put in the ACL — they must have
recorded the value printed by `register` at deploy time, forever, for every
version.

Recovery here needed a purpose-written script that takes the ids on the
command line and re-points the ACL at *both* generations:

```
CONTRACT_IDS=812,813 npm run fix-acl
```

This is `agent/fix-acl.ts` in this repo. It exists only because of this bug.

### Impact

Every contract that owns a KV map breaks on its first redeploy, with an error
that reads like a permissions mistake. The previous bounty's report already
flagged the missing "read a tail's contract_id" endpoint as a platform gap;
this is that gap turning into a live outage rather than an inconvenience.

### Suggested fix

Expose the current `contract_id` for a tail (or accept a tail name in map
ACLs so they follow re-registration). Failing that, document the redeploy
runbook prominently on the register page: record the id, re-point every ACL,
keep the old id in the list until nothing references it.

---

## B4 — `getScriptVersion` was renamed to `getContractVersion` with no deprecation

| Field | Value |
|---|---|
| Severity | Major — breaks working code on a minor-version bump |
| Where | SDK top-level exports |
| SDK | present in 4.35.1, gone in 4.46.0 |
| Already documented? | No — the changelog has no SDK entries at all |

### Repro

Code that ran on 4.35.1 during the previous bounty:

```typescript
import { getScriptVersion } from "@terminal3/t3n-sdk";
const v = await getScriptVersion(baseUrl, scriptName);
```

On 4.46.0:

```
SyntaxError: The requested module '@terminal3/t3n-sdk' does not provide
an export named 'getScriptVersion'
```

`getContractVersion` is the replacement and has the same signature. Runtime
introspection of 4.46.0 exports confirms: 131 exports, `getContractVersion`
present, `getScriptVersion` absent, no alias.

The docs are self-consistent here — the
[invoke-contract](https://docs.terminal3.io/developers/adk/get-started/walkthrough/invoke-contract)
page already uses `getContractVersion`. The problem is purely that the old
name was removed without an alias or a note, and the
[Changelog](https://docs.terminal3.io/developers/adk/changelog) explicitly
carries no SDK version history to check against.

### Suggested fix

Re-export `getScriptVersion` as a deprecated alias, and start recording SDK
breaking changes in the changelog. The changelog's current honesty about
having no confirmed release history is the right instinct, but a rename that
breaks imports is exactly the class of change that has to be written down.

---

## B5 — `maps.create` rejects a missing `writers` before it mentions `readers`

| Field | Value |
|---|---|
| Severity | Minor — two round-trips to learn one lesson |
| Where | `tenant.maps.create()` |
| SDK | 4.46.0 |
| Already documented? | `readers` is documented as required; `writers` is not |

### Repro

```typescript
await tenant.maps.create({ tail: "sizeprobe", visibility: "private" });
```

The SDK first prints a client-side warning about `readers`:

```
[t3n-sdk] maps.create("sizeprobe"): no `readers` specified — the map will be
created with a deny-all read policy, so no one (including you) can read it.
```

then the server rejects the call for a different field:

```
RpcError: RPC Error: parse input: missing field `writers` at line 1 column 126
```

So the developer is warned about one field and failed on another. The
create-kv-maps page documents `readers` as mandatory and does not say
`writers` is mandatory too.

### Suggested fix

Validate both fields and name both in one error; add `writers` to the
required-fields note in the docs.

---

## B6 — `tenant.maps.list()` does not exist

| Field | Value |
|---|---|
| Severity | Minor — missing read path |
| Where | `TenantClient.maps` |
| SDK | 4.46.0 |
| Already documented? | No |

```typescript
await tenant.maps.list();
// TypeError: s.tenant.maps.list is not a function
```

The namespace has `create`, `update`, `getStatus`, `entrySet`, `entryGet`,
`delete` — no enumeration. Combined with B3 (no way to read a tail's current
`contract_id`) the tenant has no read-side view of its own storage
configuration: not which maps exist, not which contract ids their ACLs name.
`contracts.list()` returns names, so the contract side is at least partly
introspectable; the map side is not.

`contracts.listDetailed()` is also unusable — it exists but does not return
an array, so `.find(...)` throws.

---

## B7 — Unhandled SDK rejections print the entire minified bundle

| Field | Value |
|---|---|
| Severity | Minor — DX |
| Where | `@terminal3/t3n-sdk/dist/index.js` |
| SDK | 4.46.0 |

The SDK ships as a single 1.25 MB minified line (`index.js`, 1,252,391
characters on one line) with no source map. When a promise rejects out of a
script, Node's error report includes the offending source line — which is the
whole bundle. A single failed `entrySet` produced over a megabyte of
obfuscated JavaScript on stderr, burying the actual message. Every probe
script in this repo pipes stderr through `awk 'length($0)<400'` purely to
work around this.

Stack frames are likewise character offsets into that line
(`index.js:2:1170028`), so a failure inside the SDK cannot be traced to
a function. This is what made B1 hard to diagnose: the only signal available
was an error string, and that string was wrong.

### Suggested fix

Ship `.map` files, or publish an unminified build alongside the minified one.

---

## Documentation observations (not bugs)

- **Token costs are undocumented.** Measured on live testnet:
  `contracts.register` 1380–1410, `maps.create` 150 (40 when it no-ops on an
  existing map), `map-entry-set` 70–90, `updateAgentAuth` 100–130,
  `verify-vat` (one outbound GET) 20, `kyb-screen` (GETs + KV write +
  claims digest) 170 at v0.1.x / 190 at v0.2.0, `getActivityLog` 0.
  Rejected writes charge 0; a
  contract that starts and then errors is still charged, which the
  [Tokens](https://docs.terminal3.io/t3n/how-t3n-works/tokens) page does
  document under charge-on-attempt. A rough table on the reference page
  would let developers size a token grant before writing code.
- The [outbound-http-auth-by-user](https://docs.terminal3.io/developers/adk/tips/outbound-http-auth-by-user)
  page is the single most useful page in the ADK docs — "the code is fine,
  but no grant authorizes the host" is exactly the failure developers hit.
  Worth linking from the write-contract page's `http::call` section, not
  only from invoke.
- `wasm-tools component wit` on this contract shows 13 `wasi:io` / `wasi:cli`
  imports that `wit/world.wit` never declares (`wasi:cli/environment` among
  them), same as the previous bounty's report noted for the reference
  contract. The host loads it fine, so these are evidently injected by the
  `wasm32-wasip2` target and ignored at load. The capability model page
  states imports *are* the capability set, so this deserves one sentence
  saying WASI-target imports are exempt — a developer auditing their own
  contract's surface currently has no way to tell.
- `cargo install wasm-tools --locked` took 3m58s with no output for most of
  it. The previous report flagged this; still true, still reads as a hang.