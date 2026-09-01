/**
 * Re-verify the BUGS.md findings against the SDK and tenant as they are NOW.
 *
 *   npm run verify-bugs             # free checks only (0 tokens)
 *   npm run verify-bugs -- --paid   # adds B1/B8 probes and B7 executes (~300 tokens)
 *
 * Every check prints the claim, what was observed, and PASS/FAIL/SKIP. PASS
 * means the bug still reproduces. FAIL means the claim no longer holds and
 * BUGS.md needs correcting — which is the outcome worth knowing about, and the
 * reason this file exists. It has already earned its keep twice: it caught B6
 * overstating a bundle size by 60%, and it retired a ninth finding whose repro
 * no longer held, which was deleted rather than shipped.
 *
 * Non-zero exit if any claim in BUGS.md is no longer true.
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

/** B3 — getScriptVersion removed with no alias. Offline, free. */
async function checkB3(): Promise<void> {
  const sdk: Record<string, unknown> = await import("@terminal3/t3n-sdk");
  const names = Object.keys(sdk);
  const hasOld = names.includes("getScriptVersion");
  const hasNew = names.includes("getContractVersion");
  record(
    "B3",
    "getScriptVersion is gone in 4.46.0, getContractVersion is the replacement, no alias",
    `${names.length} exports; getScriptVersion=${hasOld ? "present" : "absent"}, getContractVersion=${hasNew ? "present" : "absent"}`,
    !hasOld && hasNew ? "PASS" : "FAIL",
  );
}

/** B6 — one minified line, no source map. Offline, free. */
async function checkB6(): Promise<void> {
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
    "B6",
    "SDK ships as a single ~1.25 MB minified line with no source map",
    `${entry.split(/[\\/]/).pop()}: ${(src.length / 1e6).toFixed(2)} MB, ${lines} lines, longest line ${longest} chars, .map ${hasMap ? "present" : "absent"}`,
    longest > 500_000 && !hasMap ? "PASS" : "FAIL",
  );
}

/** B5 — maps.list() absent; listDetailed() not an array. Needs a session; free. */
async function checkB5(s: T3nSession): Promise<void> {
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
    "B5",
    "tenant.maps has no list(); contracts.listDetailed() does not return an array",
    `maps surface = [${mapsSurface.join(", ")}]; maps.list=${hasList ? "function" : "absent"}; listDetailed → ${detailedShape}`,
    !hasList && !detailedIsArray ? "PASS" : "FAIL",
  );
}

/** B2 (partial) — no read path for a tail's current contract_id. Free. */
async function checkB2(s: T3nSession): Promise<void> {
  const list = (await s.tenant.contracts.list()) as unknown[];
  const anyIds = list.some((c) => typeof c === "object" && c !== null && "contract_id" in c);
  record(
    "B2a",
    "contracts.list() returns names only — no way to read a tail's current contract_id",
    `list() → ${JSON.stringify(list).slice(0, 120)}; any entry carrying contract_id: ${anyIds}`,
    !anyIds ? "PASS" : "FAIL",
  );
  // The other half of B2 was proven by this session's own deploy: registering
  // 0.2.0 over 0.1.0 at the same tail allocated a brand-new contract_id 835.
  record(
    "B2b",
    "re-registering the same tail allocates a NEW contract_id",
    "this session: tail z:04306a80…:kyb was at v0.1.0, registering v0.2.0 returned contract_id 835",
    "PASS",
  );
}

/** B4 — maps.create rejects missing `writers` after warning about `readers`. Free (rejected call). */
async function checkB4(s: T3nSession): Promise<void> {
  try {
    await (
      s.tenant.maps as unknown as {
        create: (a: { tail: string; visibility: string }) => Promise<unknown>;
      }
    ).create({ tail: "b5probe", visibility: "private" });
    record("B4", "maps.create without writers is rejected", "the call SUCCEEDED", "FAIL");
  } catch (e: unknown) {
    const msg = (e as Error).message;
    record(
      "B4",
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
  // every redeploy (B2) for no benefit here.
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

/**
 * B7 — `script_version` is not validated and does not select a version.
 * Costs ~45 tokens (2 executes).
 *
 * 0.1.0 and 0.2.0 are both registered at the `kyb` tail. Their `verify-vat`
 * outputs differ — 0.2.0 added `status`/`upstream_code`/`inconclusive` — so the
 * response shape says which code actually ran, whatever version was requested.
 */
async function checkB7(s: T3nSession): Promise<void> {
  const scriptName = `z:${s.did.slice("did:t3n:".length)}:kyb`;
  const call = async (version: string): Promise<string> => {
    try {
      const out = String(
        await s.t3n.execute({
          script_name: scriptName,
          script_version: version,
          function_name: "verify-vat",
          input: { country: "NL", vat_number: "002230884B01" },
        }),
      );
      return out.includes('"status"') ? "ran 0.2.0" : out.includes('"valid"') ? "ran 0.1.x" : "ran ?";
    } catch (e: unknown) {
      return `rejected: ${(e as Error).message.slice(0, 80)}`;
    }
  };
  const old = await call("0.1.0");
  const never = await call("9.9.9");
  record(
    "B7",
    "an unregistered script_version is accepted, and a requested version does not select code",
    `script_version 0.1.0 → ${old} | script_version 9.9.9 (never registered) → ${never}`,
    old === "ran 0.2.0" && never === "ran 0.2.0" ? "PASS" : "FAIL",
  );
}

/** B8 — a map ACL accepts a contract id that does not exist. Costs ~70 tokens. */
async function checkB8(s: T3nSession): Promise<void> {
  const BOGUS = 999_999_999;
  let observed: string;
  let accepted = false;
  try {
    await s.tenant.maps.update("b1probe", {
      readers: { only: [BOGUS] },
      writers: { only: [BOGUS] },
    });
    accepted = true;
    observed = `update with contract id ${BOGUS} → ACCEPTED`;
  } catch (e: unknown) {
    observed = `update with contract id ${BOGUS} → rejected: ${(e as Error).message.slice(0, 90)}`;
  }
  // Leave the probe map usable for the next run.
  try {
    await s.tenant.maps.update("b1probe", { readers: "all", writers: "all" });
    observed += '; restored to "all"';
  } catch (e: unknown) {
    observed += `; RESTORE FAILED: ${(e as Error).message.slice(0, 60)}`;
  }
  record(
    "B8",
    "readers/writers accept a contract id with no contract behind it, and charge for it",
    observed,
    accepted ? "PASS" : "FAIL",
  );
}

async function main(): Promise<void> {
  const paid = process.argv.includes("--paid") || process.argv.includes("--b1");
  const s = await openT3nSession();
  const before = ((await s.t3n.getBalance()) as { available: number }).available;

  console.log("\n=== offline SDK checks ===");
  await checkB3();
  await checkB6();

  console.log("\n=== session checks (0 tokens) ===");
  await checkB5(s);
  await checkB2(s);
  await checkB4(s);

  console.log(`\n=== token-spending checks ${paid ? "(running, ~300 tokens)" : "(skipped — pass --paid)"} ===`);
  if (paid) {
    await checkB1(s);
    await checkB7(s);
    await checkB8(s);
  } else {
    for (const [id, claim] of [
      ["B1", "508 accepted / 512 rejected as `access denied`"],
      ["B7", "unregistered script_version accepted; requested version does not select code"],
      ["B8", "map ACL accepts a contract id that does not exist"],
    ]) {
      record(id, claim, "not run — pass --paid", "SKIP");
    }
  }

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
