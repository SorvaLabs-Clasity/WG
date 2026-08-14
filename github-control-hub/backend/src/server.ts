import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import authRoutes from "./routes/auth";
import awsGuardrailRoutes from "./routes/awsGuardrails";
import repoRoutes from "./routes/repos";
import branchRoutes from "./routes/branches";
import protectionRoutes from "./routes/protection";
import activityRoutes from "./routes/activity";
import scannerRoutes from "./routes/scanners";
import alertRoutes from "./routes/alerts";
import complianceRoutes from "./routes/compliance";
import dependencyRoutes from "./routes/dependencies";
import orgRoutes from "./routes/org";
import graphRoutes from "./routes/graph";
import accessRoutes from "./routes/access";
import widgetRoutes from "./routes/widgets";
import configRoutes from "./routes/config";
import { authMiddleware } from "./middleware/authMiddleware";
import { awsHealthMiddleware } from "./middleware/awsHealthMiddleware";
import { initTokenManager } from "./github/client";
import { awsRegion } from "./utils/region";

const app = express();
const PORT = Number(process.env.PORT) || 4000;

const frontendUrl = process.env.FRONTEND_URL || "http://localhost:5173";

app.use(
  cors({
    origin: frontendUrl,
    credentials: true,
  })
);

// Security headers.
//
// The policy was off because the page pulled fonts and icons from three CDNs,
// one of them an unpinned <script> from unpkg. Those are bundled now, so
// everything the app loads comes from its own origin and the policy can say
// so — which is what turns "we do not load remote script" from a habit into
// something the browser enforces.
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      defaultSrc: ["'self'"],
      // No remote script, and no inline script: Vite emits a module tag, never
      // inline code. This is the directive that matters most here — it is the
      // one that would have stopped a compromised CDN.
      scriptSrc: ["'self'"],
      // React writes style attributes, which this covers. Stylesheets
      // themselves are same-origin files.
      styleSrc: ["'self'", "'unsafe-inline'"],
      fontSrc: ["'self'"],
      // Avatars. github.com redirects to avatarsN.githubusercontent.com, so
      // both have to be allowed; data: is the inline favicon.
      imgSrc: ["'self'", "data:", "https://github.com", "https://*.githubusercontent.com"],
      // The app only ever calls its own backend.
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      frameAncestors: ["'none'"],
      // Desktop serves over http on localhost; upgrading those breaks it.
      upgradeInsecureRequests: null,
    },
  },
  // The app is served over a self-signed certificate on an IP address, so a
  // long HSTS max-age would be a promise it cannot keep.
  hsts: false,
}));

// Rate limiting — strict for auth, moderate for API
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, please try again later" },
  skip: (req) => req.path === "/verify" || req.path === "/status",
});

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, please try again later" },
});

app.use(express.json({ limit: "1mb" }));

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.use("/auth", authLimiter, authRoutes);

app.use("/api", apiLimiter, awsHealthMiddleware);

app.use("/api/repos", authMiddleware, repoRoutes);
app.use("/api/repos", authMiddleware, branchRoutes);
app.use("/api/repos", authMiddleware, protectionRoutes);
app.use("/api/activity", authMiddleware, activityRoutes);
app.use("/api/scanners", authMiddleware, scannerRoutes);
app.use("/api/alerts", authMiddleware, alertRoutes);
app.use("/api/compliance", authMiddleware, complianceRoutes);
app.use("/api/security", authMiddleware, dependencyRoutes);
app.use("/api/org", authMiddleware, orgRoutes);
app.use("/api/graph", authMiddleware, graphRoutes);
app.use("/api/access", authMiddleware, accessRoutes);
app.use("/api/widgets", authMiddleware, widgetRoutes);
app.use("/api/config", authMiddleware, configRoutes);
app.use("/api/aws", authMiddleware, awsGuardrailRoutes);

// Try to load secrets from Secrets Manager at startup (covers auto-connected AWS)
// then initialize the GitHub App token manager
(async () => {
  // Before anything reaches for credentials. The desktop app's AWS profile
  // lived only in process.env, so closing the window forgot it and every
  // launch fell back to "default" — a sign-in you had already done, asked for
  // again. Restored first so the secrets load below uses the right account.
  try {
    const { restoreAwsProfile } = await import("./services/desktopPrefs");
    const restored = restoreAwsProfile();
    if (restored) console.log(`[server] Using remembered AWS profile "${restored}"`);
  } catch { /* a preference file must never stop the server starting */ }

  try {
    if (!process.env.GITHUB_CLIENT_ID) {
      const { SecretsManagerClient, GetSecretValueCommand } = await import("@aws-sdk/client-secrets-manager");
      const region = awsRegion();
      const secretName = process.env.SECRET_NAME || `${process.env.STACK_NAME || "github-control-hub"}/secrets`;
      const client = new SecretsManagerClient({ region });
      const result = await client.send(new GetSecretValueCommand({ SecretId: secretName }));
      if (result.SecretString) {
        const secrets = JSON.parse(result.SecretString) as Record<string, string>;
        for (const key of [
          "GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET", "SYSTEM_GITHUB_TOKEN",
          "GITHUB_WEBHOOK_SECRET", "GITHUB_ORG", "JWT_SECRET",
          "GITHUB_APP_ID", "GITHUB_APP_PRIVATE_KEY", "GITHUB_APP_INSTALLATION_ID",
        ]) {
          if (secrets[key]) process.env[key] = secrets[key];
        }
        if (!process.env.JWT_SECRET) {
          const crypto = await import("crypto");
          process.env.JWT_SECRET = crypto.randomBytes(32).toString("hex");
        }
        console.log("[server] Secrets loaded from Secrets Manager at startup");
      }
    }
  } catch (err: any) {
    console.warn("[server] Could not load secrets at startup:", err.message);
  }

  if (process.env.GITHUB_APP_ID && process.env.GITHUB_APP_PRIVATE_KEY && process.env.GITHUB_APP_INSTALLATION_ID) {
    initTokenManager(process.env.GITHUB_APP_ID, process.env.GITHUB_APP_PRIVATE_KEY, process.env.GITHUB_APP_INSTALLATION_ID)
      .then(() => console.log("[server] GitHub App token manager initialized"))
      .catch((err) => console.warn("[server] Could not initialize GitHub App token manager:", (err as Error).message));
  }
})();

// When imported by the desktop app, skip auto-listen — it calls listen() itself
if (!process.env.__STANDALONE__) {
  // Loopback. This branch is the developer's local server, whose only client is
  // Vite on the same machine; binding every interface published an unfinished
  // build holding real org credentials to the coffee-shop network.
  app.listen(PORT, "127.0.0.1", () => {
    console.log(`Backend running on http://127.0.0.1:${PORT}`);
  });
}

export default app;
