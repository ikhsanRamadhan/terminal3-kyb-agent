# T3N ADK — Bug & DX Findings (Bounty #2)

Field notes from building an enterprise KYB agent on Terminal 3 T3N testnet,
August–September 2026.

## Environment

| Field | Value |
|---|---|
| OS | Windows 11 Pro 26200, x86_64 |
| Shell | git-bash (MINGW64) + PowerShell 7 |
| Node | v24.0.0 |
| `@terminal3/t3n-sdk` | 4.46.0 (npm latest at time of writing) |
| Rust | 1.96.0, target `wasm32-wasip2` |
| `wasm-tools` | 1.258.0 |
| Environment target | `setEnvironment("testnet")`, node `cn-api.sg.testnet.t3n.terminal3.io` |
| Tenant DID | `did:t3n:04306a80…65eec` |
| Contract | `z:04306a80…65eec:kyb` id 835, v0.2.0 |

## Severity key

**Blocking** — cannot proceed on the documented path. **Major** — documented
behaviour is wrong, or the error names the wrong subsystem and sends the
developer to the wrong place. **Minor** — cosmetic or a missing convenience.

## How these were verified

Every finding was re-run against the live tenant immediately before submitting,
by `agent/verify-bugs.ts` (`npm run verify-bugs -- --paid`). That suite is in the
repo and prints PASS/FAIL per finding, exiting non-zero if any claim in this file
is no longer true — so a reviewer can re-run it rather than take this document's
word. It earned its keep twice: it caught B6 overstating a bundle size by 60%,
and it retired a ninth finding whose repro no longer held. That one was deleted
rather than shipped, because a report is only worth the weakest claim in it. Its
post-mortem is in B8, which turned out to explain it.

B1–B6 were first seen on an earlier tenant (`did:t3n:bdf0434d…21694`, contract
ids 812/813); all six still reproduce on the current one. B7 and B8 were found on
the current tenant, by `agent/hunt.ts`, while probing outward from the sizing
limits B1 exposed. Where a token cost is quoted it is a measured `getBalance()`
delta, not an estimate.

## Headline finding

Three separate subsystems share one failure pattern: **where this platform
validates an input, it produces an excellent error; where it does not, the
failure surfaces from an unrelated subsystem and blames the developer's
permissions.** The same `entrySet` call rejects an oversized *key* with
`key exceeds 256 bytes (got 1024)` and an oversized *value* with
`access denied … cannot write map` (B1). `execute` rejects an unknown
`function_name` by naming every interface it searched, and accepts a
`script_version` that was never registered (B7). `maps.update` accepts a
contract id that does not exist on the tenant and charges for it (B8).

The pattern matters more than any single bug: a developer cannot tell, from an
error, whether they have hit a real permission problem or an unvalidated input.
B1 cost about an hour of ACL debugging for what was a payload-size limit.

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

Re-verified on the current tenant (`npm run verify-bugs -- --paid`), same result:

```
508 → accepted
512 → rejected: RPC Error: access denied:
      StorageRouterOnBehalfOf(Contract(tee:tenant/contracts))
      cannot write map "z:04306a80…65eec:b1probe"
```

### Why this is the wrong error — the platform's own control case

An authorisation decision cannot depend on payload length. The write is
refused by a size check somewhere below the storage router, but the message
that surfaces names the *permission* subsystem and the map. That sends the
developer to their ACL — which is correct and unchanged — instead of to
their payload.

The strongest argument that this is a bug and not a design choice is that the
**same call already reports the other size limit correctly.** `entrySet`
validates the key length too, and when a key is too long it says so exactly:

```typescript
await tenant.maps.entrySet("b1probe", "k".repeat(256),  "v"); // OK
await tenant.maps.entrySet("b1probe", "k".repeat(1024), "v"); // throws
```

```
RPC Error: invalid key for map "z:04306a80…65eec:b1probe":
  key exceeds 256 bytes (got 1024) [afbadae3-…]
```

That is a model error message: it names the field, the limit, and the actual
value. One argument later in the same request, the value-size ceiling produces
`access denied`. Whatever validates keys is not what rejects values, and only
one of the two paths tells the truth.

As a side effect this also establishes a **256-byte key limit**, which is
likewise undocumented — but at least discoverable from its own error.

Cost note: rejected calls are charged **0 tokens**, so probing this is free;
accepted `map-entry-set` calls cost ~70 tokens each regardless of size.

### Impact

Any contract that wants to cache a structured value — a JSON config, an API
response, a certificate, a watchlist chunk — hits this. In this project it
killed a design that would have staged a sanctions-name list in KV: the
first 1 KiB chunk was refused, and the error pointed at permissions. Roughly
an hour went into ACL debugging before a size bisection revealed the truth.

It also shaped the contract that shipped. The KYB certificate is persisted to
KV, so every field that comes from an upstream registry is clipped to fit a
508-byte worst case, and a unit test
(`kyb_screen::tests::worst_case_certificate_fits_kv_limit`) fails the build if
a future field would breach it. That test exists because of this bug.

### Suggested fix

Return a distinct error (`value_too_large: 508 bytes max`) in the same style as
the key error that already works, and state both limits on
[Create tenant KV maps](https://docs.terminal3.io/developers/adk/tips/create-kv-maps).
If the ceiling is per-cluster rather than fixed, say so and name the current value.

---

## B2 — Re-registering a contract silently orphans its map ACLs

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

## B3 — `getScriptVersion` was renamed to `getContractVersion` with no deprecation

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

## B4 — `maps.create` rejects a missing `writers` before it mentions `readers`

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

## B5 — `tenant.maps.list()` does not exist

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
`delete` — no enumeration. Runtime introspection of the live object:

```
maps surface = [client, create, update, delete, entrySet, entryGet, getStatus]
maps.list    = absent
```

`contracts.listDetailed()` is also unusable — it exists but does not return
an array, so `.find(...)` throws (`typeof` is `object`, `Array.isArray` false).

### What you *can* do, and why it is not enough

`getStatus` is more useful than it first appears: on a tail that does not
exist it returns the string `"absent"` rather than throwing, so map existence
is testable by name.

```typescript
await tenant.maps.getStatus("definitely_not_a_real_map_xyz"); // → "absent"
```

So a tenant can probe for a map it already suspects. What it cannot do is
enumerate, which is the operation that matters after a handover: a new operator
inheriting a tenant has no way to discover which maps exist. Combined with B2
(no way to read a tail's current `contract_id`) and B8 (ACLs accept ids that do
not exist), the storage side of a tenant is write-mostly — you can set an ACL,
but you cannot read back what you set or what it applies to.

That gap is why `HANDOVER.md` in this repo has to carry the map list and ACL
state as prose. It is documentation standing in for an API.

---

## B6 — Unhandled SDK rejections print the entire minified bundle

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

## B7 — `script_version` is accepted without validation and does not select a version

| Field | Value |
|---|---|
| Severity | **Major** — silently breaks version pinning and weakens the audit trail |
| Where | `t3n.execute({ script_version })` |
| SDK | 4.46.0 |
| Already documented? | No. Version *shadowing* is documented; that a requested version is ignored is not |
| Found | On the current tenant, `did:t3n:04306a80…65eec` |

### Repro

Two versions are registered at the `kyb` tail: `0.1.0` and `0.2.0`. The two are
easy to tell apart from their output — `verify-vat` in 0.1.0 returns
`{ valid, name, address, … }`, and 0.2.0 added `status`, `upstream_code` and
`inconclusive`. So the response shape identifies which code actually ran,
independently of what was asked for.

```typescript
// ask for the superseded version
await t3n.execute({ script_name: `z:${tid}:kyb`, script_version: "0.1.0",
                    function_name: "verify-vat",
                    input: { country: "NL", vat_number: "002230884B01" } });

// ask for a version that was never registered
await t3n.execute({ script_name: `z:${tid}:kyb`, script_version: "9.9.9",
                    function_name: "verify-vat",
                    input: { country: "NL", vat_number: "002230884B01" } });
```

Both succeed. Both return 0.2.0's shape:

```jsonc
{"status":"VALID","valid":true,"inconclusive":false,
 "upstream_code":"VALID","name":"ALBERT HEIJN B.V.", …}
```

`"9.9.9"` has never existed on this tenant. It is not rejected, and it is not
resolved to anything — the call simply runs whatever `getContractVersion`
resolves, which is `0.2.0`.

### Why this matters

Two distinct problems, and the second is the serious one.

**A caller cannot pin a version.** `script_version` reads like the field that
selects code to run. It does not. Anyone who deploys 0.2.0 and leaves a client
pinned to 0.1.0 for compatibility gets 0.2.0's behaviour with no error, no
warning, and a response shape they were not expecting. In this contract's case
the two versions genuinely disagree: 0.1.0 reports a throttled VIES lookup as
`valid: false`, 0.2.0 reports it as `status: "UNKNOWN"`. A caller pinned to
0.1.0 semantics would read the new output as a *pass*.

**It undermines the audit trail.** `getActivityLog` records `contract` and
`function` per entry alongside the claims digest. For a compliance contract the
question an auditor asks is "which version of the scoring policy produced this
verdict" — and the version the caller stated is not evidence of the version that
ran. The digest still pins the *output*, so the record is not worthless, but the
version field cannot be trusted to explain it.

### The control case, again

The other two routing fields in the same call *are* validated, and their errors
are genuinely good:

```
function_name: "no-such-function"
→ RPC Error: contract interface error: Function not found: Function
  'no-such-function' not found in contract (looked up under
  'z:tenant-kyb/contracts@0.2.0.no-such-function' and walked every
  interface export)

script_name: "z:<tid>:no-such-tail"
→ RPC Error: tenant contract z:<tid>:no-such-tail not registered
```

The first error even names the version it searched under. So the resolution
machinery knows the version; the request field just is not checked against it.

### Suggested fix

Reject a `script_version` that is not registered at that tail, with an error in
the style of the two above — naming the version asked for and the versions
available. If the field is intentionally advisory, rename it or document that it
is ignored, because as it stands it silently means the opposite of what it says.

Cost: 4 executes, ~90 tokens total. Repro: `npm run hunt -- --shadow`, or
`npm run verify-bugs -- --paid`.

---

## B8 — A map ACL accepts contract ids that do not exist, and charges for it

| Field | Value |
|---|---|
| Severity | **Major** — an undetectable deploy-time misconfiguration |
| Where | `tenant.maps.update({ readers, writers })` |
| SDK | 4.46.0 |
| Already documented? | No |
| Found | On the current tenant, `did:t3n:04306a80…65eec` |

### Repro

```typescript
await tenant.maps.update("b1probe", {
  readers: { only: [999999999] },   // no contract has this id
  writers: { only: [999999999] },
});
// → resolves. No warning. Charged as a normal update.
```

The id `999999999` does not correspond to any contract on this tenant — the
tenant has exactly one, id 835. The update is accepted anyway.

### Why this is worse than a lenient validator

On its own, an unvalidated id is a minor gripe. It becomes a real trap in
combination with two other findings in this file:

- **B2**: every redeploy allocates a *new* `contract_id`, so ACLs have to be
  re-pointed by hand, from ids typed into a deploy script or a runbook.
- **B5**: there is no API to read an ACL back, so the value you set cannot be
  confirmed.

Put together: a typo in a contract id is accepted, charged for, unreadable
afterwards, and produces no symptom until the contract's next *write* — which,
for this KYB agent, is `kyb-screen` and nothing else. `verify-vat` and
`verify-lei` never write, so a read-only smoke test passes. The failure then
surfaces as `access denied: TenantContract(…/835) cannot write map`, which
reads like a permission problem rather than a typo three deploys ago.

This is the same failure pattern as B1 and B7: the input is not validated, so
the eventual error blames the permission subsystem.

It also, in hindsight, explains a finding this report carried in draft and then
deleted. That one claimed `maps.update` could narrow an ACL but never widen it
again — an irreversible one-way door. Re-running it on the current tenant showed
writes succeeding at every step, so the claim did not hold and was dropped. But
the original sequence had narrowed the ACL to id `629`, which was not a contract
on the tenant under test. The denial it produced was real; the explanation was
wrong. An id that does not exist is indistinguishable, at the call site, from one
that does, which is exactly what this finding is about.

### Suggested fix

Validate ids in `readers`/`writers` against the tenant's registered contracts at
`update` time and reject unknown ones, in the style of the `function_name` error
quoted in B7. Failing that, expose a read path for a map's current ACL so the
value can be verified after it is set.

Cost: ~70 tokens. Repro: `npm run hunt -- --paid`, or `npm run verify-bugs -- --paid`.

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