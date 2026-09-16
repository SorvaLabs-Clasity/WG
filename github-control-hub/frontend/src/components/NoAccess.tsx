import { useAuth } from "../App";
import { Page } from "../design";
import { COMPANY_NAME } from "../design/tokens";
import { usePermissionSet } from "../hooks/usePermissionSet";

/**
 * The whole app, said properly, for somebody deny-by-default has not reached
 * yet.
 *
 * `RequireTeam`'s `Locked` names one tab that is closed to somebody who can
 * still use everything else. This is the screen for the harder case: under
 * deny-by-default a new hire holds nothing until somebody grants it, and every
 * section line entry filters to nothing at once — so this *is* the app, for
 * them, until that happens. It follows `Locked`'s visual language rather than
 * inventing a second one, because the two are the same fact at different
 * scope: a door that says what is missing and who to ask.
 *
 * **Inside `<Page>`, which is where the navigation lives.** `RequireTeam` once
 * rendered its notice in place of the whole page instead of inside it, which
 * turned a locked door into a locked room — no section tabs, no account menu,
 * no theme picker and no way to sign out. Nothing behind this screen is
 * reachable yet, so the navigation is the only way out at all, and it must not
 * repeat that bug.
 *
 * Self-contained: it reads `usePermissionSet()` itself rather than taking the
 * team name as a prop, so anywhere this is mounted shows the same answer the
 * gates are actually enforcing.
 */
export default function NoAccess() {
  const { user } = useAuth();
  const { permissions } = usePermissionSet();
  const adminTeam = permissions?.adminTeam || "control-hub-admins";

  return (
    <Page user={user}>
      <div className="min-h-[60vh] grid place-items-center px-6 py-16">
        <div className="relative w-full max-w-lg text-center">
          {/* A ruled notice, not an error state. Nothing failed — deny by
              default is working exactly as meant, and this reads that way
              rather than as a warning. */}
          <div className="relative mx-auto w-16 h-16 grid place-items-center border border-crimson-edge">
            <i className="ph-bold ph-lock-key text-[1.625rem] text-crimson" aria-hidden="true" />
          </div>

          <h1 className="display text-[clamp(1.75rem,3vw,2.25rem)] text-ink relative mt-7">
            {COMPANY_NAME} has not granted you any permissions yet
          </h1>

          <p className="standfirst relative mt-3 text-[0.875rem] max-w-[46ch] mx-auto">
            Nothing in the app opens until somebody grants at least one. This is
            expected for a new arrival — access here is handed out deliberately,
            not assumed from joining the organization.
          </p>

          {/* The one fact that resolves this: the team to ask for, spelled the
              way it is spelled on GitHub. */}
          <div className="relative mt-6 inline-flex flex-col items-center gap-2">
            <span className="caps">Ask to be added to</span>
            <code className="px-3 py-1.5 font-mono text-[0.8125rem] border bg-crimson-wash text-crimson border-crimson-edge">
              {adminTeam}
            </code>
          </div>

          {user?.login && (
            <p className="relative mt-7 text-[0.75rem] text-ink-3">
              Signed in as <span className="font-mono">{user.login}</span>.
              Organization owners are admitted without being on the team.
            </p>
          )}
        </div>
      </div>
    </Page>
  );
}
