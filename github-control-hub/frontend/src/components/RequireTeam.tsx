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
    ? { ring: "border-ochre-edge", icon: "text-ochre", chip: "bg-ochre-wash text-ochre border-ochre-edge" }
    : { ring: "border-indigo-edge", icon: "text-indigo", chip: "bg-indigo-wash text-indigo border-indigo-edge" };

  return (
    <div className="min-h-[70vh] grid place-items-center px-6 py-16">
      <div className="relative w-full max-w-lg text-center">
        {/* A ruled notice, not an error state. The page is a dead end by
            design, so it is set like a standing notice rather than a warning. */}
        <div className={`relative mx-auto w-16 h-16 grid place-items-center border ${accent.ring}`}>
          <i className={`ph-bold ph-lock-key text-[1.625rem] ${accent.icon}`} aria-hidden="true" />
        </div>

        <h1 className="display text-[clamp(1.75rem,3vw,2.25rem)] text-ink relative mt-7">
          {title} is restricted
        </h1>

        <p className="standfirst relative mt-3 text-[0.875rem] max-w-[46ch] mx-auto">
          {kind === "aws"
            ? "This tab acts on an AWS account rather than on repositories, so it is kept to the team that administers it."
            : "This screen gathers the whole organization's access in one place, which is why it is kept to the administrators' team."}
        </p>

        {/* The one fact that resolves this: the team to ask for, spelled the way
            it is spelled on GitHub. */}
        <div className="relative mt-6 inline-flex flex-col items-center gap-2">
          <span className="caps">
            Ask to be added to
          </span>
          <code className={`px-3 py-1.5 font-mono text-[0.8125rem] border ${accent.chip}`}>
            {team}
          </code>
        </div>

        <p className="relative mt-7 text-[0.75rem] text-ink-3">
          Signed in as <span className="font-mono">{login}</span>. Organization
          owners are admitted without being on the team.
        </p>

        <p className="standfirst relative mt-4 text-[0.7812rem] max-w-[42ch] mx-auto">
          Everything else in the app is still open to you — including your own
          cards and alarms on <span className="font-semibold">My work</span>.
        </p>
      </div>
    </div>
  );
}
