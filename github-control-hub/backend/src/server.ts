import "dotenv/config";
import express from "express";
import cors from "cors";
import authRoutes from "./routes/auth";
import repoRoutes from "./routes/repos";
import branchRoutes from "./routes/branches";
import protectionRoutes from "./routes/protection";
import activityRoutes from "./routes/activity";
import templateRoutes from "./routes/templates";
import scannerRoutes from "./routes/scanners";
import webhookRoutes from "./routes/webhooks";
import alertRoutes from "./routes/alerts";
import complianceRoutes from "./routes/compliance";
import dependencyRoutes from "./routes/dependencies";
import orgRoutes from "./routes/org";
import { authMiddleware } from "./middleware/authMiddleware";

const app = express();
const PORT = Number(process.env.PORT) || 4000;
const isProduction = process.env.NODE_ENV === "production";

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val && isProduction) throw new Error(`Missing required env var: ${name}`);
  return val || "";
}

const frontendUrl = process.env.FRONTEND_URL || (isProduction ? requireEnv("FRONTEND_URL") : "http://localhost:5173");

app.use(
  cors({
    origin: frontendUrl,
    credentials: true,
  })
);
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.use("/auth", authRoutes);

app.use("/api/repos", authMiddleware, repoRoutes);
app.use("/api/repos", authMiddleware, branchRoutes);
app.use("/api/repos", authMiddleware, protectionRoutes);
app.use("/api/activity", authMiddleware, activityRoutes);
app.use("/api/templates", authMiddleware, templateRoutes);
app.use("/api/scanners", authMiddleware, scannerRoutes);
app.use("/api/alerts", authMiddleware, alertRoutes);
app.use("/api/compliance", authMiddleware, complianceRoutes);
app.use("/api/security", authMiddleware, dependencyRoutes);
app.use("/api/org", authMiddleware, orgRoutes);
app.use("/api/webhooks", webhookRoutes);

if (!isProduction) {
  app.listen(PORT, () => {
    console.log(`Backend running on http://localhost:${PORT}`);
  });
}

export default app;
