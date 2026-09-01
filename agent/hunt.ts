/**
 * Exploratory probe suite — the tool that looked for findings beyond the ones
 * already in BUGS.md. Two of these graduated into the report: H5 became B8
 * (ACLs accept contract ids that do not exist) and H7 became B7
 * (`script_version` is not validated). Both now also live in verify-bugs.ts,
 * which is the regression suite; this file is the discovery log, and it keeps
 * the negative results too, because "we checked and it was fine" is worth as
 * much to a reader as a finding.
 *
 *   npm run hunt              # free probes only (0 tokens)
 *   npm run hunt -- --paid    # adds the ACL and key-length probes (~210 tokens)
 *   npm run hunt -- --shadow  # adds the version/routing executes (~90 tokens)
 *
 * Each probe prints what it tried, what came back, and a verdict:
 *   FINDING — behaviour is wrong or undocumented, worth filing
 *   OK      — behaves as documented, or as it should
 *   INFO    — captured for the record, not a bug
 *
 * Touches only the throwaway b1probe map. Never writes kyb-results.
 * Prints no secrets.
 */
import { getContractVersion, BASE_UNITS_PER_TOKEN } from "@terminal3/t3n-sdk";
import { openT3nSession, type T3nSession } from "./lib/session.js";

type Verdict = "FINDING" | "OK" | "INFO";
const rows: Array<{ id: string; verdict: Verdict; note: string }> = [];

function report(id: string, verdict: Verdict, tried: string, observed: string, note: string): void {
  rows.push({ id, verdict, note });
  console.log(`\n[${id}] ${verdict}`);
  console.log(`  tried:    ${tried}`);
  console.log(`  observed: ${observed}`);
  if (note) console.log(`  note:     ${note}`);
}

function msg(e: unknown): string {
  return (e as Error).message.replace(/\s+/g, " ").slice(0, 220);
}

/** H1 — is the claims digest we commit actually retrievable from the activity log? */
async function huntActivityLog(s: T3nSession): Promise<void> {
  const log = (await s.t3n.getActivityLog()) as unknown;
  const asText = JSON.stringify(log);
  const entries = Array.isArray(log) ? log : (log as { entries?: unknown[] })?.entries;
  const count = Array.isArray(entries) ? entries.length : -1;
  // A committed claims digest is 32 bytes -> 64 hex chars.
  const digests = asText.match(/[0-9a-f]{64}/g) ?? [];
  const keys =
    Array.isArray(entries) && entries.length > 0 && typeof entries[0] === "object"
      ? Object.keys(entries[0] as object).join(", ")
      : "n/a";

  report(
    "H1",
    digests.length === 0 ? "FINDING" : "OK",
    "getActivityLog() — looking for the claims digests kyb-screen commits via set_claims_digest",
    `payload ${asText.length} chars, ${count} entries, entry keys = [${keys}], ${digests.length} 64-hex-char strings present`,
    digests.length === 0
      ? "No 64-hex digest anywhere in the activity log. The audit trail this contract advertises may not be readable back through this API."
      : "Digests are present and readable — the verifiability claim holds.",
  );
  if (digests.length === 0) {
    console.log(`  payload head: ${asText.slice(0, 400)}`);
  }
}

/** H2 — which version does the node resolve when several are registered at one tail? */
async function huntVersionResolution(s: T3nSession): Promise<void> {
  const tenantId = s.did.slice("did:t3n:".length);
  const scriptName = `z:${tenantId}:kyb`;
  const resolved = await getContractVersion(s.baseUrl, scriptName);
  report(
    "H2",
    resolved === "0.2.0" ? "OK" : "FINDING",
    `getContractVersion("${scriptName}") with 0.1.0 and 0.2.0 both registered at this tail`,
    `resolved → ${resolved}`,
    resolved === "0.2.0"
      ? "Resolves to the newest version, as expected."
      : `Resolves to ${resolved}, NOT the newest registered version. A deploy would look successful while calls keep hitting old code.`,
  );
}

/**
 * H3 — what does getStatus do for a map that does not exist?
 *
 * Returning a value beats throwing here: it gives the tenant a way to test map
 * existence by name, which is the one piece of storage introspection that does
 * work (BUGS.md B5 says so). Only an *error* that fails to name the map it
 * failed on would be a finding.
 */
async function huntMissingMap(s: T3nSession): Promise<void> {
  let observed: string;
  let threw = false;
  try {
    const st = await s.tenant.maps.getStatus("definitely_not_a_real_map_xyz");
    observed = `returned ${JSON.stringify(st)} — no error`;
  } catch (e: unknown) {
    threw = true;
    observed = `threw: ${msg(e)}`;
  }
  const namesTheMap = /definitely_not_a_real_map_xyz/.test(observed);
  report(
    "H3",
    !threw ? "INFO" : namesTheMap ? "OK" : "FINDING",
    'maps.getStatus("definitely_not_a_real_map_xyz")',
    observed,
    !threw
      ? 'Reports absence as a value rather than an exception, so map existence IS testable by name. Enumeration still is not (B5).'
      : namesTheMap
        ? "Error identifies the map — actionable."
        : "Error does not name the map it failed on.",
  );
}

/**
 * H9 — B1 in a single frame: the same call, two size limits, two different
 * standards of error message.
 *
 * This is the report's headline evidence, so it is worth printing both
 * boundaries adjacently rather than asking a reader to hold two screenshots
 * side by side. Costs ~140 tokens: the two accepted writes are charged, the two
 * rejections are free.
 */
async function huntB1SideBySide(s: T3nSession): Promise<void> {
  const TAIL = "b1probe";
  const write = async (key: string, value: string): Promise<string> => {
    try {
      await s.tenant.maps.entrySet(TAIL, key, value);
      return "accepted";
    } catch (e: unknown) {
      return `rejected: ${msg(e)}`;
    }
  };

  const key256 = await write("k".repeat(256), "v");
  const key1024 = await write("k".repeat(1024), "v");
  const val508 = await write("size508", "x".repeat(508));
  const val512 = await write("size512", "x".repeat(512));

  console.log("\n  === B1: one call, two size limits ===");
  console.log(`  key    256 bytes → ${key256}`);
  console.log(`  key   1024 bytes → ${key1024}`);
  console.log(`  value  508 bytes → ${val508}`);
  console.log(`  value  512 bytes → ${val512}`);
  console.log("");
  console.log("  The key path names the field, the limit and the actual value.");
  console.log("  The value path blames the permission subsystem instead.");

  const keyNamesSize = /key exceeds|bytes \(got/i.test(key1024);
  const valBlamesPerms = /access denied|cannot write/i.test(val512);
  report(
    "H9",
    keyNamesSize && valBlamesPerms ? "FINDING" : "OK",
    "entrySet with an oversized key and an oversized value, on the same map",
    `key 1024 → ${key1024.slice(0, 120)}\n            value 512 → ${val512.slice(0, 120)}`,
    keyNamesSize && valBlamesPerms
      ? "Confirms B1 with the platform's own control case: the same endpoint reports one size limit correctly and the other as a permissions failure."
      : "The two paths now report size errors consistently.",
  );
}

/** H4 — error shape for a key that does not exist in a map that does. */
async function huntMissingKey(s: T3nSession): Promise<void> {
  let observed: string;
  try {
    const v = await s.tenant.maps.entryGet("b1probe", "no_such_key_xyz");
    observed = `returned ${JSON.stringify(v)}`;
  } catch (e: unknown) {
    observed = `threw: ${msg(e)}`;
  }
  report(
    "H4",
    /access denied|permission/i.test(observed)
      ? "FINDING"
      : "OK",
    'maps.entryGet("b1probe", "no_such_key_xyz") — absent key in an existing map',
    observed,
    /access denied|permission/i.test(observed)
      ? "A missing key is reported as a permission failure — same mis-signalling class as B1."
      : "Distinguishable from a permission error.",
  );
}

/** H5 — does an ACL accept a contract id that does not exist on this tenant? Costs ~70. */
async function huntBogusAclId(s: T3nSession): Promise<void> {
  const BOGUS = 999_999_999;
  let updateResult: string;
  try {
    await s.tenant.maps.update("b1probe", {
      readers: { only: [BOGUS] },
      writers: { only: [BOGUS] },
    });
    updateResult = "ACCEPTED";
  } catch (e: unknown) {
    updateResult = `rejected: ${msg(e)}`;
  }
  // Put it back permissive so the probe map stays usable.
  let restored = "ok";
  try {
    await s.tenant.maps.update("b1probe", { readers: "all", writers: "all" });
  } catch (e: unknown) {
    restored = `FAILED: ${msg(e)}`;
  }
  report(
    "H5",
    updateResult === "ACCEPTED" ? "FINDING" : "OK",
    `maps.update("b1probe", { readers/writers: { only: [${BOGUS}] } }) — an id with no contract behind it`,
    `update → ${updateResult}; restore to "all" → ${restored}`,
    updateResult === "ACCEPTED"
      ? "A non-existent contract id is accepted into an ACL and charged for. Combined with there being no API to read an ACL back, a typo in a deploy script is undetectable until the contract's next write fails."
      : "Ids are validated at update time.",
  );
}

/** H6 — is there a KEY length limit, and does its error name the size? Rejects are free. */
async function huntKeyLimit(s: T3nSession): Promise<void> {
  const attempt = async (len: number): Promise<string> => {
    try {
      await s.tenant.maps.entrySet("b1probe", "k".repeat(len), "v");
      return "accepted";
    } catch (e: unknown) {
      return `rejected: ${msg(e)}`;
    }
  };
  const at256 = await attempt(256);
  const at1024 = await attempt(1024);
  const at4096 = await attempt(4096);
  const firstReject = [
    ["256", at256],
    ["1024", at1024],
    ["4096", at4096],
  ].find(([, r]) => r.startsWith("rejected"));
  report(
    "H6",
    firstReject === undefined
      ? "OK"
      : /size|length|too large|bytes/i.test(String(firstReject[1]))
        ? "INFO"
        : "FINDING",
    "maps.entrySet with keys of 256 / 1024 / 4096 bytes against a 1-byte value",
    `256 → ${at256} | 1024 → ${at1024} | 4096 → ${at4096}`,
    firstReject === undefined
      ? "No key-length ceiling found up to 4096 bytes — so the 508-byte ceiling in B1 really is value-only, confirmed from the other direction."
      : `First rejection at ${firstReject[0]} bytes. Error names the size: ${/size|length|too large|bytes/i.test(String(firstReject[1]))}`,
  );
}

/**
 * H7 — is a superseded contract version still callable, with its capabilities?
 *
 * 0.1.0 and 0.2.0 are both registered at the `kyb` tail. 0.2.0 is what the node
 * resolves (H2). The question is whether 0.1.0 — the code whose VAT handling was
 * wrong enough to justify a redeploy — is still reachable by explicit version,
 * and whether it still holds the egress grant. If it is, "redeploy to fix a bug"
 * does not retire the bug: every caller can still select the old logic.
 */
async function huntVersionShadowing(s: T3nSession): Promise<void> {
  const tenantId = s.did.slice("did:t3n:".length);
  const scriptName = `z:${tenantId}:kyb`;
  const input = { country: "NL", vat_number: "002230884B01" };

  const call = async (version: string): Promise<string> => {
    try {
      const out = await s.t3n.execute({
        script_name: scriptName,
        script_version: version,
        function_name: "verify-vat",
        input,
      });
      const text = String(out);
      // 0.1.0 returns `valid`; 0.2.0 returns `status`. The shape tells us which
      // code actually ran, independently of what version we asked for.
      const shape = text.includes('"status"')
        ? "0.2.0 shape (status)"
        : text.includes('"valid"')
          ? "0.1.x shape (valid, no status)"
          : "unrecognised";
      return `OK — ${shape} — ${text.slice(0, 110)}`;
    } catch (e: unknown) {
      return `threw: ${msg(e)}`;
    }
  };

  const old = await call("0.1.0");
  const bogus = await call("9.9.9");

  const oldRuns = old.startsWith("OK");
  const oldIsOldCode = old.includes("0.1.x shape");
  const bogusRuns = bogus.startsWith("OK");
  report(
    "H7",
    !oldRuns ? "OK" : "FINDING",
    `execute verify-vat at explicit script_version 0.1.0 (superseded) and 9.9.9 (never registered)`,
    `0.1.0 → ${old}\n            9.9.9 → ${bogus}`,
    !oldRuns
      ? "The superseded version is not callable — redeploy really does retire the old code."
      : oldIsOldCode
        ? "The superseded version is still callable AND still runs its own old logic, egress grant intact. A redeploy does not retire a bug; it only changes the default."
        : `script_version is ignored: 0.1.0 returned 0.2.0's response shape${bogusRuns ? ", and so did a version (9.9.9) that was never registered" : ""}. A caller cannot pin a version and cannot tell that it did not get the one it asked for.`,
  );
}

/**
 * H8 — do bogus function and script names fail loudly?
 *
 * H7 showed script_version is not validated. The obvious follow-up is whether
 * the other two routing fields are.
 */
async function huntBogusRouting(s: T3nSession): Promise<void> {
  const tenantId = s.did.slice("did:t3n:".length);
  const scriptName = `z:${tenantId}:kyb`;

  const call = async (script: string, fn: string): Promise<string> => {
    try {
      const out = await s.t3n.execute({
        script_name: script,
        script_version: "0.2.0",
        function_name: fn,
        input: { country: "NL", vat_number: "002230884B01" },
      });
      return `OK (!) → ${String(out).slice(0, 90)}`;
    } catch (e: unknown) {
      return `threw: ${msg(e)}`;
    }
  };

  const badFn = await call(scriptName, "no-such-function");
  const badScript = await call(`z:${tenantId}:no-such-tail`, "verify-vat");
  const bothFail = !badFn.startsWith("OK") && !badScript.startsWith("OK");
  report(
    "H8",
    bothFail ? "OK" : "FINDING",
    'execute with function_name "no-such-function", and with an unregistered script tail',
    `bad function → ${badFn}\n            bad tail → ${badScript}`,
    bothFail
      ? "Both are rejected — function and script names are validated even though script_version is not (H7)."
      : "A bogus routing field was accepted.",
  );
}

async function main(): Promise<void> {
  const paid = process.argv.includes("--paid");
  const shadow = process.argv.includes("--shadow");
  const b1 = process.argv.includes("--b1");
  const s = await openT3nSession();
  const before = ((await s.t3n.getBalance()) as { available: number }).available;

  console.log("\n=== free probes (0 tokens) ===");
  await huntActivityLog(s);
  await huntVersionResolution(s);
  await huntMissingMap(s);
  await huntMissingKey(s);

  console.log(`\n=== paid probes ${paid ? "(running)" : "(skipped — pass --paid)"} ===`);
  if (paid) {
    await huntBogusAclId(s);
    await huntKeyLimit(s);
  }

  console.log(`\n=== B1 side-by-side ${b1 ? "(running, ~140 tokens)" : "(skipped — pass --b1)"} ===`);
  if (b1) {
    await huntB1SideBySide(s);
  }

  console.log(`\n=== version-shadowing probe ${shadow ? "(running, ~80 tokens)" : "(skipped — pass --shadow)"} ===`);
  if (shadow) {
    await huntVersionShadowing(s);
    await huntBogusRouting(s);
  }

  const after = ((await s.t3n.getBalance()) as { available: number }).available;
  console.log("\n================ HUNT SUMMARY ================");
  for (const r of rows) console.log(`  ${r.verdict.padEnd(7)} ${r.id.padEnd(3)} ${r.note.slice(0, 90)}`);
  console.log(`\n  ${rows.filter((r) => r.verdict === "FINDING").length} candidate findings`);
  console.log(`  spent: ${((before - after) / BASE_UNITS_PER_TOKEN).toFixed(2)} tokens`);
}

main().catch((e: unknown) => {
  console.error("hunt crashed:", msg(e));
  process.exitCode = 1;
});
