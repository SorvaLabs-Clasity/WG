import { createBrowserRouter, Navigate } from "react-router-dom";
import LoginPage from "./pages/LoginPage";
import AuthCallback from "./pages/AuthCallback";
import ActivityPage from "./pages/ActivityPage";
import AccessPage from "./pages/AccessPage";
import SecurityPage from "./pages/SecurityPage";
import AlarmsPage from "./pages/AlarmsPage";
import DependencyDashboardPage from "./pages/DependencyDashboardPage";
import KnowledgeGraphPage from "./pages/KnowledgeGraphPage";
import AnalyticsPage from "./pages/AnalyticsPage";
import AwsPage from "./pages/AwsPage";
import ExpertisePage from "./pages/ExpertisePage";
import ResourcesPage from "./pages/ResourcesPage";
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
    path: "/resources",
    element: (
      <RequireAuth>
        <ResourcesPage />
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
    path: "/security",
    element: (
      <RequireAuth>
        <SecurityPage />
      </RequireAuth>
    ),
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
