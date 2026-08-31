import { usePermissions } from "../hooks/usePermissions";
import { Spinner } from "../design";

/**
 * A screen somebody may not see, said properly.
 *
 * Hiding the tab was the other option and is worse. Somebody who cannot find a
 * screen they have heard about assumes the app is broken, or asks around, or
 * goes looking for a link — and nothing anywhere tells them the one fact that
 * would settle it, which is the name of the team to ask for. A door that is
 * visibly locked is more useful than a wall.
 *
 * This is presentation, not enforcement. Every route behind it is gated on the
 * server, which is the part that matters: this only decides what somebody sees
 * instead of a wall of failed requests.
 */
export default function RequireTeam({ team, title, children }: {
  team: "control-hub" | "aws";
  /** What is behind the door, in the reader's words. */
  title: string;
  children: React.ReactNode;
}) {
  const { data: perms, isLoading, isError } = usePermissions();

  if (isLoading) {
    return <div className="py-24 flex justify-center"><Spinner /></div>;
  }

  // Being unable to ask GitHub is an outage, not a refusal. Showing the locked
  // screen here would tell somebody they had lost access they still have.
  if (isError || !perms) return <>{children}</>;

  const allowed = team === "aws" ? perms.isAwsAdmin : perms.isControlHubAdmin;
  if (allowed) return <>{children}</>;

  const teamName = team === "aws" ? perms.awsAdminTeam : perms.adminTeam;

  return <Locked title={title} team={teamName} login={perms.login} kind={team} />;
}

function Locked({ title, team, login, kind }: {
  title: string; team: string; login: string; kind: "control-hub" | "aws";
}) {
  const accent = kind === "aws"
    ? { ring: "ring-amber-500/20", glow: "bg-amber-500/[0.07]", icon: "text-amber-500",
        chip: "bg-amber-500/10 text-amber-700 dark:text-amber-400" }
    : { ring: "ring-violet-500/20", glow: "bg-violet-500/[0.07]", icon: "text-violet-500",
        chip: "bg-violet-500/10 text-violet-700 dark:text-violet-300" };

  return (
    <div className="min-h-[70vh] grid place-items-center px-6 py-16">
      <div className="relative w-full max-w-lg text-center">
        {/* A single soft wash behind the lock. The page is a dead end, so it
            should feel deliberate rather than like an error state. */}
        <div aria-hidden="true"
          className={`pointer-events-none absolute left-1/2 -translate-x-1/2 -top-10
                      w-72 h-72 rounded-full blur-3xl ${accent.glow}`} />

        <div className={`relative mx-auto w-16 h-16 rounded-2xl grid place-items-center
                         bg-white dark:bg-slate-900 ring-1 ${accent.ring}
                         shadow-[0_18px_40px_-20px_rgba(0,0,0,0.45)]`}>
          <i className={`ph-fill ph-lock-key text-[26px] ${accent.icon}`} aria-hidden="true" />
        </div>

        <h1 className="relative mt-6 text-[22px] font-black tracking-[-0.02em] text-slate-900 dark:text-white">
          {title} is restricted
        </h1>

        <p className="relative mt-2.5 text-[13.5px] leading-relaxed text-slate-500 dark:text-slate-400 max-w-[46ch] mx-auto">
          {kind === "aws"
            ? "This tab acts on an AWS account rather than on repositories, so it is kept to the team that administers it."
            : "This screen gathers the whole organization's access in one place, which is why it is kept to the administrators' team."}
        </p>

        {/* The one fact that resolves this: the team to ask for, spelled the way
            it is spelled on GitHub. */}
        <div className="relative mt-6 inline-flex flex-col items-center gap-2">
          <span className="text-[10.5px] font-black uppercase tracking-[0.14em] text-slate-400 dark:text-slate-500">
            Ask to be added to
          </span>
          <code className={`px-3 py-1.5 rounded-lg font-mono text-[13px] font-bold ${accent.chip}`}>
            {team}
          </code>
        </div>

        <p className="relative mt-6 text-[12px] text-slate-400 dark:text-slate-500">
          Signed in as <span className="font-mono">{login}</span>. Organization
          owners are admitted without being on the team.
        </p>

        <p className="relative mt-5 text-[12px] text-slate-400 dark:text-slate-500 leading-relaxed max-w-[42ch] mx-auto">
          Everything else in the app is still open to you — including your own
          cards and alarms on <span className="font-semibold">My work</span>.
        </p>
      </div>
    </div>
  );
}
