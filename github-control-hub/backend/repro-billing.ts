/**
 * Actions and storage usage, summarised per repository.
 *
 * The arithmetic is sums over rows, which is the kind of thing that looks
 * obviously right and is quietly wrong. Three specific ways:
 *
 *   - usage GitHub cannot attribute arrives with repositoryName: "". Dropping
 *     it makes the total disagree with GitHub's bill; folding it into a
 *     repository invents a fact. It gets its own row.
 *   - money is floats. 0.1 + 0.2 printed on a page about spend reads as a bug
 *     in the numbers rather than in the formatting.
 *   - the same row can come back under two requested months, and counting it
 *     twice overstates spend.
 */
import { summarise, UNATTRIBUTED, type UsageItem } from "./src/services/billingService";

let failures = 0;
function check(name: string, ok: boolean, got?: unknown) {
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (ok ? "" : ` -> got: ${JSON.stringify(got)}`));
  if (!ok) failures++;
}

const item = (over: Partial<UsageItem>): UsageItem => ({
  date: "2026-08-01T00:00:00Z", product: "actions", sku: "Actions Linux",
  quantity: 10, unitType: "Minutes", pricePerUnit: 0.008,
  grossAmount: 0.08, discountAmount: 0, netAmount: 0.08,
  organizationName: "Org", repositoryName: "repo-a", ...over,
});

// ── unattributed usage is kept, not hidden ────────────────────────────
{
  const s = summarise([
    item({ repositoryName: "repo-a", quantity: 10, grossAmount: 0.08, netAmount: 0.08 }),
    item({ repositoryName: "", quantity: 12, grossAmount: 0.10, netAmount: 0.10 }),
  ]);
  check("usage with no repository gets its own row",
    s.byRepo.some(r => r.unattributed && r.repo === UNATTRIBUTED), s.byRepo.map(r => r.repo));
  check("  and is not folded into a repository",
    s.byRepo.find(r => r.repo === "repo-a")?.quantity === 10,
    s.byRepo.find(r => r.repo === "repo-a")?.quantity);
  check("  so the total still matches what GitHub billed",
    s.totals.quantity === 22, s.totals.quantity);
}

// ── money does not drift ──────────────────────────────────────────────
{
  const s = summarise([
    item({ grossAmount: 0.1, netAmount: 0.1 }),
    item({ grossAmount: 0.2, netAmount: 0.2 }),
  ]);
  check("summed money is rounded to the cent", s.totals.gross === 0.3, s.totals.gross);
  check("  and does not print 0.30000000000000004",
    String(s.totals.gross) === "0.3", String(s.totals.gross));
}

// ── the same row twice is one row ─────────────────────────────────────
{
  // summarise() sums whatever it is given; de-duplication happens in getUsage
  // before this point. What this pins is that identical rows are genuinely
  // additive when they are distinct events.
  const s = summarise([item({ quantity: 5 }), item({ quantity: 5 })]);
  check("two genuine rows for one repo add up", s.totals.quantity === 10, s.totals.quantity);
  check("  and collapse to a single repository entry", s.byRepo.length === 1, s.byRepo.length);
}

// ── grouping ──────────────────────────────────────────────────────────
{
  const s = summarise([
    item({ date: "2026-06-01T00:00:00Z", repositoryName: "a", product: "actions", quantity: 10, grossAmount: 1 }),
    item({ date: "2026-07-01T00:00:00Z", repositoryName: "a", product: "actions", quantity: 20, grossAmount: 2 }),
    item({ date: "2026-07-01T00:00:00Z", repositoryName: "b", product: "packages", quantity: 5, grossAmount: 9, unitType: "GigabyteHours" }),
  ]);
  check("months come back oldest first",
    s.months.map(m => m.month).join(",") === "2026-06,2026-07", s.months.map(m => m.month));
  check("repositories are ranked by consumption",
    s.byRepo[0].repo === "a" && s.byRepo[0].quantity === 30, s.byRepo.map(r => `${r.repo}:${r.quantity}`));
  check("  and carry every product they used",
    s.byRepo.find(r => r.repo === "a")?.products.join(",") === "actions",
    s.byRepo.find(r => r.repo === "a")?.products);
  // packages 9 vs actions 1+2=3 — deliberately not a tie, or the order is
  // arbitrary and the assertion proves nothing.
  check("products are ranked by spend",
    s.byProduct[0].product === "packages", s.byProduct.map(p => p.product));
  check("  keeping each product's own unit",
    s.byProduct.find(p => p.product === "packages")?.unitType === "GigabyteHours",
    s.byProduct.find(p => p.product === "packages")?.unitType);
}

// ── nothing is not zero ───────────────────────────────────────────────
{
  const s = summarise([]);
  check("no data is reported as empty, not as zero spend", s.empty === true, s.empty);
  check("  with no invented rows", s.byRepo.length === 0 && s.months.length === 0,
    { repos: s.byRepo.length, months: s.months.length });

  const z = summarise([item({ quantity: 0, grossAmount: 0, netAmount: 0 })]);
  check("genuine zero usage is not reported as empty", z.empty === false, z.empty);
}

// ── the discount case, which is most orgs ─────────────────────────────
{
  // Included minutes make netAmount 0 while gross is non-zero. A page showing
  // only net would say "free" while the allowance drains.
  const s = summarise([item({ quantity: 54, grossAmount: 0.32, discountAmount: 0.32, netAmount: 0 })]);
  check("consumption survives when the bill is zero",
    s.totals.quantity === 54 && s.totals.net === 0 && s.totals.gross === 0.32,
    { quantity: s.totals.quantity, net: s.totals.net, gross: s.totals.gross });
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
