#!/usr/bin/env node
// Fails on any high/critical npm advisory except an explicit, reviewed allowlist.
// See docs/DECISIONS.md D-066 for the rationale behind each allowed entry.
import { execFileSync } from "node:child_process";

const ALLOWED_ADVISORIES = new Map([
  [
    "GHSA-qwww-vcr4-c8h2",
    "React Router RSC Mode CSRF bypass: this app only uses client-side " +
      "BrowserRouter (declarative mode); RSC/framework/server-action mode is " +
      "never enabled, so the vulnerable code path is unreachable. No fixed " +
      "react-router-dom release exists on the 7.x line; downgrading below " +
      "7.12.0 reintroduces ten other unpatched high-severity advisories.",
  ],
]);

const FAIL_SEVERITIES = new Set(["high", "critical"]);

// `via` mixes direct advisory objects with plain package-name strings that
// point at another entry in `vulnerabilities` for the real advisory. Resolve
// those transitively (bounded by `seen`) to collect every root advisory id.
function advisoryIdsFor(name, vulnerabilitiesByName, seen = new Set()) {
  if (seen.has(name)) {
    return [];
  }
  seen.add(name);
  const vulnerability = vulnerabilitiesByName.get(name);
  if (!vulnerability) {
    return [];
  }
  const ids = [];
  for (const entry of vulnerability.via ?? []) {
    if (typeof entry === "object" && entry !== null) {
      const id = entry.url?.split("/").pop();
      if (id) {
        ids.push(id);
      }
    } else if (typeof entry === "string") {
      ids.push(...advisoryIdsFor(entry, vulnerabilitiesByName, seen));
    }
  }
  return ids;
}

let report;
try {
  const raw = execFileSync("npm", ["audit", "--json"], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 16,
  });
  report = JSON.parse(raw);
} catch (error) {
  // npm audit exits non-zero when vulnerabilities are found; stdout still has the JSON report.
  const stdout = error.stdout;
  if (!stdout) {
    console.error("npm audit did not produce JSON output.");
    console.error(error.message);
    process.exit(1);
  }
  report = JSON.parse(stdout);
}

const vulnerabilitiesByName = new Map(Object.entries(report.vulnerabilities ?? {}));
const unexpected = [];

for (const vulnerability of vulnerabilitiesByName.values()) {
  if (!FAIL_SEVERITIES.has(vulnerability.severity)) {
    continue;
  }
  const advisoryIds = advisoryIdsFor(vulnerability.name, vulnerabilitiesByName);
  const allAllowed =
    advisoryIds.length > 0 && advisoryIds.every((id) => ALLOWED_ADVISORIES.has(id));
  if (!allAllowed) {
    unexpected.push({ name: vulnerability.name, severity: vulnerability.severity, advisoryIds });
  }
}

if (unexpected.length > 0) {
  console.error("Unreviewed high/critical npm advisories found:");
  for (const entry of unexpected) {
    console.error(
      `  - ${entry.name} (${entry.severity}): ${entry.advisoryIds.join(", ") || "no advisory id"}`,
    );
  }
  console.error("\nRun `npm audit` for full details, then either fix the dependency or add a");
  console.error(
    "reviewed, justified allowlist entry to scripts/check-audit.mjs and docs/DECISIONS.md.",
  );
  process.exit(1);
}

console.log("npm audit: no unreviewed high/critical advisories.");
for (const [id, reason] of ALLOWED_ADVISORIES) {
  console.log(`  Reviewed exception in effect: ${id} — ${reason}`);
}
