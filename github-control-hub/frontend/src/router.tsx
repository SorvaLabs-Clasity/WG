import { createBrowserRouter, Navigate } from "react-router-dom";
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
import { isAuthenticated } from "./api/client";
import RequireTeam from "./components/RequireTeam";
import { usePermissions } from "./hooks/usePermissions";

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
  const { data: perms, isLoading } = usePermissions();
  if (isLoading) return null;
  return <Navigate to={perms?.isControlHubAdmin ? "/analytics" : "/my-work"} replace />;
}

function RequireAuth({ children }: { children: React.ReactNode }) {
  if (!isAuthenticated()) {
    return <Navigate to="/login" replace />;
  }
  return <>{children}</>;
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
        <PullRequestsPage />
      </RequireAuth>
    ),
  },
  {
    path: "/my-work",
    element: (
      <RequireAuth>
        <MyWorkPage />
      </RequireAuth>
    ),
  },
  {
    path: "/who-knows",
    element: (
      <RequireAuth>
        <ExpertisePage />
      </RequireAuth>
    ),
  },
  {
    path: "/activity",
    element: (
      <RequireAuth>
        <ActivityPage />
      </RequireAuth>
    ),
  },
  {
    path: "/analytics",
    element: (
      <RequireAuth>
        <RequireTeam team="control-hub" title="Overview">
          <AnalyticsPage />
        </RequireTeam>
      </RequireAuth>
    ),
  },
  {
    path: "/access",
    element: (
      <RequireAuth>
        <RequireTeam team="control-hub" title="Access">
          <AccessPage />
        </RequireTeam>
      </RequireAuth>
    ),
  },
  {
    path: "/alarms",
    element: (
      <RequireAuth>
        <AlarmsPage />
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
        <DependencyDashboardPage />
      </RequireAuth>
    ),
  },
  {
    path: "/aws",
    element: (
      <RequireAuth>
        <RequireTeam team="aws" title="AWS">
          <AwsPage />
        </RequireTeam>
      </RequireAuth>
    ),
  },
  {
    path: "/graph",
    element: (
      <RequireAuth>
        <KnowledgeGraphPage />
      </RequireAuth>
    ),
  }
]);
