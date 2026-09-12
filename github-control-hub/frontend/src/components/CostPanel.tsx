import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchCosts, type CostLine } from "../api/aws";
import { Spinner, Note, SURFACE, TYPE } from "../design";

/**
 * What this app's own resources have cost, resource by resource.
 *
 * The number is computed from metered usage times published prices, not read
 * from a bill, and the panel says so rather than letting somebody reconcile it
 * against their invoice and conclude one of them is broken.
 *
 * That is not a shortcut. AWS does not meter cost per resource for DynamoDB or
 * Lambda: a bill can say "$18 of DynamoDB" and never which table, and the
 * resource-level answer needs Cost and Usage Reports, an S3 bucket and Athena.
 * CloudWatch already knows what each resource consumed, so this asks it.
 *
 * The tradeoff is stated where the number is: no free tier, no committed-use
 * discount, no credits, no tax. A real bill is usually lower. What this is good
 * at is the half a bill is bad at, which is saying *which* of your resources
 * is responsible.
 */

const KIND: Record<CostLine["kind"], { icon: string; label: string; tone: string }> = {
  table:    { icon: "ph-table",          label: "DynamoDB",     tone: "text-sky-500" },
  function: { icon: "ph-function",       label: "Lambda",       tone: "text-amber-500" },
  logs:     { icon: "ph-list-magnifying-glass", label: "Logs",  tone: "text-slate-400" },
  topic:    { icon: "ph-megaphone",      label: "SNS",          tone: "text-violet-500" },
  secret:   { icon: "ph-key",            label: "Secret",       tone: "text-emerald-500" },
  waf:      { icon: "ph-shield-check",   label: "WAF",          tone: "text-rose-500" },
  api:      { icon: "ph-plugs-connected", label: "API Gateway", tone: "text-indigo-500" },
  queue:    { icon: "ph-queue",          label: "SQS",          tone: "text-teal-500" },
  alarm:    { icon: "ph-bell-ringing",   label: "Alarm",        tone: "text-orange-500" },
};

/**
 * Resources charged whether or not anything uses them.
 *
 * Worth calling out, because the rest of this page is usage and reads as
 * "spend less by doing less". These do not work that way: a web ACL costs the
 * same on an idle install, and on a quiet one it is the largest line here.
 */
const FIXED: ReadonlySet<CostLine["kind"]> = new Set(["waf", "alarm", "secret"]);

/**
 * Money, at the precision the number deserves.
 *
 * Two decimals hides everything below a cent, and most individual resources
 * here cost less than that. Showing "$0.00" beside a real number invites the
 * reading that it is free rather than small.
 */
function money(n: number): string {
  if (n === 0) return "$0";
  if (n < 0.01) return `<$0.01`;
  return `$${n.toFixed(2)}`;
}

function amount(n: number, unit: string): string {
  if (unit === "GB") return `${n < 0.01 ? n.toFixed(4) : n.toFixed(2)} GB`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M ${unit}`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k ${unit}`;
  return `${Math.round(n).toLocaleString()} ${unit}`;
}

export default function CostPanel() {
  const [days, setDays] = useState(30);
  const [open, setOpen] = useState<string | null>(null);

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["aws", "costs", days],
    queryFn: () => fetchCosts(days),
    staleTime: 60 * 60_000,
    retry: false,
  });

  if (isLoading) return <div className="py-16 flex justify-center"><Spinner /></div>;

  if (isError) {
    return (
      <Note intent="warn">
        Costs could not be read: {(error as Error)?.message}. This needs
        permission to read CloudWatch metrics and to list this account's tables,
        functions, log groups, topics and secrets. Nothing else on this tab
        depends on it.
      </Note>
    );
  }
  if (!data) return null;

  const biggest = data.lines[0]?.cost ?? 0;

  const installedDays = data.installedAt
    ? (Date.now() - new Date(data.installedAt).getTime()) / 86_400_000
    : null;

  /**
   * The same money, grouped by service.
   *
   * Not a substitute for the list below. This one answers "which service
   * should I be looking at"; the list answers "which of my resources inside it
   * is responsible", and only the second is actionable.
   */
  const byService = Object.entries(
    data.lines.reduce((acc, l) => {
      const cur = acc[l.kind] ?? { sum: 0, count: 0 };
      acc[l.kind] = { sum: cur.sum + l.cost, count: cur.count + 1 };
      return acc;
    }, {} as Record<CostLine["kind"], { sum: number; count: number }>),
  )
    .map(([kind, v]) => [kind as CostLine["kind"], v.sum, v.count] as const)
    .sort((a, b) => b[1] - a[1]);

  return (
    <div className="grid gap-4">
      <section className={`${SURFACE.card} overflow-hidden`}>
        <div className="px-5 pt-4">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div>
              <h3 className="display text-[1.1875rem] text-ink">
                What this app costs
              </h3>
              {/* The scope, said first. This runs in accounts that hold plenty
                  of other people's work, and a page headed "what this app
                  costs" showing the department's DynamoDB bill would be worse
                  than no page. */}
              <p className="text-[11.5px] text-slate-400 dark:text-slate-500 mt-0.5">
                Only resources named <code className="font-mono text-[11px]">{data.prefix}-*</code>,
                over the last {data.days} days, at {data.region} list rates.
                Nothing else in this account is counted.
              </p>
            </div>
            <div className="flex rounded-lg overflow-hidden border border-slate-200 dark:border-ink/10">
              {[7, 30, 90].map(d => (
                <button key={d} type="button" onClick={() => setDays(d)}
                  className={`px-2.5 py-1 text-[12px] font-bold transition-colors ${
                    d === days
                      ? "bg-slate-900 dark:bg-white text-reverse dark:text-slate-900"
                      : "text-slate-500 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-ink/[0.05]"}`}>
                  {d}d
                </button>
              ))}
            </div>
          </div>
          <div className="h-px bg-slate-200/70 dark:bg-ink/[0.07] mt-3" />
        </div>

        {/* A window longer than the install is the one case where two windows
            give the same answer, and without saying so that reads as a stuck
            number rather than as a young install. */}
        {installedDays !== null && installedDays < data.days && (
          <div className="px-5 pt-3">
            <Note intent="info">
              This install is {Math.floor(installedDays)} days old, so a {data.days}-day
              window shows {Math.floor(installedDays)} days of charges. Fixed costs are
              billed for the time each resource has existed, not for the window.
            </Note>
          </div>
        )}

        <div className="px-5 py-4 flex items-end gap-6 flex-wrap">
          <div>
            <p className={`${TYPE.label} text-slate-400 dark:text-slate-500`}>Over {data.days} days</p>
            <p className="display text-[1.625rem] tabular-nums text-ink leading-none mt-1">
              {money(data.total)}
            </p>
          </div>
          <div>
            <p className={`${TYPE.label} text-slate-400 dark:text-slate-500`}>Per month at this rate</p>
            <p className="display text-[1.625rem] tabular-nums text-ink leading-none mt-1">
              {money(data.monthly)}
            </p>
          </div>
        </div>

        {/* Said next to the number, not in a footnote. Somebody comparing this
            against an invoice needs to know why they differ before they
            conclude one of them is wrong. */}
        <div className="px-5 pb-4">
          <p className="text-[11.5px] text-slate-400 dark:text-slate-500 leading-relaxed">
            An estimate at list price, from what each resource actually
            consumed. It does not know about the free tier, committed-use
            discounts, credits or tax, so a real bill is usually lower. AWS does
            not meter cost per resource for DynamoDB or Lambda, so this is the
            only way to see which of them is responsible.
            {data.pricesMayNotApply && (
              <> <span className="text-amber-700 dark:text-amber-500">
                These are {data.pricesAsOf} prices for {"us-east-2"}, and this account
                is in {data.region}, where some of them differ.
              </span></>
            )}
          </p>
        </div>
      </section>

      {/* A page about cost that quietly costs something is the one page that
          must not. The ceiling, not a guess at how often somebody looks: the
          report is cached for an hour, so this is the most it can cost however
          hard the page is refreshed. */}
      <p className="text-[11.5px] text-slate-400 dark:text-slate-500 px-1 leading-relaxed">
        Producing this reads {data.self.metricsRequested} CloudWatch metrics, about{" "}
        {data.self.costPerRun < 0.001 ? "a tenth of a cent" : money(data.self.costPerRun)} a
        time, and it is cached for an hour: at most{" "}
        <span className="font-semibold">{money(data.self.monthlyIfHourly)}</span> a month even
        if somebody watches it all day. Listing your tables, functions, log groups and topics
        is free. Nothing is created, stored or queried to produce it: no Cost Explorer, no
        S3, no Athena.
      </p>

      {data.errors.length > 0 && (
        <Note intent="warn">
          Part of the account could not be read, so the total is lower than the truth:{" "}
          {data.errors.join(" · ")}
        </Note>
      )}

      {/* Both levels, because they answer different questions. The rollup says
          which service to look at; the list below says which resource inside it
          is responsible. A bill gives the first and can never give the second,
          which is the whole reason this page exists. */}
      <section className={`${SURFACE.card} overflow-hidden`}>
        <div className="px-5 pt-4 pb-1">
          <h3 className="display text-[1.1875rem] text-ink">
            By service
          </h3>
        </div>
        <div className="px-5 pb-4 pt-2 grid gap-1.5">
          {byService.map(([kind, sum, count]) => {
            const k = KIND[kind];
            const share = data.total > 0 ? (sum / data.total) * 100 : 0;
            return (
              <div key={kind} className="flex items-center gap-3">
                <i className={`ph-fill ${k.icon} ${k.tone} text-[14px] shrink-0`} aria-hidden="true" />
                <span className="text-[12.5px] font-semibold text-slate-700 dark:text-slate-200 w-20 shrink-0">
                  {k.label}
                </span>
                <span className="text-[11px] text-slate-400 dark:text-slate-500 w-20 shrink-0 tabular-nums">
                  {count} {count === 1 ? "resource" : "resources"}
                </span>
                <span className="flex-1 h-1.5 rounded-full bg-slate-100 dark:bg-ink/[0.07] overflow-hidden">
                  <span className="block h-full  bg-slate-900/70 dark:bg-ink/60"
                    style={{ width: `${Math.max(share, sum > 0 ? 2 : 0)}%` }} />
                </span>
                <span className="text-[11px] text-slate-400 dark:text-slate-500 w-9 text-right tabular-nums shrink-0">
                  {Math.round(share)}%
                </span>
                <span className="text-[12.5px] font-bold tabular-nums text-slate-900 dark:text-ink w-16 text-right shrink-0">
                  {money(sum)}
                </span>
              </div>
            );
          })}
        </div>
      </section>

      <section className={`${SURFACE.card} overflow-hidden`}>
        <div className="px-5 pt-4 pb-2">
          <h3 className="display text-[1.1875rem] text-ink">
            By resource
          </h3>
          <p className="text-[11.5px] text-slate-400 dark:text-slate-500 mt-0.5">
            Largest first. Open one to see what it did.
          </p>
        </div>

        <ul className="px-2 pb-3">
          {data.lines.map(line => {
            const k = KIND[line.kind];
            const share = biggest > 0 ? (line.cost / biggest) * 100 : 0;
            const isOpen = open === line.name;
            return (
              <li key={line.name}>
                <button
                  type="button"
                  onClick={() => setOpen(isOpen ? null : line.name)}
                  className="w-full px-3 py-2 flex items-center gap-3 text-left rounded-lg
                             hover:bg-slate-50 dark:hover:bg-ink/[0.04] transition-colors"
                >
                  <i className={`ph-fill ${k.icon} ${k.tone} text-[15px] shrink-0`} aria-hidden="true" />
                  <span className="min-w-0 flex-1">
                    <span className="block text-[12.5px] font-semibold text-slate-800 dark:text-slate-100 truncate">
                      {line.name}
                    </span>
                    {/* A bar, because "which one is the problem" is a
                        comparison and a column of numbers makes the reader do
                        it themselves. */}
                    {line.billedDays < data.days - 0.5 && (
                      <span className="block text-[10.5px] text-amber-700 dark:text-amber-500">
                        billed {Math.max(0, Math.floor(line.billedDays))} of {data.days} days
                      </span>
                    )}
                    <span className="block h-1 rounded-full bg-slate-100 dark:bg-ink/[0.07] mt-1 overflow-hidden">
                      <span className="block h-full  bg-slate-900/70 dark:bg-ink/60"
                        style={{ width: `${Math.max(share, line.cost > 0 ? 2 : 0)}%` }} />
                    </span>
                  </span>
                  {FIXED.has(line.kind) && (
                    <span className="caps text-ochre shrink-0" title="Charged whether it is used or not">
                      fixed
                    </span>
                  )}
                  <span className="caps shrink-0">
                    {k.label}
                  </span>
                  <span className="text-[12.5px] font-bold tabular-nums text-slate-900 dark:text-ink shrink-0 w-16 text-right">
                    {money(line.cost)}
                  </span>
                </button>

                {isOpen && (
                  <div className="px-3 pb-3 pl-11">
                    <table className="w-full text-[12px]">
                      <tbody>
                        {line.usage.map(u => (
                          <tr key={u.label}>
                            <td className="py-0.5 text-slate-500 dark:text-slate-400">{u.label}</td>
                            <td className="py-0.5 text-right tabular-nums text-slate-600 dark:text-slate-300">
                              {amount(u.amount, u.unit)}
                            </td>
                            <td className="py-0.5 text-right tabular-nums font-semibold text-slate-800 dark:text-slate-200 w-16">
                              {money(u.cost)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </li>
            );
          })}
        </ul>

        {data.lines.length === 0 && (
          <p className="px-5 pb-5 text-[12.5px] text-slate-400 dark:text-slate-500">
            Nothing found with the prefix this install uses.
          </p>
        )}
      </section>
    </div>
  );
}
