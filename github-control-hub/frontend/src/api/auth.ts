const DEMO_MODE = import.meta.env.VITE_DEMO_MODE === "true";

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || "http://localhost:4000";

export function getLoginUrl(): string {
  return `${BACKEND_URL}/auth/github`;
}
