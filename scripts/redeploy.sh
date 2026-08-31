#!/usr/bin/env bash
# Redeploy the KYB contract after a code change.
#
#   ./scripts/redeploy.sh 0.1.2
#
# Bumps the version in Cargo.toml + wit/world.wit, builds, validates the
# component, registers it, re-asserts the egress grant, and health-checks.
#
# ONE MANUAL STEP REMAINS after this script — see the reminder it prints.
# Re-registering allocates a NEW contract_id, and the kyb-results map ACL
# names contract ids, so the new contract cannot write to its own map until
# you add the id. Details: BUGS.md B3, HANDOVER.md.
set -euo pipefail

VERSION="${1:?usage: ./scripts/redeploy.sh <version>   e.g. 0.1.2}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CONTRACT_DIR="$ROOT/contract-kyb"
AGENT_DIR="$ROOT/agent"
WASM="$CONTRACT_DIR/target/wasm32-wasip2/release/z_tenant_kyb.wasm"

export PATH="$PATH:$HOME/.cargo/bin"

echo "=== 1/4  bump to v${VERSION} and build ==="
cd "$CONTRACT_DIR"
sed -i "s/^version = \".*\"/version = \"${VERSION}\"/" Cargo.toml
sed -i "s|^package z:tenant-kyb@.*|package z:tenant-kyb@${VERSION};|" wit/world.wit
cargo build --target wasm32-wasip2 --release

echo
echo "=== 2/4  validate the component ==="
wasm-tools validate "$WASM"
echo "valid — $(wc -c < "$WASM") bytes"
wasm-tools component wit "$WASM" | grep -E '^\s*(import|export)' || true

echo
echo "=== 3/4  register + egress grant ==="
cd "$AGENT_DIR"
CONTRACT_VERSION="$VERSION" npx tsx --env-file=../.env.local register-kyb.ts

echo
echo "=== 4/4  health check ==="
npx tsx --env-file=../.env.local health.ts || true

cat <<'REMINDER'

--------------------------------------------------------------------
NOT DONE YET — re-point the map ACL at the new contract_id.

Registration above printed a NEW contract_id. Until you add it to the
kyb-results ACL, kyb-screen fails with:

  access denied: TenantContract(did:t3n:<tid>/<new id>) cannot write map

verify-vat and verify-lei will keep working (they never write), so a
read-only smoke test will NOT catch this.

  cd agent
  CONTRACT_IDS=812,813,<new id> npm run fix-acl
  npm run test-kyb          # must be 4/4, including kyb-screen

Keep every historical id in the list, and record the new one in
HANDOVER.md — there is no API to read a map's current ACL.
--------------------------------------------------------------------
REMINDER