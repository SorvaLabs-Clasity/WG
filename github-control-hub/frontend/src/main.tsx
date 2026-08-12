import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
/*
 * Fonts and icons, bundled rather than fetched.
 *
 * These came from three third-party CDNs at runtime — Google Fonts, cdnjs, and
 * an unpinned <script> from unpkg. That last one executed third-party
 * JavaScript, with no version and no integrity hash, inside an application
 * that administers a GitHub organisation and several AWS accounts. A bad day
 * at unpkg, or DNS pointed elsewhere, and it would have run with the
 * signed-in user's session.
 *
 * Imported here rather than from CSS because a bare @import is not resolved
 * against node_modules by the PostCSS pass; a JS import is.
 */
import "@fontsource/inter/300.css";
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "@fontsource/inter/700.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";

// Only the two weights the app uses.
import "@phosphor-icons/web/bold";
import "@phosphor-icons/web/fill";

import "@fortawesome/fontawesome-free/css/fontawesome.css";
import "@fortawesome/fontawesome-free/css/solid.css";
import "@fortawesome/fontawesome-free/css/regular.css";
import "@fortawesome/fontawesome-free/css/brands.css";

import "./index.css";
import App from "./App";
import { setToken, setUserInfo } from "./api/client";

const queryParams = new URLSearchParams(window.location.search);
const code = queryParams.get("code");
if (code) {
  const base = import.meta.env.VITE_BACKEND_URL || (import.meta.env.PROD ? "" : "http://localhost:4000");
  fetch(`${base}/auth/token?code=${encodeURIComponent(code)}`)
    .then((r) => r.json())
    .then((data: { token?: string; login?: string; avatarUrl?: string }) => {
      if (data.token) {
        setToken(data.token);
        if (data.login) {
          setUserInfo({ login: data.login, avatarUrl: data.avatarUrl || "" });
        }
      }
    })
    .catch(() => {})
    .finally(() => {
      window.history.replaceState({}, "", "/login");
      createRoot(document.getElementById("root")!).render(
        <StrictMode>
          <App />
        </StrictMode>
      );
    });
} else {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App />
    </StrictMode>
  );
}
