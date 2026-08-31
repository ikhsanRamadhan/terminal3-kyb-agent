#!/usr/bin/env bash
# Redeploy the KYB contract after code changes.
# Usage: ./scripts/redeploy.sh [version]
#
# Steps: build WASM -> bump version -> register -> update egress grant
set -euo pipefail

VERSION="${1:-0.1.1}"
CONTRACT_DIR="$(cd "$(dirname "$0")/../contract-kyb" && pwd)"
AGENT_DIR="$(cd "$(dirname "$0")/../agent" && pwd)"

echo "=== Building contract v${VERSION} ==="
cd "$CONTRACT_DIR"

# Update version in Cargo.toml and world.wit
sed -i "s/^version = \".*\"/version = \"${VERSION}\"/" Cargo.toml
sed -i "s/package z:tenant-kyb@.*/package z:tenant-kyb@${VERSION};/" wit/world.wit

export PATH="$PATH:$HOME/.cargo/bin"
cargo build --target wasm32-wasip2 --release
wasm-tools validate target/wasm32-wasip2/release/z_tenant_kyb.wasm
echo "Build OK: $(ls -lh target/wasm32-wasip2/release/z_tenant_kyb.wasm | awk '{print $5}')"

echo ""
echo "=== Registering v${VERSION} ==="
cd "$AGENT_DIR"
# The register script reads CONTRACT_VERSION from env
CONTRACT_VERSION="$VERSION" npx tsx --env-file=../.env.local register-kyb.ts

echo ""
echo "=== Running health check ==="
npx tsx --env-file=../.env.local health.ts

echo ""
echo "Redeploy complete."