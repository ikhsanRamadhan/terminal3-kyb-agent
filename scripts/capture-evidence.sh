#!/usr/bin/env bash
# Capture every screenshot the submission needs, in one pass, in order.
#
#   ./scripts/capture-evidence.sh
#
# Each shot is numbered to match a [SCREENSHOT: ...] placeholder in
# docs/GOOGLE-DOC-DRAFT.md, so there is no guessing about which capture goes
# where. Prints a self-labelling banner, then pauses — press Enter when you
# have the shot.
#
# Cost: ~700 tokens total.
#   free   : cargo test, wasm validate, state, verify-bugs (offline+session part)
#   ~20    : health
#   ~250   : test-kyb (4 calls)
#   ~360   : verify-bugs --paid (B1 write, B7 executes, B8 ACL update)
#   ~70    : B1 key/value boundary re-run
# Nothing here mutates the live deployment. The paid probes touch only the
# throwaway b1probe map.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="$PATH:$HOME/.cargo/bin"
WASM="$ROOT/contract-kyb/target/wasm32-wasip2/release/z_tenant_kyb.wasm"

# The SDK ships as one 1.25 MB minified line with no source map, so an
# unhandled rejection dumps the whole bundle to stderr (BUGS.md B6). Filter it,
# or the screenshot is a megabyte of obfuscated JavaScript instead of the error.
filter() { awk 'length($0)<600'; }

banner() {
  echo
  echo "================================================================"
  echo "  SHOT $1 — doc placeholder: $2"
  echo "  \$ $3"
  echo "================================================================"
  echo
}

pause() {
  echo
  read -rp ">>> shot captured? press Enter for the next one... " _
}

# ---------------------------------------------------------------- §7, §0
banner 1 "cargo test — 7 passed + 1 doc-test" \
        "cd contract-kyb && cargo test"
cd "$ROOT/contract-kyb" && cargo test
pause

# ---------------------------------------------------------------- §2.5
banner 2 "cargo build + wasm-tools validate, artifact size" \
        "cargo build --target wasm32-wasip2 --release && wasm-tools validate"
cargo build --target wasm32-wasip2 --release
wasm-tools validate "$WASM" && echo "wasm-tools validate: clean"
echo "artifact: $(wc -c < "$WASM") bytes"
echo
echo "declared world exports:"
wasm-tools component wit "$WASM" | grep -E '^\s*(import|export)' | head -25
pause

# ---------------------------------------------------------------- §2.3
banner 3 "npm run state — tenant DID, contract 835, live_script_version, balance" \
        "cd agent && npm run state"
cd "$ROOT/agent" && npm run state 2>&1 | filter
pause

# ---------------------------------------------------------------- §7
banner 4 "npm run health — healthy=true" \
        "npm run health"
npm run health 2>&1 | filter
pause

# ---------------------------------------------------------------- §11, §3, §4
banner 5 "full npm run test-kyb output — 4/4 (also covers the verify-vat and kyb-screen shots)" \
        "npm run test-kyb"
npm run test-kyb 2>&1 | filter
pause

# ---------------------------------------------------------------- §6
banner 6 "certificate digest recomputed off-chain — MATCH" \
        "node -e '...sha256 of the certificate with digest blanked...'"
cat <<'NOTE'
Paste the kyb-screen certificate from SHOT 5 as the first argument to this
script to verify that exact run. With no argument it re-verifies the
certificate quoted in the doc, which is a real one from this deployment.
NOTE
echo
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

# ---------------------------------------------------------------- §8
banner 7 "npm run verify-bugs — all eight findings PASS" \
        "npm run verify-bugs -- --paid"
npm run verify-bugs -- --paid 2>&1 | filter
pause

# ---------------------------------------------------------------- §8, B1
banner 8 "B1 — access denied at 512 bytes beside the correct key-size error" \
        "npm run hunt -- --paid   (key limit) + verify-bugs B1 row above"
cat <<'NOTE'
This is the single most important shot in the report. It needs BOTH errors
visible together: the value-size rejection that blames permissions, and the
key-size rejection that names the limit correctly. The hunt probe prints the
key-length boundary; the B1 row in SHOT 7 above printed the value boundary.
Capture them in one frame if your terminal scrollback allows.
NOTE
echo
npm run hunt -- --paid 2>&1 | filter | sed -n '/H5/,$p'
pause

# ---------------------------------------------------------------- §8, B7
banner 9 "B7 — script_version 9.9.9 returning a successful 0.2.0 response" \
        "npm run hunt -- --shadow"
npm run hunt -- --shadow 2>&1 | filter | sed -n '/version-shadowing/,$p'
pause

echo
cat <<'DONE'
================================================================
Done — nine shots, mapped to the doc's placeholders:

  1  cargo test                 → §7 "cargo test — 7 passed + 1 doc-test"
  2  build + validate           → §2.5 "cargo build + wasm-tools validate"
  3  npm run state              → §2.3 "npm run state"
  4  npm run health             → §7 "npm run health — healthy=true"
  5  npm run test-kyb           → §11 "full test-kyb output", and reuse the
                                  same frame for §3 verify-vat and §4 kyb-screen
  6  digest recompute           → §6 (no placeholder; strengthens the MATCH claim)
  7  verify-bugs --paid         → §8 "all eight PASS"
  8  B1 key vs value errors     → §8 "access denied at 512 beside key-size error"
  9  B7 script_version 9.9.9    → §8 "9.9.9 returning a 0.2.0 response"

Before inserting any of them: re-read every frame for the API key, and crop
anything that is not the command and its output.
================================================================
DONE
