import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App";
import { setToken } from "./api/client";

// After OAuth, backend redirects to /?code=ONE_TIME_CODE. Exchange it for the token so we don't rely on hash/query.
const queryParams = new URLSearchParams(window.location.search);
const code = queryParams.get("code");
if (code) {
  const base = import.meta.env.VITE_BACKEND_URL || (import.meta.env.PROD ? "" : "http://localhost:4000");
  fetch(`${base}/auth/token?code=${encodeURIComponent(code)}`)
    .then((r) => r.json())
    .then((data: { token?: string }) => {
      if (data.token) {
        setToken(data.token);
      }
    })
    .catch(() => {})
    .finally(() => {
      window.history.replaceState({}, "", window.location.pathname || "/");
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
