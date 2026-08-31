# T3N ADK — Bug & DX Findings (Bounty #2)

Field notes from building an enterprise KYB agent on Terminal 3 T3N testnet.
SDK version: 4.46.0. Each finding has a repro.

> No secrets appear anywhere in this repo or its history. `.env.local`
> is git-ignored and never printed.

## Findings

### B1 — KV map value size limit (~500 bytes) misreported as "access denied"

| Field | Value |
|---|---|
| Severity | Major — misleading error message |
| Where | `tenant.maps.entrySet()` / control-plane `map-entry-set` |
| SDK version | 4.46.0 |
| Already documented? | No |

**Repro:**
```typescript
// Works: 256-byte value
await tenant.maps.entrySet("secrets", "small", "x".repeat(256)); // OK

// Fails: 512-byte value
await tenant.maps.entrySet("secrets", "large", "x".repeat(512));
// RPC Error: access denied: StorageRouterOnBehalfOf(Contract(tee:tenant/contracts))
//   cannot write map "z:<tid>:secrets"
```

**Analysis:** The same map, same session, same caller, same ACL — only the
value size differs. A permission check cannot depend on payload length. The
error message says "access denied" but the actual cause is a value-size
ceiling (~256–508 bytes, boundary not precisely determined).

**Impact:** Any developer trying to store structured data (JSON configs,
API responses, certificates) in a KV map will hit this and believe they have
an ACL problem. They will waste time debugging permissions when the real fix
is to chunk the data or use a different storage approach.

**Suggested fix:** Return a distinct error like `value_too_large: max 512 bytes`
or document the limit in the KV map creation docs.

---

### B2 — `maps.create` requires both `readers` AND `writers` but error only mentions `writers`

| Field | Value |
|---|---|
| Severity | Minor — confusing error |
| Where | `tenant.maps.create()` |
| SDK version | 4.46.0 |
| Already documented? | Partially (create-kv-maps page mentions readers required) |

**Repro:**
```typescript
await tenant.maps.create({ tail: "test", visibility: "private" });
// RPC Error: parse input: missing field `writers` at line 1 column 126
```

The error mentions `writers` but not `readers`. The docs page says `readers`
is required, but the runtime error only complains about `writers`. A developer
fixing the `writers` error will then immediately hit a second error about
`readers`.

**Suggested fix:** Include both missing fields in the error message, or
validate both before returning.

---

### B3 — `maps.update` cannot restore a permissive ACL after restricting

| Field | Value |
|---|---|
| Severity | Major — one-way ACL restriction |
| Where | `tenant.maps.update()` |
| SDK version | 4.46.0 |
| Already documented? | No |

**Repro:**
```typescript
// 1. Create with permissive ACL
await tenant.maps.create({ tail: "test", visibility: "private", readers: "all", writers: "all" });
// entrySet works fine

// 2. Restrict to contract-only
await tenant.maps.update("test", { readers: { only: [629] }, writers: { only: [629] } });
// entrySet now denied (expected)

// 3. Try to restore permissive ACL
await tenant.maps.update("test", { readers: "all", writers: "all" });
// entrySet STILL denied — the restriction is one-way
```

**Impact:** If a developer accidentally restricts a map's ACL too tightly,
there is no recovery path short of creating a new map. This is particularly
dangerous for the `secrets` map where API keys are stored.

**Suggested fix:** Allow the map owner to widen ACLs via `maps.update`, or
document that ACL changes are irreversible.

---

### B4 — `tenant.maps.list()` does not exist on TenantClient

| Field | Value |
|---|---|
| Severity | Minor — docs/type mismatch |
| Where | TenantClient API surface |
| SDK version | 4.46.0 |
| Already documented? | No |

**Repro:**
```typescript
const maps = await tenant.maps.list();
// TypeError: tenant.maps.list is not a function
```

The `maps` namespace has `create`, `update`, `getStatus`, `entrySet`,
`entryGet`, `delete` — but no `list`. There is no way to enumerate
existing maps for a tenant.

**Workaround:** Track map tails externally. The contract registration
flow knows which maps it needs.

---

### B5 — SDK minified bundle makes error debugging extremely difficult

| Field | Value |
|---|---|
| Severity | Minor — DX |
| Where | @terminal3/t3n-sdk dist/index.esm.js |
| SDK version | 4.46.0 |
| Already documented? | N/A |

The SDK ships as a single minified line. When an error occurs inside the
SDK (e.g., during handshake or execute), the stack trace points to
`index.esm.js:2:1013665` — a character offset in a 2MB minified file.
Source maps are not included.

**Impact:** When the SDK itself has a bug (like B1's misleading error),
developers cannot trace the failure to understand what went wrong. They
must rely on the error message string, which may be inaccurate.

**Suggested fix:** Ship source maps alongside the minified bundle, or
provide an unminified development build.

---

### B6 — `getScriptVersion` vs `getContractVersion` naming inconsistency

| Field | Value |
|---|---|
| Severity | Minor — API naming |
| Where | SDK exports |
| SDK version | 4.46.0 |
| Already documented? | No |

The walkthrough docs reference `getContractVersion()` but the SDK exports
`getScriptVersion()`. The invoke-contract page uses `getContractVersion`
in its code example. Following the docs verbatim produces
`getContractVersion is not a function`.

**Suggested fix:** Export both names as aliases, or update the docs.

---

## Documentation observations (not bugs)

- The `create-kv-maps` page correctly documents that `readers` is required
  and that the owner can always write via control plane. Good.
- The `outbound-http-auth-by-user` page clearly explains the egress model.
  The warning box about "most common reason a working contract can't reach
  its API" is exactly the right framing.
- Token costs are not documented anywhere. Developers must discover costs
  empirically. A rough table (register ~1400, execute ~60-130, map-create
  ~230, entry-set ~70) would help with planning.