import { createContext, useContext, useMemo } from "react";
import { RouterProvider } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { router } from "./router";
import { isAuthenticated, DEMO_MODE } from "./api/client";
import { DEMO_USER } from "./api/mock";

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

  return (
    <QueryClientProvider client={queryClient}>
      <AuthContext.Provider value={{ user }}>
        <RouterProvider router={router} />
      </AuthContext.Provider>
    </QueryClientProvider>
  );
}
