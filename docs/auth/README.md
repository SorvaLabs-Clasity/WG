# Authentication

The app needs **two** independent credentials, and the sign-in page is built
around that fact rather than hiding it.

| | What it unlocks | Where it comes from |
|---|---|---|
| **AWS** | The app's own storage — DynamoDB, Secrets Manager | Your AWS profile, or the EC2 instance role |
| **GitHub** | Everything the app reports on and changes | OAuth, in your browser |

AWS comes first, because the GitHub OAuth secrets are *stored in* Secrets
Manager. Without AWS the app does not know how to start a GitHub sign-in — which
is exactly what the login page means by "Unlocks once AWS is connected".

## Three tokens, three jobs

| Token | Acts as | Used for |
|---|---|---|
| **Your OAuth token** | you | Any write to a repository |
| **GitHub App installation token** | the app | Bulk reads across the org |
| **App JWT** | your session | Authenticating you to the local backend |

Getting these confused is the single easiest way to misread this codebase, so
each has its own page.

## Read next

- [GitHub OAuth](github-oauth.md) — signing in, and why writes use your token
- [The GitHub App](github-app.md) — the system token, and what it is for
- [AWS credentials](aws-credentials.md) — profiles, SSO, and what is remembered
- [Permissions model](permissions-model.md) — who is allowed to do what
