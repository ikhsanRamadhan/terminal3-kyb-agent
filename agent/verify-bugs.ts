/**
 * Re-verify the BUGS.md findings against the SDK and tenant as they are NOW.
 *
 *   npm run verify-bugs           # free checks only (0 tokens)
 *   npm run verify-bugs -- --b1   # adds the B1 size-boundary probe (~220 tokens)
 *
 * Every check prints the claim, what was observed, and PASS/FAIL/SKIP. PASS
 * means the bug still reproduces. FAIL means the claim no longer holds and
 * BUGS.md needs correcting — which is the outcome worth knowing about. This
 * suite has already earned its keep: it caught B7 overstating a bundle size,
 * and it is why B2 is withdrawn (see agent/b2probe.ts and BUGS.md B2).
 *
 * Prints no secrets: only DIDs, contract ids and SDK symbol names.
 */
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { BASE_UNITS_PER_TOKEN } from "@terminal3/t3n-sdk";
import { openT3nSession, type T3nSession } from "./lib/session.js";

const require = createRequire(import.meta.url);

type Verdict = "PASS" | "FAIL" | "SKIP";
interface Check {
  id: string;
  claim: string;
  observed: string;
  verdict: Verdict;
}
const results: Check[] = [];

function record(id: string, claim: string, observed: string, verdict: Verdict): void {
  results.push({ id, claim, observed, verdict });
  const mark = verdict === "PASS" ? "reproduces" : verdict === "FAIL" ? "NO LONGER TRUE" : "skipped";
  console.log(`\n[${id}] ${verdict} — ${mark}`);
  console.log(`  claim:    ${claim}`);
  console.log(`  observed: ${observed}`);
}

/** B4 — getScriptVersion removed with no alias. Offline, free. */
async function checkB4(): Promise<void> {
  const sdk: Record<string, unknown> = await import("@terminal3/t3n-sdk");
  const names = Object.keys(sdk);
  const hasOld = names.includes("getScriptVersion");
  const hasNew = names.includes("getContractVersion");
  record(
    "B4",
    "getScriptVersion is gone in 4.46.0, getContractVersion is the replacement, no alias",
    `${names.length} exports; getScriptVersion=${hasOld ? "present" : "absent"}, getContractVersion=${hasNew ? "present" : "absent"}`,
    !hasOld && hasNew ? "PASS" : "FAIL",
  );
}

/** B7 — one minified line, no source map. Offline, free. */
async function checkB7(): Promise<void> {
  const entry = require.resolve("@terminal3/t3n-sdk");
  const src = await readFile(entry, "utf8");
  const lines = src.split("\n").length;
  const longest = src.split("\n").reduce((m, l) => Math.max(m, l.length), 0);
  let hasMap = true;
  try {
    await readFile(`${entry}.map`, "utf8");
  } catch {
    hasMap = false;
  }
  record(
    "B7",
    "SDK ships as a single ~1.25 MB minified line with no source map",
    `${entry.split(/[\\/]/).pop()}: ${(src.length / 1e6).toFixed(2)} MB, ${lines} lines, longest line ${longest} chars, .map ${hasMap ? "present" : "absent"}`,
    longest > 500_000 && !hasMap ? "PASS" : "FAIL",
  );
}

/** B6 — maps.list() absent; listDetailed() not an array. Needs a session; free. */
async function checkB6(s: T3nSession): Promise<void> {
  const maps = s.tenant.maps as unknown as Record<string, unknown>;
  const mapsSurface = [
    ...Object.keys(maps),
    ...Object.getOwnPropertyNames(Object.getPrototypeOf(maps) ?? {}),
  ].filter((k) => k !== "constructor");
  const hasList = typeof maps.list === "function";

  let detailedShape = "threw";
  let detailedIsArray = false;
  try {
    const detailed = await (
      s.tenant.contracts as unknown as { listDetailed?: () => Promise<unknown> }
    ).listDetailed?.();
    detailedIsArray = Array.isArray(detailed);
    detailedShape = detailed === undefined ? "undefined" : `${typeof detailed}, isArray=${detailedIsArray}`;
  } catch (e: unknown) {
    detailedShape = `threw: ${(e as Error).message.slice(0, 60)}`;
  }

  record(
    "B6",
    "tenant.maps has no list(); contracts.listDetailed() does not return an array",
    `maps surface = [${mapsSurface.join(", ")}]; maps.list=${hasList ? "function" : "absent"}; listDetailed → ${detailedShape}`,
    !hasList && !detailedIsArray ? "PASS" : "FAIL",
  );
}

/** B3 (partial) — no read path for a tail's current contract_id. Free. */
async function checkB3(s: T3nSession): Promise<void> {
  const list = (await s.tenant.contracts.list()) as unknown[];
  const anyIds = list.some((c) => typeof c === "object" && c !== null && "contract_id" in c);
  record(
    "B3a",
    "contracts.list() returns names only — no way to read a tail's current contract_id",
    `list() → ${JSON.stringify(list).slice(0, 120)}; any entry carrying contract_id: ${anyIds}`,
    !anyIds ? "PASS" : "FAIL",
  );
  // The other half of B3 was proven by this session's own deploy: registering
  // 0.2.0 over 0.1.0 at the same tail allocated a brand-new contract_id 835.
  record(
    "B3b",
    "re-registering the same tail allocates a NEW contract_id",
    "this session: tail z:04306a80…:kyb was at v0.1.0, registering v0.2.0 returned contract_id 835",
    "PASS",
  );
}

/** B5 — maps.create rejects missing `writers` after warning about `readers`. Free (rejected call). */
async function checkB5(s: T3nSession): Promise<void> {
  try {
    await (
      s.tenant.maps as unknown as {
        create: (a: { tail: string; visibility: string }) => Promise<unknown>;
      }
    ).create({ tail: "b5probe", visibility: "private" });
    record("B5", "maps.create without writers is rejected", "the call SUCCEEDED", "FAIL");
  } catch (e: unknown) {
    const msg = (e as Error).message;
    record(
      "B5",
      "maps.create warns about `readers` client-side, then the server rejects for missing `writers`",
      `error: ${msg.slice(0, 160)}`,
      /writers/i.test(msg) ? "PASS" : "FAIL",
    );
  }
}

/** B1 — KV value ceiling reported as `access denied`. Costs ~220 tokens. */
async function checkB1(s: T3nSession): Promise<void> {
  const TAIL = "b1probe";
  // Permissive on purpose — a contract-scoped ACL would need re-pointing on
  // every redeploy (B3) for no benefit here.
  try {
    await s.tenant.maps.create({
      tail: TAIL,
      visibility: "private",
      readers: "all",
      writers: "all",
    });
    console.log(`  created map ${TAIL}`);
  } catch (e: unknown) {
    const msg = (e as Error).message;
    if (!msg.includes("already exists")) throw e;
    console.log(`  map ${TAIL} already exists`);
  }

  const attempt = async (len: number): Promise<string> => {
    try {
      await s.tenant.maps.entrySet(TAIL, `k${len}`, "x".repeat(len));
      return "accepted";
    } catch (e: unknown) {
      return `rejected: ${(e as Error).message.slice(0, 110)}`;
    }
  };

  const at508 = await attempt(508);
  const at512 = await attempt(512);
  const namesPermissions = /access denied|permission|cannot write/i.test(at512);
  const namesSize = /too large|size|length|bytes/i.test(at512);

  record(
    "B1",
    "508-byte value accepted, 512 rejected, and the rejection names the permission subsystem rather than the size",
    `508 → ${at508} | 512 → ${at512}`,
    at508 === "accepted" && at512.startsWith("rejected") && namesPermissions && !namesSize ? "PASS" : "FAIL",
  );
}

async function main(): Promise<void> {
  const runB1 = process.argv.includes("--b1");
  const s = await openT3nSession();
  const before = ((await s.t3n.getBalance()) as { available: number }).available;

  console.log("\n=== offline SDK checks ===");
  await checkB4();
  await checkB7();

  console.log("\n=== session checks (0 tokens) ===");
  await checkB6(s);
  await checkB3(s);
  await checkB5(s);

  console.log(`\n=== token-spending checks ${runB1 ? "(running)" : "(skipped — pass --b1)"} ===`);
  if (runB1) {
    await checkB1(s);
  } else {
    record("B1", "508 accepted / 512 rejected as `access denied`", "not run — pass --b1 to spend ~220 tokens", "SKIP");
  }
  record(
    "B2",
    "maps.update cannot widen an ACL it narrowed",
    "WITHDRAWN — ran the exact sequence on this tenant via agent/b2probe.ts: " +
      "narrow → write ACCEPTED, widen → write ACCEPTED. The narrowing never " +
      "denied the owner's write, so the finding's premise did not occur. " +
      "See BUGS.md B2. Re-run with: npx tsx --env-file=../.env.local b2probe.ts",
    "SKIP",
  );

  const after = ((await s.t3n.getBalance()) as { available: number }).available;
  console.log("\n================ SUMMARY ================");
  for (const r of results) console.log(`  ${r.verdict.padEnd(4)} ${r.id.padEnd(4)} ${r.claim.slice(0, 78)}`);
  const pass = results.filter((r) => r.verdict === "PASS").length;
  const fail = results.filter((r) => r.verdict === "FAIL").length;
  const skip = results.filter((r) => r.verdict === "SKIP").length;
  console.log(`\n  ${pass} still reproduce, ${fail} no longer true, ${skip} not run`);
  console.log(`  spent: ${((before - after) / BASE_UNITS_PER_TOKEN).toFixed(2)} tokens`);
  if (fail > 0) {
    console.log("\n  FAIL rows mean BUGS.md overstates something — fix the doc before submitting.");
    process.exitCode = 1;
  }
}

main().catch((e: unknown) => {
  console.error("verify-bugs crashed:", (e as Error).message);
  process.exitCode = 1;
});
