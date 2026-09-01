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

## B2 — `maps.update` cannot widen an ACL it narrowed: the restriction is one-way

| Field | Value |
|---|---|
| Severity | **Major** — unrecoverable map state |
| Where | `tenant.maps.update()` |
| SDK | 4.46.0 |
| Already documented? | No |

### Repro

```typescript
await tenant.maps.create({ tail: "sizeprobe", visibility: "private",
                           readers: "all", writers: "all" });
await tenant.maps.entrySet("sizeprobe", "k", "v");                    // OK

await tenant.maps.update("sizeprobe", { readers: { only: [629] },
                                        writers: { only: [629] } });
await tenant.maps.entrySet("sizeprobe", "k2", "v");                   // denied

await tenant.maps.update("sizeprobe", { readers: "all", writers: "all" });
await tenant.maps.entrySet("sizeprobe", "k3", "v");                   // STILL denied
```

The final `update` reports success and costs 70 tokens, but the map never
becomes writable again. `getStatus` still returns `active` throughout.

Note this interacts with a documented behaviour: the
[create-kv-maps](https://docs.terminal3.io/developers/adk/tips/create-kv-maps)
page states that `writers`/`readers` restrict *contracts*, not the owner, and
that the owner can always write entries through the control plane. That holds
for a map created with `writers: { only: [id] }` — verified, the bounty-#1
`secrets` map still accepts owner writes. It does **not** hold for a map that
was created permissive and then narrowed. Those two paths should end in the
same state and don't.

### Impact

There is no recovery path other than creating a new map under a new tail. On
a `secrets` map holding a live API key that means re-seeding the key and
re-pointing every contract that reads it.

### Suggested fix

Either make `maps.update` able to widen an ACL, or reject the widening call
loudly instead of accepting it and charging for a no-op.

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