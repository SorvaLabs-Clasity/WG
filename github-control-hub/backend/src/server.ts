import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import authRoutes from "./routes/auth";
import awsGuardrailRoutes from "./routes/awsGuardrails";
import alarmRoutes from "./routes/alarms";
import repoRoutes from "./routes/repos";
import branchRoutes from "./routes/branches";
import protectionRoutes from "./routes/protection";
import activityRoutes from "./routes/activity";
import scannerRoutes from "./routes/scanners";
import alertRoutes from "./routes/alerts";
import dependencyRoutes from "./routes/dependencies";
import orgRoutes from "./routes/org";
import graphRoutes from "./routes/graph";
import accessRoutes from "./routes/access";
import expertiseRoutes from "./routes/expertise";
import pullsRoutes from "./routes/pulls";
import meRoutes from "./routes/me";
import meAlarmRoutes from "./routes/meAlarms";
import widgetRoutes from "./routes/widgets";
import configRoutes from "./routes/config";
import githubBudgetRoutes from "./routes/githubBudget";
import { githubGateMiddleware } from "./middleware/githubGate";
import { authMiddleware } from "./middleware/authMiddleware";
import { awsHealthMiddleware } from "./middleware/awsHealthMiddleware";
import { initTokenManager } from "./github/client";
import { awsRegion } from "./utils/region";
import { startUsageFlushing } from "./services/githubUsageService";
import { compressJson } from "./middleware/compressJson";

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
// so, which is what turns "we do not load remote script" from a habit into
// something the browser enforces.
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      defaultSrc: ["'self'"],
      // No remote script, and no inline script: Vite emits a module tag, never
      // inline code. This is the directive that matters most here. It is the
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

// Rate limiting, strict for auth, moderate for API
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

// Before the routes, so it wraps their responses. The Vulnerabilities tab
// alone is 2.76MB of JSON on a large organization, and 64KB gzipped.
app.use(compressJson);

/**
 * How long a request actually took, from arrival to response.
 *
 * The routes time themselves from inside their handlers, which hid the thing
 * that was actually slow: on a freshly started process the auth middleware
 * makes a GitHub membership call and the first DynamoDB read resolves
 * credentials, all before a handler begins. The tab took twenty seconds while
 * its own log said it had served from storage in 280ms, and both were true.
 *
 * Only slow ones, so the log stays readable. A request nobody waited on is not
 * worth a line.
 */
app.use((req, res, next) => {
  const startedAt = Date.now();
  res.on("finish", () => {
    const ms = Date.now() - startedAt;
    if (ms >= 1000) {
      console.log(`[Slow] ${req.method} ${req.path} took ${ms}ms (${res.statusCode})`);
    }
  });
  next();
});

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.use("/auth", authLimiter, authRoutes);

app.use("/api", apiLimiter, awsHealthMiddleware);

// Everything below except /api/aws is the GitHub half of the app, and is
// refused when signed into an account GitHub does not belong to. See
// middleware/githubGate.ts, unset means unrestricted, which is every install
// that has not asked for the split.
app.use("/api/repos", authMiddleware, githubGateMiddleware, repoRoutes);
app.use("/api/repos", authMiddleware, githubGateMiddleware, branchRoutes);
app.use("/api/repos", authMiddleware, githubGateMiddleware, protectionRoutes);
// Activity is not gated, and filters itself instead.
//
// It is the only feed carrying both halves: guardrail findings sit beside
// branch protection changes. Locking it in an account that runs guardrails
// would take away the record of what they did, which is most of the reason to
// run them, so the router stays reachable and drops the GitHub rows itself.
// See awsOnlyActivityMiddleware.
app.use("/api/activity", authMiddleware, activityRoutes);
app.use("/api/scanners", authMiddleware, githubGateMiddleware, scannerRoutes);
app.use("/api/alerts", authMiddleware, githubGateMiddleware, alertRoutes);
app.use("/api/security", authMiddleware, githubGateMiddleware, dependencyRoutes);
app.use("/api/org", authMiddleware, githubGateMiddleware, orgRoutes);
app.use("/api/graph", authMiddleware, githubGateMiddleware, graphRoutes);
app.use("/api/access", authMiddleware, githubGateMiddleware, accessRoutes);
app.use("/api/expertise", authMiddleware, githubGateMiddleware, expertiseRoutes);
app.use("/api/pulls", authMiddleware, githubGateMiddleware, pullsRoutes);
// Gated like the rest of GitHub: it is composed entirely from what the GitHub
// walk collected, so an account without GitHub credentials has nothing to serve.
app.use("/api/me", authMiddleware, githubGateMiddleware, meRoutes);
// Not behind the alarms router's admin gate, and deliberately so: these are
// somebody's own alarms on their own cards, delivered to their own address.
// Every narrowing that makes it safe lives in the router itself.
app.use("/api/me/alarms", authMiddleware, githubGateMiddleware, meAlarmRoutes);
app.use("/api/widgets", authMiddleware, githubGateMiddleware, widgetRoutes);
app.use("/api/config", authMiddleware, githubGateMiddleware, configRoutes);
// Behind the gate: an AWS-only install has no GitHub allowance to report on,
// and the lens that reads this is hidden there for the same reason.
app.use("/api/github-budget", authMiddleware, githubGateMiddleware, githubBudgetRoutes);
app.use("/api/aws", authMiddleware, awsGuardrailRoutes);
// Not gated, unlike the rest of this block.
//
// Alarms stopped being a GitHub feature when the guardrails could raise them.
// An AWS-only account creates one from the AWS tab, on a rule about its own
// resources, and the gate was refusing that: the tab was there, the button was
// there, and the request came back 403 about GitHub credentials it was not
// asking for.
//
// Nothing here reads GitHub with the App. Groups, Teams delivery and the feed
// settings are DynamoDB and SNS; the one endpoint that reads a widget finds
// none in such an account and says so, which is the true answer. Admin
// membership is still checked, with the caller's own token.
app.use("/api/alarms", authMiddleware, alarmRoutes);

// Try to load secrets from Secrets Manager at startup (covers auto-connected AWS)
// then initialize the GitHub App token manager
(async () => {
  // Before anything reaches for credentials. The desktop app's AWS profile
  // lived only in process.env, so closing the window forgot it and every
  // launch fell back to "default", a sign-in you had already done, asked for
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
        // GITHUB_WEBHOOK_SECRET is deliberately not here. It lives in its own
        // secret, read only by the receiver Lambda, and nothing in this
        // process verifies signatures, webhooks are authenticated at the edge.
        for (const key of [
          "GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET",
          "GITHUB_ORG", "JWT_SECRET",
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

/**
 * GitHub request counters are buffered in memory and written every half minute.
 *
 * Outside the listen block, because that block is the *developer's* server: the
 * desktop app sets `__STANDALONE__` and calls listen() itself, so anything in
 * there never runs in the build people actually use. Flushing lived in there,
 * which meant every count on a desktop install sat in memory and was never
 * written — the page reported nothing, correctly, forever.
 *
 * The Lambdas flush at the end of their pass instead: they are frozen between
 * invocations, so a timer there fires at an unrelated moment or not at all.
 */
startUsageFlushing();

/**
 * Pay the cold-start costs before anybody is waiting on them.
 *
 * The desktop app starts this process when it launches and the person then
 * signs in and navigates, which is several seconds of nothing. Meanwhile the
 * first request pays for AWS credential resolution and the first DynamoDB
 * round trip, entirely inside middleware, before any handler runs. That is why
 * the tab took twenty seconds while its own log honestly reported serving from
 * storage in 280ms.
 *
 * Reading the stored sweep is the cheapest thing that touches DynamoDB and
 * exercises the whole path: credentials, client construction, the round trip.
 * Whatever it returns is discarded; the point is that the next caller finds it
 * warm.
 *
 * Deliberately not awaited and never fatal. Nothing here is required for the
 * server to serve, and an account with no storage configured must start
 * normally.
 */
void (async () => {
  try {
    const started = Date.now();

    /**
     * The health check first, because it is the one in front of everything.
     *
     * awsHealthMiddleware is mounted on all of /api and awaits a DynamoDB scan
     * before calling next(), and its thirty-second cache starts empty on a
     * fresh process. So the first request of every app launch paid for that
     * scan, and the scan paid for the whole AWS credential chain underneath it:
     * an SSO round trip and two cold TLS handshakes, or an IMDS timeout when
     * the session has expired. All of it before any handler began, which is why
     * the tab took twenty seconds while its own log truthfully said it had
     * served from storage in 280ms.
     */
    const { isAwsHealthy } = await import("./middleware/awsHealthMiddleware");
    await isAwsHealthy();

    // Then the stored sweep, which is what the first screen actually reads.
    const { readDependencySnapshot } = await import("./services/dependencySnapshot");
    await readDependencySnapshot();

    console.log(`[Startup] AWS and storage warm in ${Date.now() - started}ms`);
  } catch (err: any) {
    console.warn(`[Startup] Could not reach storage: ${err?.message ?? err}`);
  }
})();

// When imported by the desktop app, skip auto-listen. It calls listen() itself
if (!process.env.__STANDALONE__) {
  // Loopback. This branch is the developer's local server, whose only client is
  // Vite on the same machine; binding every interface published an unfinished
  // build holding real org credentials to the coffee-shop network.
  app.listen(PORT, "127.0.0.1", () => {
    console.log(`Backend running on http://127.0.0.1:${PORT}`);
  });
}

export default app;
