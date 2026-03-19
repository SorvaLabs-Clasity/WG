import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import authRoutes from "./routes/auth";
import repoRoutes from "./routes/repos";
import branchRoutes from "./routes/branches";
import protectionRoutes from "./routes/protection";
import activityRoutes from "./routes/activity";
import templateRoutes from "./routes/templates";
import ruleTemplateRoutes from "./routes/ruleTemplates";
import exclusionRoutes from "./routes/exclusions";
import scannerRoutes from "./routes/scanners";
import webhookRoutes from "./routes/webhooks";
import alertRoutes from "./routes/alerts";
import complianceRoutes from "./routes/compliance";
import dependencyRoutes from "./routes/dependencies";
import orgRoutes from "./routes/org";
import graphRoutes from "./routes/graph";
import widgetRoutes from "./routes/widgets";
import { authMiddleware } from "./middleware/authMiddleware";
import { awsHealthMiddleware } from "./middleware/awsHealthMiddleware";
import { initTokenManager } from "./github/client";

const app = express();
const PORT = Number(process.env.PORT) || 4000;

const frontendUrl = process.env.FRONTEND_URL || "http://localhost:5173";

app.use(
  cors({
    origin: frontendUrl,
    credentials: true,
  })
);

// Security headers
app.use(helmet({ contentSecurityPolicy: false }));

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

// Webhook route MUST be mounted before global express.json() so we can capture the raw body for HMAC verification
app.use("/api/webhooks", express.json({
  limit: "1mb",
  verify: (req: any, _res, buf) => { req.rawBody = buf; },
}), webhookRoutes);

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
app.use("/api/templates", authMiddleware, templateRoutes);
app.use("/api/rule-templates", authMiddleware, ruleTemplateRoutes);
app.use("/api/exclusions", authMiddleware, exclusionRoutes);
app.use("/api/scanners", authMiddleware, scannerRoutes);
app.use("/api/alerts", authMiddleware, alertRoutes);
app.use("/api/compliance", authMiddleware, complianceRoutes);
app.use("/api/security", authMiddleware, dependencyRoutes);
app.use("/api/org", authMiddleware, orgRoutes);
app.use("/api/graph", authMiddleware, graphRoutes);
app.use("/api/widgets", authMiddleware, widgetRoutes);

// Try to load secrets from Secrets Manager at startup (covers auto-connected AWS)
// then initialize the GitHub App token manager
(async () => {
  try {
    if (!process.env.GITHUB_CLIENT_ID) {
      const { SecretsManagerClient, GetSecretValueCommand } = await import("@aws-sdk/client-secrets-manager");
      const region = process.env.AWS_REGION || "us-east-1";
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

// When imported by standalone.ts or the desktop app, skip auto-listen
if (!process.env.__STANDALONE__) {
  app.listen(PORT, () => {
    console.log(`Backend running on http://localhost:${PORT}`);
  });
}

export default app;
