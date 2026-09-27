import { createBrowserRouter, Navigate } from "react-router-dom";
import { useGithubAvailable } from "./hooks/useGithubAvailable";
import LoginPage from "./pages/LoginPage";
import AuthCallback from "./pages/AuthCallback";
import ActivityPage from "./pages/ActivityPage";
import AccessPage from "./pages/AccessPage";
import AlarmsPage from "./pages/AlarmsPage";
import DependencyDashboardPage from "./pages/DependencyDashboardPage";
import KnowledgeGraphPage from "./pages/KnowledgeGraphPage";
import AnalyticsPage from "./pages/AnalyticsPage";
import AwsPage from "./pages/AwsPage";
import ExpertisePage from "./pages/ExpertisePage";
import MyWorkPage from "./pages/MyWorkPage";
import PullRequestsPage from "./pages/PullRequestsPage";
import AdminPage from "./pages/AdminPage";
import { isAuthenticated } from "./api/client";
import RequireTeam from "./components/RequireTeam";
import { sectionPermissions } from "./lib/sections";
import NoAccess from "./components/NoAccess";
import { usePermissions } from "./hooks/usePermissions";
import { usePermissionSet, useTeamOr } from "./hooks/usePermissionSet";

/**
 * Where the app opens.
 *
 * Overview for the people who can read it, My work for everybody else. Sending
 * everyone to Overview would open the app on a locked door for most of the
 * organization, which is a poor first impression of a screen that is working
 * exactly as intended.
 *
 * While permissions are loading, nothing is decided: guessing and correcting
 * would bounce somebody between two tabs on every launch.
 */
function Home() {
  const { isLoading } = usePermissions();
  const set = usePermissionSet();
  const github = useGithubAvailable();
  const overview = useTeamOr("control-hub", "overview.read", "overview.cards.read");
  // Every answer the choice depends on, not only the first to arrive: deciding
  // on the team answer alone sent people who hold Overview to My work whenever
  // their permissions landed a moment later.
  if (isLoading || (!set.permissions && set.isLoading) || github === undefined) return null;
  // An AWS-only account has one place to start.
  if (!github) return <Navigate to="/aws" replace />;
  return <Navigate to={overview ? "/analytics" : "/my-work"} replace />;
}

/**
 * The door for somebody deny-by-default has not reached yet.
 *
 * `NoAccess` existed and nothing rendered it, so under enforcement a new hire
 * holding nothing would get an empty section line over whichever page they
 * landed on, and every panel on it answering 403 — the app looking broken
 * rather than the app saying it has not been opened to them yet.
 *
 * Only when the server has actually said so: the file was read (`!failure`),
 * there is an organization to read it from (`!inert`), the flag is on
 * (`enforced`) and it names them nowhere (`held.length === 0`). While the flag
 * is off, or while the answer is still loading, `noAccess` is false and this
 * component is not in the way of anything.
 *
 * Wrapped around the routed page rather than around the whole app, because
 * `NoAccess` renders inside `<Page>` and needs the navigation — the one way
 * out of a screen where nothing else is reachable.
 */
function RequirePermissions({ children }: { children: React.ReactNode }) {
  const { noAccess } = usePermissionSet();
  if (noAccess) return <NoAccess />;
  return <>{children}</>;
}

function RequireAuth({ children }: { children: React.ReactNode }) {
  if (!isAuthenticated()) {
    return <Navigate to="/login" replace />;
  }
  return <RequirePermissions>{children}</RequirePermissions>;
}

export const router = createBrowserRouter([
  {
    path: "/login",
    element: <LoginPage />,
  },
  {
    path: "/auth/callback",
    element: <AuthCallback />,
  },
  {
    path: "/",
    element: <RequireAuth><Home /></RequireAuth>,
  },
  {
    path: "/pulls",
    element: (
      <RequireAuth>
        <RequireTeam title="Pull requests" permissions={sectionPermissions("/pulls")}>
          <PullRequestsPage />
        </RequireTeam>
      </RequireAuth>
    ),
  },
  {
    path: "/my-work",
    element: (
      <RequireAuth>
        <RequireTeam title="My work" permissions={sectionPermissions("/my-work")}>
          <MyWorkPage />
        </RequireTeam>
      </RequireAuth>
    ),
  },
  {
    path: "/who-knows",
    element: (
      <RequireAuth>
        <RequireTeam title="Who knows" permissions={sectionPermissions("/who-knows")}>
          <ExpertisePage />
        </RequireTeam>
      </RequireAuth>
    ),
  },
  {
    path: "/activity",
    element: (
      <RequireAuth>
        <RequireTeam title="Activity" permissions={sectionPermissions("/activity")}>
          <ActivityPage />
        </RequireTeam>
      </RequireAuth>
    ),
  },
  {
    path: "/analytics",
    element: (
      <RequireAuth>
        <RequireTeam team="control-hub" title="Overview" permissions={sectionPermissions("/analytics")}>
          <AnalyticsPage />
        </RequireTeam>
      </RequireAuth>
    ),
  },
  {
    path: "/access",
    element: (
      <RequireAuth>
        <RequireTeam team="control-hub" title="Access" permissions={sectionPermissions("/access")}>
          <AccessPage />
        </RequireTeam>
      </RequireAuth>
    ),
  },
  {
    path: "/alarms",
    element: (
      <RequireAuth>
        <RequireTeam title="Alarms" permissions={sectionPermissions("/alarms")}>
          <AlarmsPage />
        </RequireTeam>
      </RequireAuth>
    ),
  },
  {
    // The Security tab is gone: everything it held moved to Activity, under
    // Important events, including the notification settings for those events.
    //
    // Kept as a redirect rather than removed outright. The desktop app restores
    // the route it was last on, so somebody who quit while on this tab would
    // reopen to a blank screen, and anyone with it bookmarked gets sent
    // somewhere useful instead of nowhere.
    path: "/security",
    element: <Navigate to="/activity" replace />,
  },
  {
    path: "/dependencies",
    element: (
      <RequireAuth>
        <RequireTeam title="Vulnerabilities" permissions={sectionPermissions("/dependencies")}>
          <DependencyDashboardPage />
        </RequireTeam>
      </RequireAuth>
    ),
  },
  {
    path: "/aws",
    element: (
      <RequireAuth>
        <RequireTeam team="aws" title="AWS" permissions={sectionPermissions("/aws")}>
          <AwsPage />
        </RequireTeam>
      </RequireAuth>
    ),
  },
  {
    path: "/graph",
    element: (
      <RequireAuth>
        <RequireTeam title="Repos" permissions={sectionPermissions("/graph")}>
          <KnowledgeGraphPage />
        </RequireTeam>
      </RequireAuth>
    ),
  },
  {
    path: "/admin",
    element: (
      <RequireAuth>
        {/*
          * The same team gate `/access` and `/analytics` carry, and for a
          * stronger reason: this screen grants permissions. `usePermissionSet`
          * answers true to every key while enforcement is off, so without this
          * the tab and every button inside it — including "Run the migration"
          * and "Create the permissions repository" — were live for every
          * signed-in member.
          */}
        <RequireTeam team="control-hub" title="Admin" permissions={sectionPermissions("/admin")}>
          <AdminPage />
        </RequireTeam>
      </RequireAuth>
    ),
  }
]);
