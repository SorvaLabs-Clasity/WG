import { useNavigate } from "react-router-dom";
import { usePermissions } from "../hooks/usePermissions";
import { usePermissionSet } from "../hooks/usePermissionSet";
import { useAuth } from "../App";
import { Page, Spinner, Button } from "../design";

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
 *
 * **Inside `<Page>`, which is where the navigation lives.** It did not used to
 * be, and that turned a locked door into a locked room: the notice rendered as
 * a bare element in place of the whole page, so there were no section tabs, no
 * account menu, no theme picker and no way to sign out. Anybody who arrived
 * here — and the desktop app reopens on the route it was last closed on, so
 * arriving here on launch takes no wrong move at all — had nothing to click but
 * the browser's back button, which the desktop build does not show. It read as
 * the app having locked them out of itself rather than out of one screen.
 *
 * Nothing about it was theme-specific. Every theme renders its navigation from
 * `<Page>`, so every theme lost all of it in exactly the same way.
 */
export default function RequireTeam({ team, title, permissions, children }: {
  team: "control-hub" | "aws";
  /** What is behind the door, in the reader's words. */
  title: string;
  /**
   * What opens it once a permissions file is in force — the same keys the
   * section line shows the tab for. The team is only the rule before then;
   * after, asking it hid the tab from everybody granted it who was not on the
   * team.
   */
  permissions: string[];
  children: React.ReactNode;
}) {
  const { data: perms, isLoading, isError } = usePermissions();
  const set = usePermissionSet();
  const { user } = useAuth();

  const enforced = !!set.permissions?.enforced && !set.permissions.inert;
  if (enforced) {
    // Could not ask: the page says so itself, and a locked door would tell
    // somebody they had lost access they may still have.
    if (set.unavailable || set.canAny(...permissions)) return <>{children}</>;
    return (
      <Page user={user}>
        <Locked title={title} team={null} login={user?.login ?? ""} kind={team} />
      </Page>
    );
  }

  // Inside the page as well, so the tabs do not appear a beat after the rest of
  // the window and shift everything under the pointer.
  if (isLoading) {
    return (
      <Page user={user}>
        <div className="py-24 flex justify-center"><Spinner /></div>
      </Page>
    );
  }

  // Being unable to ask GitHub is an outage, not a refusal. Showing the locked
  // screen here would tell somebody they had lost access they still have.
  if (isError || !perms) return <>{children}</>;

  const allowed = team === "aws" ? perms.isAwsAdmin : perms.isControlHubAdmin;
  if (allowed) return <>{children}</>;

  const teamName = team === "aws" ? perms.awsAdminTeam : perms.adminTeam;

  return (
    <Page user={user}>
      <Locked title={title} team={teamName} login={perms.login} kind={team} />
    </Page>
  );
}

function Locked({ title, team, login, kind }: {
  /** Null once permissions decide: the ask is then for a permission, not a team. */
  title: string; team: string | null; login: string; kind: "control-hub" | "aws";
}) {
  const navigate = useNavigate();
  const accent = kind === "aws"
    ? { ring: "border-ochre-edge", icon: "text-ochre", chip: "bg-ochre-wash text-ochre border-ochre-edge" }
    : { ring: "border-indigo-edge", icon: "text-indigo", chip: "bg-indigo-wash text-indigo border-indigo-edge" };

  return (
    <div className="min-h-[60vh] grid place-items-center px-6 py-16">
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
          {team === null
            ? "You have not been given access to this. A member of the Control Hub admin team can grant it on the Admin tab."
            : kind === "aws"
            ? "This tab acts on an AWS account rather than on repositories, so it is kept to the team that administers it."
            : "This screen gathers the whole organization's access in one place, which is why it is kept to the administrators' team."}
        </p>

        {/* The one fact that resolves this: the team to ask for, spelled the way
            it is spelled on GitHub. */}
        {team !== null && <div className="relative mt-6 inline-flex flex-col items-center gap-2">
          <span className="caps">
            Ask to be added to
          </span>
          <code className={`px-3 py-1.5 font-mono text-[0.8125rem] border ${accent.chip}`}>
            {team}
          </code>
        </div>}

        <p className="relative mt-7 text-[0.75rem] text-ink-3">
          Signed in as <span className="font-mono">{login}</span>.
        </p>

        {/* Said, and then offered. The sentence alone was the whole of the way
            out of here, and a sentence is not a door: the section line above is
            the real answer, and this is the one click for somebody who has
            just been told they cannot be where they are. */}
        <p className="standfirst relative mt-4 text-[0.7812rem] max-w-[42ch] mx-auto">
          Everything else in the app is still open to you — the sections above,
          and your own cards and alarms on <span className="font-semibold">My work</span>.
        </p>

        <div className="relative mt-5 flex justify-center">
          <Button variant="primary" onClick={() => navigate("/my-work")}>
            Go to My work
          </Button>
        </div>
      </div>
    </div>
  );
}
