import { useState } from "react";
import { useAuth } from "../App";
import { Page, Empty, Spinner, SearchInput, SURFACE } from "../design";
import { useInventory, useBlastRadius } from "../hooks/useResources";
import type { AwsResource, RiskLevel, SourceRef } from "../api/resources";
import UserAvatar from "../components/UserAvatar";

/**
 * Looking up any AWS resource, and what depends on it.
 *
 * Read with the operator's own credentials, so the answer is scoped to what
 * they can already see. Nothing here writes.
 */

function ago(days: number): string {
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.round(days / 30)}mo ago`;
  return `${(days / 365).toFixed(1)}y ago`;
}

const RISK: Record<RiskLevel, { label: string; badge: string; bar: string; line: string }> = {
  high: {
    label: "High risk",
    badge: "bg-rose-50 text-rose-700 ring-rose-600/20 dark:bg-rose-950/50 dark:text-rose-300 dark:ring-rose-400/20",
    bar: "bg-rose-500", line: "border-rose-200 dark:border-rose-500/30",
  },
  medium: {
    label: "Some risk",
    badge: "bg-amber-50 text-amber-800 ring-amber-600/20 dark:bg-amber-950/50 dark:text-amber-300 dark:ring-amber-400/20",
    bar: "bg-amber-500", line: "border-amber-200 dark:border-amber-500/30",
  },
  low: {
    label: "Nothing found",
    badge: "bg-emerald-50 text-emerald-700 ring-emerald-600/20 dark:bg-emerald-950/50 dark:text-emerald-300 dark:ring-emerald-400/20",
    bar: "bg-emerald-500", line: "border-emerald-200 dark:border-emerald-500/30",
  },
  // Deliberately not green and deliberately not calm. An incomplete answer to
  // "is this safe to delete" is the one that gets somebody hurt, so it reads as
  // a warning rather than as a result.
  unknown: {
    label: "Incomplete — do not rely on this",
    badge: "bg-slate-100 text-slate-700 ring-slate-500/30 dark:bg-slate-800 dark:text-slate-200 dark:ring-slate-400/30",
    bar: "bg-slate-400", line: "border-slate-300 dark:border-slate-600",
  },
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
        className={`w-full text-left px-3 py-2 rounded-lg flex items-center gap-2.5 transition-colors ${
          on ? "bg-gh-blue text-white" : "hover:bg-slate-100 dark:hover:bg-white/[0.06]"}`}>
        <i className={`ph ${SERVICE_ICON[r.service] ?? "ph-cube"} text-base shrink-0 ${
          on ? "" : "text-slate-400 dark:text-slate-500"}`}></i>
        <span className="min-w-0 flex-1">
          <span className="block text-[13px] font-medium truncate">{r.name}</span>
          <span className={`block text-[11px] truncate ${on ? "opacity-70" : "text-slate-400 dark:text-slate-500"}`}>
            {r.service}{r.region ? ` · ${r.region}` : ""}
          </span>
        </span>
      </button>
    );
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
              ) : inv?.resources.map(resourceRow)}
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
    <div className={`${SURFACE.sheet} border-l-4 ${tone.line} overflow-hidden`}>
      <div className="p-5">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="min-w-0">
            <p className="text-[11px] font-bold uppercase tracking-wider text-slate-400 dark:text-slate-500">
              {data.target.service}
            </p>
            <h2 className="text-xl font-black tracking-tight text-slate-900 dark:text-white break-all">
              {data.target.name}
            </h2>
            {data.target.arn && (
              <code className="block mt-1 text-[11px] text-slate-400 dark:text-slate-500 break-all">
                {data.target.arn}
              </code>
            )}
          </div>
          <span className={`text-[11px] font-bold px-2.5 py-1 rounded-full ring-1 ring-inset shrink-0 ${tone.badge}`}>
            {tone.label}
          </span>
        </div>

        {/* The sentences, in the order somebody about to delete it would want
            them. The counts below are the evidence; this is the answer. */}
        <ul className="mt-4 space-y-1.5">
          {data.findings.map((f, i) => (
            <li key={i} className="flex gap-2 text-[13px] text-slate-700 dark:text-slate-200">
              <span className={`mt-1.5 h-1.5 w-1.5 rounded-full shrink-0 ${tone.bar}`} />
              <span>{f}</span>
            </li>
          ))}
        </ul>
      </div>

      <div className="px-5 py-3 border-t border-slate-100 dark:border-white/[0.06] flex gap-6 flex-wrap">
        <Stat n={data.relationships.length} label="AWS dependents" />
        <Stat n={data.sourceRefs.length} label="files reference it" />
        <Stat n={data.repos.length} label="repositories" />
        <Stat n={data.managedBy.length} label="declare it as infrastructure" />
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
          <h3 className="px-5 pt-4 pb-2 text-[13px] font-bold text-slate-900 dark:text-white">
            Inside AWS
          </h3>
          <ul className="divide-y divide-slate-100 dark:divide-white/[0.06]">
            {data.relationships.map((r, i) => (
              <li key={i} className="px-5 py-2.5 flex items-center gap-3 flex-wrap">
                <i className={`ph ${SERVICE_ICON[r.from.service] ?? "ph-cube"} text-slate-400`}></i>
                <span className="font-mono text-[13px] text-slate-800 dark:text-slate-100">{r.from.name}</span>
                <span className="text-[12px] text-slate-500 dark:text-slate-400">{r.detail}</span>
                {r.kind === "event-source" && (
                  // The one relationship that breaks in seconds rather than on
                  // the next deploy, so it is marked rather than left to read
                  // as one row among many.
                  <span className="ml-auto text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-rose-50 text-rose-700 dark:bg-rose-950/50 dark:text-rose-300">
                    live
                  </span>
                )}
              </li>
            ))}
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
                      <a href={r.url} target="_blank" rel="noopener noreferrer"
                        className="group flex items-baseline gap-2 text-[12.5px] hover:bg-slate-50 dark:hover:bg-white/[0.04] rounded px-1 -mx-1 py-0.5">
                        <span className="font-mono text-slate-500 dark:text-slate-400 shrink-0">{r.repo}</span>
                        <span className="font-mono text-slate-800 dark:text-slate-200 truncate group-hover:text-gh-blue">
                          {r.path}
                        </span>
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
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
                  <a href={`https://github.com/${e.login}`} target="_blank" rel="noopener noreferrer"
                    className="text-[13px] font-bold text-slate-800 dark:text-slate-100 hover:text-gh-blue">
                    {e.login}
                  </a>
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
