import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
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
