import { createContext, useContext, useCallback, useEffect, useMemo, useState } from "react";
import { RouterProvider } from "react-router-dom";
import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { router } from "./router";
import { isAuthenticated, clearToken, getToken, getUserInfo, DEMO_MODE } from "./api/client";
import { fetchAuthStatus } from "./api/auth";
import { DEMO_USER } from "./api/mock";
import { ThemeContext, getInitialTheme, applyTheme, type Theme } from "./hooks/useTheme";
import UpdateOverlay from "./components/UpdateOverlay";
import MutationErrors from "./components/MutationErrors";
import RateLimitBanner from "./components/RateLimitBanner";
import { apiGet } from "./api/client";

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

/**
 * Starts the pull request query as soon as somebody is signed in.
 *
 * The list is the slowest thing this app fetches: GitHub's search API is walked
 * a page at a time, and a large organization is several seconds per page. Doing
 * that when the tab is *clicked* meant every launch had one long wait in it,
 * always at the moment somebody was waiting.
 *
 * Nothing about the data changes — the query, its cache key and its polling are
 * the same. It simply starts while the app is being read rather than after a
 * click, so the answer is usually already there. If it is not, the tab shows its
 * ordinary loading state.
 *
 * Once, and only when signed in: prefetch respects the query's staleTime, so
 * the tab reuses this rather than asking again.
 */
function PrefetchPulls() {
  const qc = useQueryClient();
  const { user } = useAuth();
  useEffect(() => {
    if (!user) return;
    void qc.prefetchQuery({
      queryKey: ["pulls"],
      queryFn: () => apiGet("/pulls"),
      staleTime: 15_000,
    });
  }, [user, qc]);
  return null;
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
          <PrefetchPulls />
          <UpdateOverlay />
          <MutationErrors />
          <RateLimitBanner />
          <RouterProvider router={router} />
        </AuthContext.Provider>
      </QueryClientProvider>
    </ThemeContext.Provider>
  );
}
