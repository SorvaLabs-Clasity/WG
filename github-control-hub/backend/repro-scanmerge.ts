/**
 * A scoped re-scan must not erase the org-wide result.
 *
 * The webhook path calls runScan with the single repository an event touched.
 * Its result was written straight over the stored row, so one push turned
 * "347 scanned, 42 in violation" into "1 scanned, 0 in violation" and every
 * other repository's findings disappeared from the compliance page.
 */
import { mergeScanResult, type ScanResult } from "./src/services/scannerService";

let failures = 0;
function check(name: string, ok: boolean, got?: unknown) {
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (ok ? "" : ` -> got: ${JSON.stringify(got)}`));
  if (!ok) failures++;
}

const full: ScanResult = {
  scannerId: "s1",
  runAt: "2026-08-01T00:00:00.000Z",
  totalScanned: 3,
  compliantCount: 1,
  nonCompliantCount: 2,
  scannedRepos: ["payments-api", "web-platform", "design-system"],
  violations: [
    { repo: "payments-api", branch: "main", reason: "Branch is not protected" },
    { repo: "web-platform", branch: "main", reason: "Ruleset missing PR requirement" },
  ],
};

// A push to design-system. It is clean, so the scoped run finds nothing.
const clean: ScanResult = {
  scannerId: "s1", runAt: "2026-08-02T00:00:00.000Z",
  totalScanned: 1, compliantCount: 1, nonCompliantCount: 0,
  violations: [], scannedRepos: ["design-system"],
};

const merged = mergeScanResult(full, clean, ["design-system"]);
check("a clean re-scan of one repo keeps the other repositories' findings",
  merged.violations.length === 2, merged.violations);
check("  and does not shrink the coverage",
  merged.totalScanned === 3, merged.totalScanned);
check("  and the violation count is still the truth",
  merged.nonCompliantCount === 2, merged.nonCompliantCount);

// The same repo, now in violation.
const dirty: ScanResult = {
  scannerId: "s1", runAt: "2026-08-02T00:00:00.000Z",
  totalScanned: 1, compliantCount: 0, nonCompliantCount: 1,
  violations: [{ repo: "design-system", branch: "main", reason: "Branch is not protected" }],
  scannedRepos: ["design-system"],
};
const worse = mergeScanResult(full, dirty, ["design-system"]);
check("a new violation on the re-scanned repo is added",
  worse.nonCompliantCount === 3 && worse.violations.length === 3, worse);

// A repo that was in violation and has been fixed loses its row, and only its row.
const fixed: ScanResult = {
  scannerId: "s1", runAt: "2026-08-02T00:00:00.000Z",
  totalScanned: 1, compliantCount: 1, nonCompliantCount: 0,
  violations: [], scannedRepos: ["payments-api"],
};
const repaired = mergeScanResult(full, fixed, ["payments-api"]);
check("a repository that has been fixed drops only its own rows",
  repaired.violations.length === 1 && repaired.violations[0].repo === "web-platform",
  repaired.violations);

// A row written before scannedRepos existed still cannot shrink.
const legacy: ScanResult = { ...full, scannedRepos: undefined };
const fromLegacy = mergeScanResult(legacy, clean, ["design-system"]);
check("a stored result from before this existed keeps its width",
  fromLegacy.totalScanned === 3, fromLegacy.totalScanned);

// The full run's date is what "last scanned" means; a scoped update is its own field.
check("a scoped update does not pretend to be a full run",
  merged.runAt === full.runAt && merged.partialUpdatedAt === clean.runAt,
  { runAt: merged.runAt, partialUpdatedAt: merged.partialUpdatedAt });

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
