/**
 * Standalone server entry point for EC2 / Docker deployment.
 * Loads secrets, resolves table names, serves backend + frontend.
 *
 * Usage:  node dist/standalone.js
 */
import path from "path";
import fs from "fs";
import crypto from "crypto";
import https from "https";
import express from "express";

// ── Bootstrap (same logic as desktop app bootstrap.ts) ──

function getPrefix(): string {
  return process.env.STACK_NAME || "github-control-hub";
}

function getRegion(): string {
  return process.env.AWS_REGION || "us-east-1";
}

function getSecretName(): string {
  return process.env.SECRET_NAME || `${getPrefix()}/secrets`;
}

function resolveTableNames(): void {
  const prefix = getPrefix();
  const tables: Record<string, string> = {
    ACTIVITY_TABLE: `${prefix}-activity`,
    TEMPLATES_TABLE: `${prefix}-templates`,
    SCANNERS_TABLE: `${prefix}-scanners`,
    ALERTS_TABLE: `${prefix}-alerts`,
    ORG_CONFIG_TABLE: `${prefix}-org-config`,
    AUTH_CODES_TABLE: `${prefix}-auth-codes`,
    GRAPH_EDGES_TABLE: `${prefix}-graph-edges`,
    EXCLUSIONS_TABLE: `${prefix}-exclusions`,
    WIDGETS_TABLE: `${prefix}-widgets`,
    COMPLIANCE_CACHE_TABLE: `${prefix}-compliance-cache`,
    RULE_TEMPLATES_TABLE: `${prefix}-rule-templates`,
  };
  for (const [key, val] of Object.entries(tables)) {
    if (!process.env[key]) process.env[key] = val;
  }
}

async function loadSecrets(): Promise<void> {
  if (process.env.GITHUB_CLIENT_ID) return;
  try {
    const { SecretsManagerClient, GetSecretValueCommand } = await import("@aws-sdk/client-secrets-manager");
    const client = new SecretsManagerClient({ region: getRegion() });
    const result = await client.send(new GetSecretValueCommand({ SecretId: getSecretName() }));
    if (result.SecretString) {
      const secrets = JSON.parse(result.SecretString) as Record<string, string>;
      for (const key of ["GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET", "SYSTEM_GITHUB_TOKEN", "GITHUB_WEBHOOK_SECRET", "GITHUB_ORG", "JWT_SECRET"]) {
        if (secrets[key]) process.env[key] = secrets[key];
      }
    }
  } catch (err: any) {
    if (err.name !== "CredentialsProviderError") {
      console.warn(`Warning: Could not load secrets from "${getSecretName()}": ${err.message}`);
    }
  }
}

// ── Main ──

async function main(): Promise<void> {
  const PORT = Number(process.env.PORT) || 4321;

  // Prevent server.ts from calling app.listen() — standalone handles it
  process.env.__STANDALONE__ = "1";
  // Mark as server deployment — disables AWS credential management endpoints
  process.env.__SERVER_MODE__ = "1";

  if (!process.env.AWS_REGION) process.env.AWS_REGION = getRegion();
  resolveTableNames();
  await loadSecrets();

  if (!process.env.JWT_SECRET) {
    process.env.JWT_SECRET = crypto.randomBytes(32).toString("hex");
  }

  // Check for SSL certificates (HTTPS mode)
  const SSL_CERT = process.env.SSL_CERT || "/etc/ssl/github-control-hub/server.crt";
  const SSL_KEY = process.env.SSL_KEY || "/etc/ssl/github-control-hub/server.key";
  const useHttps = fs.existsSync(SSL_CERT) && fs.existsSync(SSL_KEY);

  // Set FRONTEND_URL and BACKEND_URL if not already set
  const protocol = useHttps ? "https" : "http";
  const host = process.env.BACKEND_URL || `${protocol}://localhost:${PORT}`;
  if (!process.env.FRONTEND_URL) process.env.FRONTEND_URL = host;
  if (!process.env.BACKEND_URL) process.env.BACKEND_URL = host;
  process.env.PORT = String(PORT);

  // Import the Express app (server.ts will skip app.listen because __STANDALONE__ is set)
  const { default: app } = await import("./server");

  // Serve frontend static files
  const frontendDir = path.resolve(__dirname, "../../frontend/dist");
  if (fs.existsSync(frontendDir)) {
    app.use(express.static(frontendDir));

    // SPA fallback — serve index.html for non-API routes
    app.get("*", (req, res, next) => {
      if (req.path.startsWith("/api") || req.path.startsWith("/auth") || req.path.startsWith("/health")) {
        return next();
      }
      res.sendFile(path.join(frontendDir, "index.html"));
    });

    console.log(`[standalone] Serving frontend from ${frontendDir}`);
  } else {
    console.warn(`[standalone] Frontend not found at ${frontendDir} — serving API only`);
  }

  if (useHttps) {
    const cert = fs.readFileSync(SSL_CERT);
    const key = fs.readFileSync(SSL_KEY);
    https.createServer({ cert, key }, app).listen(PORT, () => {
      console.log(`[standalone] GitHub Control Hub running on https://localhost:${PORT}`);
    });
  } else {
    app.listen(PORT, () => {
      console.log(`[standalone] GitHub Control Hub running on http://localhost:${PORT} (no SSL certs found — HTTP mode)`);
    });
  }
}

main().catch((err) => {
  console.error("Failed to start:", err);
  process.exit(1);
});
