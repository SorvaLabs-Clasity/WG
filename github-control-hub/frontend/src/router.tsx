import { createBrowserRouter, Navigate } from "react-router-dom";
import Dashboard from "./pages/Dashboard";
import RepoPage from "./pages/RepoPage";
import LoginPage from "./pages/LoginPage";
import AuthCallback from "./pages/AuthCallback";
import ActivityPage from "./pages/ActivityPage";
import TemplatesPage from "./pages/TemplatesPage";
import MonitoringPage from "./pages/MonitoringPage";
import SecurityPage from "./pages/SecurityPage";
import ComplianceDashboardPage from "./pages/ComplianceDashboardPage";
import DependencyDashboardPage from "./pages/DependencyDashboardPage";
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
    element: (
      <RequireAuth>
        <Dashboard />
      </RequireAuth>
    ),
  },
  {
    path: "/repo/:repo",
    element: (
      <RequireAuth>
        <RepoPage />
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
    path: "/templates",
    element: (
      <RequireAuth>
        <TemplatesPage />
      </RequireAuth>
    ),
  },
  {
    path: "/monitoring",
    element: (
      <RequireAuth>
        <MonitoringPage />
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
    path: "/compliance",
    element: (
      <RequireAuth>
        <ComplianceDashboardPage />
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
]);
