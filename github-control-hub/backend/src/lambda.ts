/**
 * AWS Lambda handler for the GitHub Control Hub backend.
 * Loads secrets from Secrets Manager on cold start, then proxies
 * requests through the Express app via serverless-express.
 *
 * When deploying, install @aws-sdk/client-secrets-manager and
 * @vendia/serverless-express as production dependencies.
 */
import "dotenv/config";

let initialized = false;

async function loadSecrets() {
  if (initialized) return;

  const secretId = process.env.SECRET_NAME;
  if (!secretId) {
    console.warn("Lambda: SECRET_NAME not set, skipping secrets load");
    initialized = true;
    return;
  }

  try {
    const { SecretsManagerClient, GetSecretValueCommand } = await import(
      "@aws-sdk/client-secrets-manager"
    );
    const client = new SecretsManagerClient({});
    const result = await client.send(new GetSecretValueCommand({ SecretId: secretId }));

    if (result.SecretString) {
      const secrets = JSON.parse(result.SecretString) as Record<string, string>;
      process.env.GITHUB_CLIENT_ID = secrets.GITHUB_CLIENT_ID;
      process.env.GITHUB_CLIENT_SECRET = secrets.GITHUB_CLIENT_SECRET;
      process.env.JWT_SECRET = secrets.JWT_SECRET;
      if (secrets.SYSTEM_GITHUB_TOKEN) process.env.SYSTEM_GITHUB_TOKEN = secrets.SYSTEM_GITHUB_TOKEN;
      if (secrets.GITHUB_WEBHOOK_SECRET) process.env.GITHUB_WEBHOOK_SECRET = secrets.GITHUB_WEBHOOK_SECRET;
    }
  } catch (err) {
    console.error("Lambda: failed to load secrets from Secrets Manager:", err);
    return; // leave initialized false so we retry on next request
  }

  initialized = true;
}

export async function handler(event: any, context: any) {
  try {
    await loadSecrets();

    const serverlessExpress = await import("@vendia/serverless-express");
    const { default: app } = await import("./server");
    const serverlessHandler = serverlessExpress.configure({ app });
    return serverlessHandler(event, context, () => {});
  } catch (err) {
    console.error("Lambda handler error:", err);
    const message = err instanceof Error ? err.message : "Internal server error";
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Internal server error", detail: message }),
    };
  }
}
