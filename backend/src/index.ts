import express from "express";
import cors from "cors";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { router } from "./routes.js";
import { prisma } from "./prisma.js";
import { seedDatabase } from "./seed.js";
import { triggerDetectionIfDue, verifyAndCloseTickets } from "./tickets.js";
import { sendRandomHeartbeat } from "./simulator.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, "..", "public");

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

app.use("/api", router);

if (fs.existsSync(PUBLIC_DIR)) {
  app.use(express.static(PUBLIC_DIR, { maxAge: 0, index: "index.html" }));
  app.get("/*", (_req, res, next) => {
    if (_req.path.startsWith("/api/")) return next();
    const idx = path.join(PUBLIC_DIR, "index.html");
    if (fs.existsSync(idx)) {
      res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
      return res.sendFile(idx);
    }
    next();
  });
  console.log("[kspdb] Serving frontend SPA from /public");
}

const port = parseInt(process.env.PORT || "3001", 10);

setInterval(() => triggerDetectionIfDue().catch(() => {}), 20000);
setInterval(() => verifyAndCloseTickets().catch(() => {}), 15000);
setInterval(() => sendRandomHeartbeat(50).catch(() => {}), 45000);

async function start() {
  let connected = false;
  for (let i = 0; i < 30; i++) {
    try {
      await prisma.$connect();
      connected = true;
      break;
    } catch (e: any) {
      console.log(`[kspdb] Postgres not ready (${i + 1}/30): ${e.message ?? e}`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  if (!connected) {
    console.error("[kspdb] Failed to connect to Postgres after 60s");
    process.exit(1);
  }

  app.listen(port, "0.0.0.0", () => {
    console.log(`[kspdb] Listening on 0.0.0.0:${port}  (NODE_ENV=${process.env.NODE_ENV ?? "development"})`);
  });

  seedDatabase().catch((e) => {
    console.error("[kspdb] Seed failed (continuing):", e);
  });
}

start().catch((e) => {
  console.error(e);
  process.exit(1);
});
