import { useState } from "react";
import { useAuth } from "../App";
import { Page, Empty, Spinner, SearchInput, SURFACE } from "../design";
import { useInventory, useBlastRadius } from "../hooks/useResources";
import type { AwsResource, RiskLevel, SourceRef } from "../api/resources";
import UserAvatar from "../components/UserAvatar";
import ExternalLink from "../components/ExternalLink";

/**
 * Looking up any AWS resource, and what depends on it.
 *
 * Read with the operator's own credentials, so the answer is scoped to what
 * they can already see. Nothing here writes.
 */

/** How long ago an ISO timestamp was, in words. */
function since(iso: string): string {
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  if (!Number.isFinite(mins) || mins < 0) return "at an unknown time";
  if (mins < 1) return "moments ago";
  if (mins < 60) return `${mins} minutes ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hours ago`;
  return `${Math.floor(hours / 24)} days ago`;
}

function ago(days: number): string {
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.round(days / 30)}mo ago`;
  return `${(days / 365).toFixed(1)}y ago`;
}

const RISK: Record<RiskLevel, {
  label: string; badge: string; bar: string; line: string; wash: string; chip: string;
}> = {
  high: {
    label: "High risk",
    badge: "bg-rose-50 text-rose-700 ring-rose-600/20 dark:bg-rose-950/50 dark:text-rose-300 dark:ring-rose-400/20",
    bar: "bg-rose-500", line: "border-rose-200 dark:border-rose-500/30",
    wash: "bg-gradient-to-br from-rose-500/[0.10] to-transparent dark:from-rose-500/[0.16]",
    chip: "bg-rose-100 text-rose-700 dark:bg-rose-500/20 dark:text-rose-300",
  },
  medium: {
    label: "Some risk",
    badge: "bg-amber-50 text-amber-800 ring-amber-600/20 dark:bg-amber-950/50 dark:text-amber-300 dark:ring-amber-400/20",
    bar: "bg-amber-500", line: "border-amber-200 dark:border-amber-500/30",
    wash: "bg-gradient-to-br from-amber-500/[0.10] to-transparent dark:from-amber-500/[0.16]",
    chip: "bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300",
  },
  low: {
    label: "Nothing found",
    badge: "bg-emerald-50 text-emerald-700 ring-emerald-600/20 dark:bg-emerald-950/50 dark:text-emerald-300 dark:ring-emerald-400/20",
    bar: "bg-emerald-500", line: "border-emerald-200 dark:border-emerald-500/30",
    wash: "bg-gradient-to-br from-emerald-500/[0.10] to-transparent dark:from-emerald-500/[0.16]",
    chip: "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300",
  },
  // Deliberately not green and deliberately not calm. An incomplete answer to
  // "is this safe to delete" is the one that gets somebody hurt, so it reads as
  // a warning rather than as a result.
  unknown: {
    label: "Incomplete — do not rely on this",
    badge: "bg-slate-100 text-slate-700 ring-slate-500/30 dark:bg-slate-800 dark:text-slate-200 dark:ring-slate-400/30",
    bar: "bg-slate-400", line: "border-slate-300 dark:border-slate-600",
    wash: "bg-gradient-to-br from-slate-500/[0.08] to-transparent dark:from-slate-400/[0.12]",
    chip: "bg-slate-200 text-slate-600 dark:bg-slate-700 dark:text-slate-300",
  },
};

/** What a dependency actually is, in words somebody can act on. */
const KIND_LABEL: Record<string, string> = {
  "event-source": "triggered by this",
  "env-var": "environment variable",
  "execution-role": "runs as this role",
  "security-group": "network access",
};

const SERVICE_ICON: Record<string, string> = {
  sqs: "ph-queue", lambda: "ph-function", s3: "ph-bucket", dynamodb: "ph-table",
  iam: "ph-key", "ec2-sg": "ph-shield", logs: "ph-scroll", rds: "ph-database",
};

const KIND_STYLE: Record<SourceRef["kind"], { label: string; cls: string }> = {
  terraform:      { label: "Terraform",      cls: "bg-violet-50 text-violet-700 dark:bg-violet-950/50 dark:text-violet-300" },
  cloudformation: { label: "CloudFormation", cls: "bg-violet-50 text-violet-700 dark:bg-violet-950/50 dark:text-violet-300" },
  cdk:            { label: "CDK",            cls: "bg-violet-50 text-violet-700 dark:bg-violet-950/50 dark:text-violet-300" },
  ci:             { label: "Pipeline",       cls: "bg-amber-50 text-amber-800 dark:bg-amber-950/50 dark:text-amber-300" },
  kubernetes:     { label: "Kubernetes",     cls: "bg-amber-50 text-amber-800 dark:bg-amber-950/50 dark:text-amber-300" },
  code:           { label: "Code",           cls: "bg-sky-50 text-sky-700 dark:bg-sky-950/50 dark:text-sky-300" },
  config:         { label: "Config",         cls: "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300" },
  docs:           { label: "Docs",           cls: "bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400" },
};

/** Infrastructure declarations first — they are the ones that change the plan. */
const KIND_ORDER: SourceRef["kind"][] =
  ["terraform", "cloudformation", "cdk", "ci", "kubernetes", "code", "config", "docs"];

export default function ResourcesPage() {
  const { user } = useAuth();
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<AwsResource | null>(null);

  const { data: inv, isLoading, error } = useInventory(q);
  const blast = useBlastRadius(picked?.service ?? null, picked?.name ?? null);

  const resourceRow = (r: AwsResource) => {
    const on = picked?.service === r.service && picked?.name === r.name;
    return (
      <button key={`${r.service}/${r.name}`} onClick={() => setPicked(r)}
        className={`w-full text-left pl-3 pr-2 py-1.5 rounded-lg flex items-center gap-2 transition-all ${
          on
            ? "bg-gh-blue text-white shadow-sm"
            : "hover:bg-slate-100 dark:hover:bg-white/[0.06] text-slate-700 dark:text-slate-200"}`}>
        <span className={`text-[13px] font-medium truncate flex-1 ${on ? "" : ""}`}>{r.name}</span>
        {r.region && (
          <span className={`text-[10px] shrink-0 ${on ? "opacity-70" : "text-slate-400 dark:text-slate-500"}`}>
            {r.region}
          </span>
        )}
      </button>
    );
  };

  /**
   * Grouped by service, with a count on each.
   *
   * A flat list of ninety-six names in no order is a list nobody scans. The
   * service is the first thing anybody knows about a resource they are looking
   * for, so it is the axis.
   */
  const grouped = () => {
    const by = new Map<string, AwsResource[]>();
    for (const r of inv?.resources ?? []) {
      const list = by.get(r.service) ?? [];
      list.push(r);
      by.set(r.service, list);
    }
    return [...by.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
  };

  return (
    <Page user={user}>
      <header className="mb-5">
        <h1 className="text-2xl font-black tracking-tight text-slate-900 dark:text-white">Resources</h1>
        <p className="text-sm text-slate-500 dark:text-slate-400 mt-1 max-w-3xl">
          Look up any AWS resource by name or ARN and see what depends on it — inside AWS, and
          across every repository in the organization. Read with your own AWS credentials, and
          nothing here changes anything.
        </p>
      </header>

      {error ? (
        <Empty title="Could not read this account" body={(error as Error).message} />
      ) : (
        <div className="grid lg:grid-cols-[minmax(0,22rem)_1fr] gap-5">
          {/* ── the account ── */}
          <div className={`${SURFACE.sheet} flex flex-col max-h-[calc(100vh-14rem)]`}>
            <div className="p-3 border-b border-slate-200 dark:border-white/[0.09]">
              <SearchInput value={q} onChange={setQ} placeholder="Name, ARN or fragment…" />
              {inv && (
                <p className="mt-2 px-1 text-[11px] text-slate-400 dark:text-slate-500">
                  {q ? `${inv.matched} of ${inv.total}` : `${inv.total} resources`}
                  {inv.matched > inv.resources.length && ` · showing first ${inv.resources.length}`}
                </p>
              )}
            </div>

            {/* Named, not hidden. A service that could not be listed is the
                reason a resource is missing from this list, and somebody
                scrolling for it needs to know that rather than conclude it is
                gone. */}
            {inv && inv.unreadable.length > 0 && (
              <div className="mx-3 mt-3 rounded-lg bg-amber-50 dark:bg-amber-950/40 px-3 py-2">
                <p className="text-[12px] font-semibold text-amber-800 dark:text-amber-300">
                  {inv.unreadable.length} service{inv.unreadable.length === 1 ? "" : "s"} could not be read
                </p>
                {inv.unreadable.map(u => (
                  <p key={u.service} className="text-[11px] text-amber-700 dark:text-amber-400 mt-0.5">
                    <strong>{u.service}</strong> — {u.error}
                  </p>
                ))}
              </div>
            )}

            <div className="flex-1 overflow-y-auto p-2">
              {isLoading ? <Spinner /> : inv?.resources.length === 0 ? (
                <p className="px-3 py-4 text-[13px] text-slate-400 dark:text-slate-500">
                  {q ? "Nothing matches." : "No resources readable in this account."}
                </p>
              ) : grouped().map(([service, rows]) => (
                <div key={service} className="mb-2">
                  <p className="flex items-center gap-2 px-2 py-1">
                    <i className={`ph-fill ${SERVICE_ICON[service] ?? "ph-cube"} text-[13px] text-slate-400 dark:text-slate-500`}></i>
                    <span className="text-[11px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                      {service}
                    </span>
                    <span className="text-[11px] tabular-nums text-slate-400 dark:text-slate-600">{rows.length}</span>
                  </p>
                  <div className="space-y-0.5">{rows.map(resourceRow)}</div>
                </div>
              ))}
            </div>
          </div>

          {/* ── the answer ── */}
          <div>
            {!picked ? (
              <div className={`${SURFACE.sheet} p-10 text-center`}>
                <i className="ph ph-crosshair text-3xl text-slate-300 dark:text-slate-600"></i>
                <p className="mt-3 text-sm font-semibold text-slate-700 dark:text-slate-200">
                  Pick a resource
                </p>
                <p className="mt-1 text-[13px] text-slate-500 dark:text-slate-400 max-w-md mx-auto">
                  You will get what consumes it inside AWS, every file in every repository that
                  names it, and whether deleting it would stick.
                </p>
              </div>
            ) : blast.isLoading ? (
              <div className={`${SURFACE.sheet} p-10`}>
                <Spinner />
                <p className="mt-3 text-center text-[13px] text-slate-500 dark:text-slate-400">
                  Reading AWS and searching {picked.name} across the organization…
                </p>
              </div>
            ) : blast.error ? (
              <Empty title="Could not assess this resource" body={(blast.error as Error).message} />
            ) : blast.data ? (
              <div className="space-y-4">
                <BlastHeader data={blast.data} />
                <BlastBody data={blast.data} />
              </div>
            ) : null}
          </div>
        </div>
      )}
    </Page>
  );
}

function BlastHeader({ data }: { data: NonNullable<ReturnType<typeof useBlastRadius>["data"]> }) {
  const tone = RISK[data.risk];
  return (
    <div className={`${SURFACE.sheet} overflow-hidden`}>
      {/* A wash rather than a border stripe: at a glance the whole card carries
          the verdict, which is the only thing being asked. */}
      <div className={`px-6 pt-5 pb-5 ${tone.wash}`}>
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="min-w-0">
            <div className="flex items-center gap-2 mb-1.5">
              <span className={`w-8 h-8 rounded-xl flex items-center justify-center ${tone.chip}`}>
                <i className={`ph-fill ${SERVICE_ICON[data.target.service] ?? "ph-cube"} text-base`}></i>
              </span>
              <span className="text-[11px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                {data.target.service}
                {data.target.region ? ` · ${data.target.region}` : ""}
              </span>
            </div>
            <h2 className="text-2xl font-black tracking-tight text-slate-900 dark:text-white break-all leading-tight">
              {data.target.name}
            </h2>
            {data.target.arn && (
              <code className="block mt-1 text-[11px] text-slate-400 dark:text-slate-500 break-all">
                {data.target.arn}
              </code>
            )}
          </div>

          <div className="flex flex-col items-end gap-2 shrink-0">
            <span className={`text-[11px] font-bold px-2.5 py-1 rounded-full ring-1 ring-inset ${tone.badge}`}>
              {tone.label}
            </span>
            {data.targetUrl && (
              <ExternalLink href={data.targetUrl}
                className="text-[12px] font-bold text-gh-blue hover:underline inline-flex items-center gap-1">
                Open in AWS <i className="ph-bold ph-arrow-square-out text-[11px]"></i>
              </ExternalLink>
            )}
          </div>
        </div>

        <ul className="mt-4 space-y-1.5">
          {data.findings.map((f, i) => (
            <li key={i} className="flex gap-2.5 text-[13px] text-slate-700 dark:text-slate-200">
              <span className={`mt-1.5 h-1.5 w-1.5 rounded-full shrink-0 ${tone.bar}`} />
              <span>{f}</span>
            </li>
          ))}
        </ul>
      </div>

      <div className="px-6 py-3.5 border-t border-slate-100 dark:border-white/[0.06] flex gap-6 flex-wrap">
        <Stat n={data.relationships.length} label="AWS dependents" />
        <Stat n={data.sourceRefs.length} label="files reference it" />
        <Stat n={data.repos.length} label="repositories" />
        <Stat n={data.managedBy.length} label="declare it" />
      </div>
    </div>
  );
}

function Stat({ n, label }: { n: number; label: string }) {
  return (
    <span className="flex items-baseline gap-1.5">
      <span className="text-lg font-black tabular-nums text-slate-900 dark:text-white">{n}</span>
      <span className="text-[12px] text-slate-500 dark:text-slate-400">{label}</span>
    </span>
  );
}

function BlastBody({ data }: { data: NonNullable<ReturnType<typeof useBlastRadius>["data"]> }) {
  const byKind = KIND_ORDER
    .map(kind => ({ kind, refs: data.sourceRefs.filter(r => r.kind === kind) }))
    .filter(g => g.refs.length > 0);

  return (
    <>
      {data.unread.length > 0 && (
        <div className="rounded-xl border border-amber-200 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-950/40 p-4">
          <p className="text-[13px] font-bold text-amber-900 dark:text-amber-200">
            This report is incomplete
          </p>
          <p className="text-[12px] text-amber-800 dark:text-amber-300 mt-1">
            Something could not be read, so an empty result below does not mean nothing depends on
            it. Treat the whole answer as unverified until these are fixed.
          </p>
          <ul className="mt-2 space-y-1">
            {data.unread.map((u, i) => (
              <li key={i} className="text-[12px] text-amber-800 dark:text-amber-300">
                <strong>{u.source}</strong> — {u.error}
              </li>
            ))}
          </ul>
        </div>
      )}

      {data.relationships.length > 0 && (
        <div className={SURFACE.sheet}>
          <div className="px-5 pt-4 pb-1">
            <h3 className="text-[13px] font-bold text-slate-900 dark:text-white">Inside AWS</h3>
            <p className="text-[12px] text-slate-500 dark:text-slate-400 mt-0.5">
              Each of these breaks if the resource goes. Click through to it in the console.
            </p>
          </div>
          <ul className="px-3 pb-3 pt-2 space-y-1.5">
            {data.relationships.map((r, i) => {
              const live = r.kind === "event-source";
              return (
                <li key={i}
                  className={`rounded-xl border px-3.5 py-2.5 ${
                    live
                      ? "border-rose-200 dark:border-rose-500/30 bg-rose-50/50 dark:bg-rose-950/20"
                      : "border-slate-200 dark:border-white/[0.08] bg-slate-50/60 dark:bg-white/[0.03]"}`}>
                  <div className="flex items-center gap-2.5 flex-wrap">
                    <i className={`ph-fill ${SERVICE_ICON[r.from.service] ?? "ph-cube"} ${
                      live ? "text-rose-500" : "text-slate-400 dark:text-slate-500"}`}></i>
                    {/* The name is the link. Making somebody search the console
                        for a name they were just shown is the difference
                        between a report and a tool. */}
                    {r.fromUrl ? (
                      <ExternalLink href={r.fromUrl}
                        className="font-mono text-[13px] font-semibold text-slate-900 dark:text-white hover:text-gh-blue underline decoration-dotted underline-offset-2">
                        {r.from.name}
                        <i className="ph-bold ph-arrow-square-out ml-1 text-[10px] align-baseline"></i>
                      </ExternalLink>
                    ) : (
                      // Deliberately styled unlike the linked case. A name that
                      // looks identical to a link and does nothing when clicked
                      // reads as the app being broken.
                      <span className="font-mono text-[13px] font-semibold text-slate-500 dark:text-slate-400"
                        title="No console link could be built for this resource">
                        {r.from.name}
                      </span>
                    )}
                    <span className="text-[11px] uppercase tracking-wider text-slate-400 dark:text-slate-500">
                      {r.from.service}
                    </span>
                    {live && (
                      <span className="ml-auto text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-rose-500 text-white">
                        consuming now
                      </span>
                    )}
                  </div>
                  {/* Exactly how it depends — the variable's name and value, the
                      mapping's state — not "references it by env var". */}
                  {/* The label and the detail are the same sentence for some
                      kinds — "runs as this role · runs as this role" — so the
                      detail is only shown when it adds something. */}
                  <p className="mt-1 ml-6 text-[12px] text-slate-600 dark:text-slate-300">
                    <span className="text-slate-400 dark:text-slate-500">
                      {KIND_LABEL[r.kind] ?? r.kind}
                    </span>
                    {r.detail && r.detail !== KIND_LABEL[r.kind] && (
                      <>{" · "}<code className="font-mono">{r.detail}</code></>
                    )}
                  </p>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {byKind.length > 0 && (
        <div className={SURFACE.sheet}>
          <h3 className="px-5 pt-4 pb-2 text-[13px] font-bold text-slate-900 dark:text-white">
            In your source
          </h3>
          <div className="pb-2">
            {byKind.map(({ kind, refs }) => (
              <div key={kind} className="px-5 py-2">
                <p className="flex items-center gap-2 mb-1.5">
                  <span className={`text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded ${KIND_STYLE[kind].cls}`}>
                    {KIND_STYLE[kind].label}
                  </span>
                  <span className="text-[11px] text-slate-400 dark:text-slate-500">{refs.length}</span>
                </p>
                <ul className="space-y-0.5">
                  {refs.map((r, i) => (
                    <li key={i}>
                      <ExternalLink href={r.url}
                        className="group flex items-baseline gap-2 text-[12.5px] hover:bg-slate-50 dark:hover:bg-white/[0.04] rounded px-1 -mx-1 py-0.5">
                        <span className="font-mono text-slate-500 dark:text-slate-400 shrink-0">{r.repo}</span>
                        <span className="font-mono text-slate-800 dark:text-slate-200 truncate group-hover:text-gh-blue">
                          {r.path}
                        </span>
                      </ExternalLink>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
      )}

      {data.drift && (
        <div className={`${SURFACE.sheet} ${
          data.drift.comparable && data.drift.findings.length > 0
            ? "border-l-4 border-rose-300 dark:border-rose-500/40" : ""}`}>
          <div className="px-5 pt-4 pb-2 flex items-baseline justify-between gap-3 flex-wrap">
            <h3 className="text-[13px] font-bold text-slate-900 dark:text-white">
              Does AWS match the code in GitHub?
            </h3>
            {data.drift.declaredIn && (
              <span className="text-[11px] font-mono text-slate-400 dark:text-slate-500">
                {data.drift.declaredIn.repo}/{data.drift.declaredIn.path}
              </span>
            )}
          </div>

          {/* Not comparable is its own answer, and deliberately not a clean
              bill of health. A declaration built from variables cannot be
              resolved without running Terraform, and saying "no drift" on that
              basis would be a claim nothing supports. */}
          {!data.drift.comparable && data.drift.findings.length > 0 ? (
            // An undeclared group. Not a comparison — a statement that no
            // comparison is possible because nothing declares it, which is the
            // more serious thing to know on an account managed as code.
            <div className="px-5 pb-4">
              <p className="text-[13px] font-bold text-rose-700 dark:text-rose-300">
                Nothing in GitHub declares this
              </p>
              {data.drift.notes.map((n, i) => (
                <p key={i} className="text-[12px] text-slate-500 dark:text-slate-400 mt-1">{n}</p>
              ))}
              <ul className="mt-2 space-y-1.5">
                {data.drift.findings.map((f, i) => (
                  <li key={i} className="flex items-start gap-2.5">
                    <span className="mt-0.5 text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-rose-50 text-rose-700 dark:bg-rose-950/50 dark:text-rose-300 shrink-0">
                      undeclared
                    </span>
                    <span className="min-w-0">
                      <code className="text-[13px] font-mono text-slate-800 dark:text-slate-100">{f.rule}</code>
                      <span className="block text-[11px] text-slate-500 dark:text-slate-400">{f.detail}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : !data.drift.comparable ? (
            <div className="px-5 pb-4">
              <p className="text-[13px] font-semibold text-slate-600 dark:text-slate-300">
                Cannot be compared
              </p>
              <ul className="mt-1 space-y-1">
                {data.drift.notes.map((n, i) => (
                  <li key={i} className="text-[12px] text-slate-500 dark:text-slate-400">{n}</li>
                ))}
              </ul>
              <p className="mt-2 text-[11px] text-slate-400 dark:text-slate-500">
                Nothing is reported rather than a comparison that would be wrong.
              </p>
            </div>
          ) : data.drift.findings.length === 0 ? (
            <p className="px-5 pb-4 text-[13px] text-emerald-700 dark:text-emerald-400">
              AWS matches what the Terraform declares.
            </p>
          ) : (
            <ul className="px-5 pb-4 space-y-2">
              {data.drift.findings.map((f, i) => (
                <li key={i} className="flex items-start gap-2.5">
                  <span className={`mt-0.5 text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded shrink-0 ${
                    f.kind === "extra"
                      ? "bg-rose-50 text-rose-700 dark:bg-rose-950/50 dark:text-rose-300"
                      : "bg-amber-50 text-amber-800 dark:bg-amber-950/50 dark:text-amber-300"}`}>
                    {/* Different problems, different people: one is a manual
                        change nobody captured, the other a pipeline that never
                        ran. */}
                    {f.kind === "extra" ? "in AWS only" : "in code only"}
                  </span>
                  <span className="min-w-0">
                    <code className="text-[13px] font-mono text-slate-800 dark:text-slate-100">{f.rule}</code>
                    <span className="block text-[11px] text-slate-500 dark:text-slate-400">{f.detail}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* Changed since we last looked.
          A different question from drift, and the one somebody asks straight
          after editing a rule. Shown above drift because it is the more
          immediate answer. */}
      {data.change && !data.change.first &&
        (data.change.added.length > 0 || data.change.removed.length > 0) && (
        <div className={`${SURFACE.sheet} border-l-4 border-amber-300 dark:border-amber-500/40`}>
          <div className="px-5 pt-4 pb-2">
            <h3 className="text-[13px] font-bold text-slate-900 dark:text-white">
              Also: changed since this app last looked
            </h3>
            {/* Carefully worded. The gap between two reads is all this knows;
                when inside that gap it happened, and who did it, come from
                CloudTrail and are not available. */}
            <p className="text-[12px] text-slate-500 dark:text-slate-400 mt-0.5">
              Last read {data.change.lastSeenAt ? since(data.change.lastSeenAt) : "at an unknown time"}.
              The change happened at some point since then — this app cannot say when, or by whom.
            </p>
          </div>
          <ul className="px-5 pb-4 space-y-1.5">
            {data.change.added.map((r, i) => (
              <li key={`a${i}`} className="flex items-start gap-2.5">
                <span className="mt-0.5 text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300 shrink-0">
                  added
                </span>
                <code className="text-[13px] font-mono text-slate-800 dark:text-slate-100">{r}</code>
              </li>
            ))}
            {data.change.removed.map((r, i) => (
              <li key={`r${i}`} className="flex items-start gap-2.5">
                <span className="mt-0.5 text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-rose-50 text-rose-700 dark:bg-rose-950/50 dark:text-rose-300 shrink-0">
                  removed
                </span>
                <code className="text-[13px] font-mono text-slate-800 dark:text-slate-100 line-through opacity-70">{r}</code>
              </li>
            ))}
          </ul>
        </div>
      )}

      {data.experts && data.experts.experts.length > 0 && (
        <div className={SURFACE.sheet}>
          <div className="px-5 pt-4 pb-1">
            <h3 className="text-[13px] font-bold text-slate-900 dark:text-white">Who has worked on it</h3>
            {/* Said plainly, because the alternative reading — "these people own
                this resource" — is wrong and would send somebody to the wrong
                person. This is who edited the files, nothing more. */}
            <p className="text-[12px] text-slate-500 dark:text-slate-400 mt-0.5">
              Ranked by commits to the {data.experts.filesRead.length} file
              {data.experts.filesRead.length === 1 ? "" : "s"} that name it, most recent weighted
              highest. Not who owns it — who has edited it.
            </p>
          </div>
          <ul className="px-5 pb-4 pt-2 space-y-2">
            {data.experts.experts.map(e => (
              <li key={e.login} className="flex items-start gap-3">
                <UserAvatar login={e.login} size={26} />
                <div className="min-w-0 flex-1">
                  <ExternalLink href={`https://github.com/${e.login}`}
                    className="text-[13px] font-bold text-slate-800 dark:text-slate-100 hover:text-gh-blue">
                    {e.login}
                  </ExternalLink>
                  <span className="ml-2 text-[12px] text-slate-500 dark:text-slate-400">
                    {e.commits} commit{e.commits === 1 ? "" : "s"}
                    {e.daysSinceActive !== null && ` · last ${ago(e.daysSinceActive)}`}
                  </span>
                  {/* The evidence. A name with no working shown is a name
                      nobody acts on. */}
                  <p className="text-[11px] text-slate-400 dark:text-slate-500 font-mono truncate">
                    {e.files.map(f => f.path).join(", ")}
                  </p>
                </div>
                <span className="text-[13px] font-black tabular-nums text-slate-700 dark:text-slate-200 shrink-0">
                  {e.score}
                </span>
              </li>
            ))}
          </ul>
          {(data.experts.filesSkipped > 0 || data.experts.degraded.length > 0) && (
            <p className="px-5 pb-4 -mt-2 text-[11px] text-slate-400 dark:text-slate-500">
              {data.experts.filesSkipped > 0 &&
                `${data.experts.filesSkipped} further referencing file${data.experts.filesSkipped === 1 ? "" : "s"} not read. `}
              {data.experts.degraded.length > 0 &&
                `${data.experts.degraded.length} file${data.experts.degraded.length === 1 ? "" : "s"} had no readable history.`}
            </p>
          )}
        </div>
      )}

      {data.relationships.length === 0 && data.sourceRefs.length === 0 && data.unread.length === 0 && (
        <div className={`${SURFACE.sheet} p-6 text-center`}>
          <p className="text-[13px] text-slate-500 dark:text-slate-400">
            Nothing in this account and nothing in any repository you can see refers to it.
          </p>
        </div>
      )}
    </>
  );
}
