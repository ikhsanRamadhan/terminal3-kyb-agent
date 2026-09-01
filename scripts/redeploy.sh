#!/usr/bin/env bash
# Redeploy the KYB contract after a code change.
#
#   ./scripts/redeploy.sh 0.2.1
#
# Bumps the version in Cargo.toml + wit/world.wit, runs the offline test suite,
# builds, validates the component, registers it, re-asserts the egress grant,
# and then proves the deployment end to end with the full 4-test suite.
#
# The end-to-end run matters: re-registering allocates a NEW contract_id, and if
# the results map has a contract-scoped ACL the new id cannot write to it. Only
# kyb-screen writes, so a read-only health check will NOT catch that. See the
# note this script prints at the end, BUGS.md B3/B6, and HANDOVER.md.
set -euo pipefail

VERSION="${1:?usage: ./scripts/redeploy.sh <version>   e.g. 0.2.1}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CONTRACT_DIR="$ROOT/contract-kyb"
AGENT_DIR="$ROOT/agent"
WASM="$CONTRACT_DIR/target/wasm32-wasip2/release/z_tenant_kyb.wasm"

export PATH="$PATH:$HOME/.cargo/bin"

echo "=== 1/5  bump to v${VERSION} ==="
cd "$CONTRACT_DIR"
sed -i "s/^version = \".*\"/version = \"${VERSION}\"/" Cargo.toml
sed -i "s|^package z:tenant-kyb@.*|package z:tenant-kyb@${VERSION};|" wit/world.wit

echo
echo "=== 2/5  offline tests (free, no network, no tokens) ==="
cargo test

echo
echo "=== 3/5  build + validate the component ==="
cargo build --target wasm32-wasip2 --release
wasm-tools validate "$WASM"
echo "valid — $(wc -c < "$WASM") bytes"
wasm-tools component wit "$WASM" | grep -E '^\s*(import|export)' || true

echo
echo "=== 4/5  register + egress grant (~1550 tokens) ==="
cd "$AGENT_DIR"
CONTRACT_VERSION="$VERSION" npx tsx --env-file=../.env.local register-kyb.ts

echo
echo "=== 5/5  prove it end to end (~250 tokens) ==="
npx tsx --env-file=../.env.local state.ts
npx tsx --env-file=../.env.local test-kyb.ts

cat <<'REMINDER'

--------------------------------------------------------------------
DONE — but read this before you touch the map ACL.

Registration above printed a NEW contract_id (that is documented platform
behaviour, not a bug). Whether you now have to do anything depends on how
the kyb-results map was created:

  * Permissive map (writers: "all") — the current deployment. Nothing to
    do. Step 5 already proved kyb-screen can write. Prefer NOT to run
    fix-acl: a contract-scoped ACL names contract ids, every redeploy
    allocates a new one (BUGS.md B3), and there is no API to read an ACL
    back (B6) — so you gain a recurring manual step and no safety.

  * Contract-scoped map (writers: { only: [...] }) — kyb-screen in step 5
    will have failed with:
        access denied: TenantContract(did:t3n:<tid>/<new id>) cannot write map
    Then, and only then:
        cd agent && CONTRACT_IDS=<every historical id>,<new id> npm run fix-acl
        npm run test-kyb     # must be 4/4

Either way: record the new contract_id in HANDOVER.md. There is no API to
read a tail's current contract_id or a map's current ACL (B3, B6), so that
file is the only record.
--------------------------------------------------------------------
REMINDER