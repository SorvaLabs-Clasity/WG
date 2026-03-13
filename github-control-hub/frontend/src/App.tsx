import { createContext, useContext, useCallback, useEffect, useMemo, useState } from "react";
import { RouterProvider } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { router } from "./router";
import { isAuthenticated, clearToken, DEMO_MODE } from "./api/client";
import { fetchAuthStatus } from "./api/auth";
import { DEMO_USER } from "./api/mock";
import { ThemeContext, getInitialTheme, applyTheme, type Theme } from "./hooks/useTheme";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

interface User {
  login: string;
  avatarUrl: string;
}

interface AuthContextValue {
  user: User | null;
}

const AuthContext = createContext<AuthContextValue>({ user: null });

export function useAuth() {
  return useContext(AuthContext);
}

function parseJwt(token: string): Record<string, unknown> | null {
  try {
    const payload = token.split(".")[1];
    return JSON.parse(atob(payload));
  } catch {
    return null;
  }
}

export default function App() {
  const [theme, setTheme] = useState<Theme>(getInitialTheme);

  useEffect(() => { applyTheme(theme); }, [theme]);

  const toggleTheme = useCallback(() => {
    setTheme(prev => (prev === "light" ? "dark" : "light"));
  }, []);

  const themeValue = useMemo(() => ({ theme, toggle: toggleTheme }), [theme, toggleTheme]);

  const user = useMemo<User | null>(() => {
    if (DEMO_MODE) return DEMO_USER;
    if (!isAuthenticated()) return null;
    const token = localStorage.getItem("gh_hub_token");
    if (!token) return null;
    const payload = parseJwt(token);
    if (!payload) return null;
    return {
      login: payload.login as string,
      avatarUrl: payload.avatarUrl as string,
    };
  }, []);

  useEffect(() => {
    if (DEMO_MODE || !isAuthenticated()) return;
    const interval = setInterval(async () => {
      try {
        const status = await fetchAuthStatus();
        if (!status.aws.dynamoReachable) {
          clearToken();
          window.location.href = "/login";
        }
      } catch {
        // Backend unreachable — redirect to login
        clearToken();
        window.location.href = "/login";
      }
    }, 60_000);
    return () => clearInterval(interval);
  }, []);

  return (
    <ThemeContext.Provider value={themeValue}>
      <QueryClientProvider client={queryClient}>
        <AuthContext.Provider value={{ user }}>
          <RouterProvider router={router} />
        </AuthContext.Provider>
      </QueryClientProvider>
    </ThemeContext.Provider>
  );
}
