/**
 * B2 live probe — THROWAWAY map only (tail: b2probe). Never touches kyb-results.
 *
 * Sequence (verbatim from BUGS.md B2 repro):
 *   1. create map, writers/readers "all"        → writes work
 *   2. update to { only: [835] }                → writes denied (expected)
 *   3. update back to "all"                     → writes STILL denied (the bug)
 *
 * Cost: ~350 tokens (create 150 + update 70 + update 70 + entrySet attempts).
 * The map is permanently bricked after this — that IS the bug.
 */
import { BASE_UNITS_PER_TOKEN } from "@terminal3/t3n-sdk";
import { openT3nSession } from "./lib/session.js";

const TAIL = "b2probe";

async function main(): Promise<void> {
  const s = await openT3nSession();
  const bal0 = ((await s.t3n.getBalance()) as { available: number }).available;
  console.log(`balance before: ${(bal0 / BASE_UNITS_PER_TOKEN).toFixed(2)} tokens\n`);

  // Step 1: create permissive map
  console.log("=== Step 1: create map with readers/writers 'all' ===");
  try {
    await s.tenant.maps.create({
      tail: TAIL,
      visibility: "private",
      readers: "all",
      writers: "all",
    });
    console.log(`  created ${TAIL} with readers=all, writers=all`);
  } catch (e: unknown) {
    const m = (e as Error).message;
    if (m.includes("already exists")) {
      console.log(`  ${TAIL} already exists — reusing`);
    } else {
      throw e;
    }
  }

  // Step 2: verify write works on permissive map
  console.log("\n=== Step 2: write on permissive map (should succeed) ===");
  try {
    await s.tenant.maps.entrySet(TAIL, "before_narrow", "ok");
    console.log("  entrySet('before_narrow') → ACCEPTED ✓");
  } catch (e: unknown) {
    console.log(`  entrySet('before_narrow') → DENIED: ${(e as Error).message.slice(0, 150)}`);
  }

  // Step 3: narrow the ACL to contract 835 only
  console.log("\n=== Step 3: narrow ACL to { only: [835] } ===");
  await s.tenant.maps.update(TAIL, {
    readers: { only: [835] },
    writers: { only: [835] },
  });
  console.log("  narrowed to { only: [835] }");

  // Step 4: verify write is denied after narrowing (expected behaviour)
  console.log("\n=== Step 4: write after narrowing (should be denied — expected) ===");
  try {
    await s.tenant.maps.entrySet(TAIL, "after_narrow", "should_fail");
    console.log("  entrySet('after_narrow') → ACCEPTED (unexpected!)");
  } catch (e: unknown) {
    console.log(`  entrySet('after_narrow') → DENIED ✓ (expected)`);
  }

  // Step 5: widen back to "all"
  console.log("\n=== Step 5: widen ACL back to readers/writers 'all' ===");
  await s.tenant.maps.update(TAIL, {
    readers: "all",
    writers: "all",
  });
  console.log("  widened back to 'all'");

  // Step 6: THE BUG — write should work again but doesn't
  console.log("\n=== Step 6: write after widening (THE BUG: should work, but doesn't) ===");
  let writeResult: string;
  try {
    await s.tenant.maps.entrySet(TAIL, "after_widen", "should_work");
    writeResult = "ACCEPTED";
    console.log("  entrySet('after_widen') → ACCEPTED");
    console.log("\n  ❌ B2 REFUTED — widening works now, BUGS.md needs updating");
  } catch (e: unknown) {
    writeResult = `DENIED: ${(e as Error).message.slice(0, 150)}`;
    console.log(`  entrySet('after_widen') → DENIED`);
    console.log(`  error: ${(e as Error).message.slice(0, 200)}`);
    console.log("\n  ✓ B2 CONFIRMED — widening is a no-op, the map is permanently bricked");
  }

  const bal1 = ((await s.t3n.getBalance()) as { available: number }).available;
  console.log(`\n=== SUMMARY ===`);
  console.log(`  result: ${writeResult.startsWith("DENIED") ? "B2 REPRODUCES" : "B2 NO LONGER REPRODUCES"}`);
  console.log(`  spent: ${((bal0 - bal1) / BASE_UNITS_PER_TOKEN).toFixed(2)} tokens`);
  console.log(`  balance after: ${(bal1 / BASE_UNITS_PER_TOKEN).toFixed(2)} tokens`);
}

main().catch((e: unknown) => {
  console.error("b2probe crashed:", (e as Error).message);
  process.exitCode = 1;
});
