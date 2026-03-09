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

  const arn = process.env.SECRETS_ARN;
  if (!arn) {
    initialized = true;
    return;
  }

  const { SecretsManagerClient, GetSecretValueCommand } = await import(
    "@aws-sdk/client-secrets-manager"
  );
  const client = new SecretsManagerClient({});
  const result = await client.send(new GetSecretValueCommand({ SecretId: arn }));

  if (result.SecretString) {
    const secrets = JSON.parse(result.SecretString) as Record<string, string>;
    process.env.GITHUB_CLIENT_ID = secrets.GITHUB_CLIENT_ID;
    process.env.GITHUB_CLIENT_SECRET = secrets.GITHUB_CLIENT_SECRET;
    process.env.JWT_SECRET = secrets.JWT_SECRET;
  }

  initialized = true;
}

export async function handler(event: unknown, context: unknown) {
  await loadSecrets();

  const serverlessExpress = await import("@vendia/serverless-express");
  const { default: app } = await import("./server");
  const serverlessHandler = serverlessExpress.configure({ app });
  return serverlessHandler(event, context);
}
