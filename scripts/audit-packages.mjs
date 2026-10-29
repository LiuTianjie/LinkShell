#!/usr/bin/env node
// Fails when a package we publish (packages/*) depends on something with a known high or critical
// vulnerability. The app's tree is left out: what `pnpm audit` finds there is Expo's and React Native's
// build tooling, which never reaches a phone and is fixed by upgrading the SDK.
import { execFileSync } from "node:child_process";

// Known and accepted, with the reason. Remove an entry once its fix is released.
const ACCEPTED = new Map([
  // werift 0.22 uses `ip` to format ICE candidates' addresses (toBuffer, toString, isV4Format, isLoopback) and never
  // calls isPublic(), the function at fault. No fixed release of `ip` exists; werift 0.24 no longer depends on it.
  ["GHSA-2p57-rm9w-gvfp", "ip.isPublic is not used by werift"],
]);

let report;
try {
  report = execFileSync("pnpm", ["audit", "--prod", "--json"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
} catch (error) {
  // pnpm exits non-zero whenever it finds anything; the report is still on stdout.
  report = error.stdout;
  if (!report) throw error;
}

const advisories = Object.values(JSON.parse(report).advisories ?? {});
const found = [];
for (const advisory of advisories) {
  if (advisory.severity !== "high" && advisory.severity !== "critical") continue;
  const paths = [...new Set(advisory.findings.flatMap((finding) => finding.paths))].filter((path) => path.startsWith("packages__"));
  if (paths.length === 0) continue;
  const id = advisory.github_advisory_id ?? advisory.url?.split("/").pop();
  if (ACCEPTED.has(id)) continue;
  found.push({ advisory, id, paths });
}

if (found.length === 0) {
  console.log(`audit: no high or critical vulnerabilities in packages/* (${advisories.length} advisories in the whole workspace, ${ACCEPTED.size} accepted)`);
  process.exit(0);
}
for (const { advisory, id, paths } of found) {
  console.log(`\n${advisory.severity.toUpperCase()}  ${advisory.module_name}  ${advisory.title}`);
  console.log(`  ${id}: vulnerable ${advisory.vulnerable_versions}, fixed in ${advisory.patched_versions}`);
  for (const path of paths.slice(0, 5)) console.log(`  ${path.replaceAll(">", " > ")}`);
  if (paths.length > 5) console.log(`  … and ${paths.length - 5} more paths`);
}
console.log(`\naudit: ${found.length} high or critical vulnerabilities in packages/*. Update the dependency (pnpm update <name>), or accept it in scripts/audit-packages.mjs with the reason.`);
process.exit(1);
