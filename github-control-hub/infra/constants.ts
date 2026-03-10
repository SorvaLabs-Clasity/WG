/**
 * Deployment configuration. Edit these values before running npm run deploy.
 * Do not commit real production URLs or org names if this repo is public.
 */
export default {
  /** AWS Secrets Manager secret name (e.g. "github-control-hub/secrets") */
  SecretName: "github-control-hub/secrets",

  /** Your GitHub organization name (e.g. "my-company") */
  GitHubOrg: "SorvaLabs-Clasity",

  /** Full URL of the frontend after deploy (e.g. https://d1234abcd.cloudfront.net) */
  FrontendUrl: "https://d7qmt3lqskpvl.cloudfront.net",

  /** Full URL of the API Gateway stage (e.g. https://abc123.execute-api.us-east-1.amazonaws.com/prod) */
  BackendUrl: "https://d7qmt3lqskpvl.cloudfront.net",
};
