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
    element: <Navigate to="/analytics" replace />,
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
        <AnalyticsPage />
      </RequireAuth>
    ),
  },
  {
    path: "/access",
    element: (
      <RequireAuth>
        <AccessPage />
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
        <AwsPage />
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
