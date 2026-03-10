const DEMO_MODE = import.meta.env.VITE_DEMO_MODE === "true";

// In production, use same origin (/auth/github) so CloudFront handles it. In dev, use local backend.
const BACKEND_URL =
  import.meta.env.VITE_BACKEND_URL !== undefined && import.meta.env.VITE_BACKEND_URL !== ""
    ? import.meta.env.VITE_BACKEND_URL
    : import.meta.env.PROD
      ? ""
      : "http://localhost:4000";

export function getLoginUrl(): string {
  return `${BACKEND_URL}/auth/github`;
}
