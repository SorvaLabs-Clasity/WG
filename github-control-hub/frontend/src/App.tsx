import { createContext, useContext, useCallback, useEffect, useMemo, useState } from "react";
import { RouterProvider } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { router } from "./router";
import { isAuthenticated, clearToken, getToken, getUserInfo, DEMO_MODE } from "./api/client";
import { fetchAuthStatus } from "./api/auth";
import { DEMO_USER } from "./api/mock";
import { ThemeContext, getInitialTheme, applyTheme, type Theme } from "./hooks/useTheme";
import UpdateOverlay from "./components/UpdateOverlay";
import MutationErrors from "./components/MutationErrors";

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
    // JWTs are base64url — "-" and "_" instead of "+" and "/", padding dropped.
    // atob rejects both, so decoding worked only for payloads that happened to
    // produce neither character.
    const part = token.split(".")[1];
    if (!part) return null;
    const b64 = part.replace(/-/g, "+").replace(/_/g, "/")
      .padEnd(part.length + ((4 - (part.length % 4)) % 4), "=");
    return JSON.parse(decodeURIComponent(
      atob(b64).split("").map(c => "%" + c.charCodeAt(0).toString(16).padStart(2, "0")).join("")
    ));
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
    // Read through getToken rather than reaching into storage directly. This
    // used to call localStorage.getItem("gh_hub_token") while setToken wrote to
    // sessionStorage — same key, different store — so isAuthenticated() said
    // yes and this said no. The navbar's whole account block is gated on the
    // result, which is why the avatar and sign-out never appeared.
    const token = getToken();
    if (!token) return null;

    const payload = parseJwt(token);
    if (payload?.login) {
      return { login: payload.login as string, avatarUrl: (payload.avatarUrl as string) || "" };
    }
    // A token we cannot read is still a session. The login is stored separately
    // at sign-in, so fall back to that instead of rendering as signed out.
    const stored = getUserInfo();
    return stored ? { login: stored.login, avatarUrl: stored.avatarUrl } : null;
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
          <UpdateOverlay />
          <MutationErrors />
          <RouterProvider router={router} />
        </AuthContext.Provider>
      </QueryClientProvider>
    </ThemeContext.Provider>
  );
}
