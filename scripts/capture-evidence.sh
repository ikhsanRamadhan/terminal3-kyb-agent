#!/usr/bin/env bash
# Capture every screenshot the submission needs, in one pass, in order.
#
#   ./scripts/capture-evidence.sh
#
# Prints a numbered banner before each command so a screenshot is
# self-labelling. Pauses between steps — press Enter when you have the shot.
#
# Cost: ~270 tokens total (state and cargo test are free; health ~20;
# test-kyb ~250). Nothing here mutates the deployment.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="$PATH:$HOME/.cargo/bin"

# The SDK ships as one 1.25 MB minified line with no source map, so an
# unhandled rejection dumps the whole bundle to stderr (BUGS.md B6). Filter
# it, or the screenshot is a megabyte of obfuscated JavaScript instead of the
# error.
filter() { awk 'length($0)<600'; }

banner() {
  echo
  echo "================================================================"
  echo "  SHOT $1 — $2"
  echo "  \$ $3"
  echo "================================================================"
  echo
}

pause() {
  echo
  read -rp ">>> screenshot taken? press Enter for the next one... " _
}

banner 1 "Offline test suite: 7 passing, no network, no tokens" \
        "cd contract-kyb && cargo test"
cd "$ROOT/contract-kyb" && cargo test
pause

banner 2 "Compiled capability set — the imports ARE the capabilities" \
        "wasm-tools component wit z_tenant_kyb.wasm | grep -E 'import|export'"
WASM="$ROOT/contract-kyb/target/wasm32-wasip2/release/z_tenant_kyb.wasm"
wasm-tools validate "$WASM" && echo "wasm-tools validate: clean — $(wc -c < "$WASM") bytes"
wasm-tools component wit "$WASM" | grep -E '^\s*(import|export)'
pause

banner 3 "What is actually deployed (0 tokens, read-only)" \
        "cd agent && npm run state"
cd "$ROOT/agent" && npm run state 2>&1 | filter
pause

banner 4 "Health check — one JSON line, exit 1 if degraded (~20 tokens)" \
        "npm run health"
npm run health 2>&1 | filter
pause

banner 5 "End-to-end suite: verify-vat, verify-lei, kyb-screen, invalid VAT (~250 tokens)" \
        "npm run test-kyb"
npm run test-kyb 2>&1 | filter
pause

banner 6 "Certificate digest recomputed off-chain from the returned JSON" \
        "node -e '...sha256 of the certificate with digest blanked...'"
cat <<'NOTE'
Paste the kyb-screen certificate from SHOT 5 in place of the JSON below —
it changes every run, so this cannot be hardcoded.
NOTE
node -e '
const {createHash} = require("crypto");
const cert = JSON.parse(process.argv[1]);
const unsigned = JSON.stringify({ ...cert, digest: "" });
const recomputed = createHash("sha256").update(unsigned).digest("hex");
console.log("stored certificate:", JSON.stringify(cert).length, "bytes (KV ceiling 508)");
console.log("claimed  digest   :", cert.digest);
console.log("recomputed sha256 :", recomputed);
console.log(recomputed === cert.digest ? "MATCH" : "MISMATCH");
' "${1:-{\"vat_status\":\"UNKNOWN\",\"vat_name\":\"---\",\"lei_registration_status\":\"NOT_PROVIDED\",\"lei_entity_status\":\"NOT_PROVIDED\",\"lei_name\":\"\",\"risk_score\":0,\"risk_level\":\"UNKNOWN\",\"inconclusive\":[\"vat:MS_MAX_CONCURRENT_REQ\"],\"timestamp\":1788251994,\"contract_id\":835,\"digest\":\"22329c9722f76af11fdbb188c7e38a540f0395ab2deb0e7d4fc743532616573a\"}}"
pause

echo
echo "Done. Seven shots: 1 cargo test, 2 capability set, 3 state, 4 health,"
echo "5 test-kyb (covers verify-vat / verify-lei / kyb-screen), 6 digest match."
echo "For the B1 repro screenshot, use the code block in BUGS.md B1 — the"
echo "bisection that found it was run against the earlier tenant and rejected"
echo "writes cost 0 tokens, so it is cheap to re-run if you want a live shot."
