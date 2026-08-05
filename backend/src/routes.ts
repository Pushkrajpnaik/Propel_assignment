import { Router } from "express";
import { ingestSingleTelemetry, ingestTelemetryBatch } from "./ingestion.js";
import { triggerDetectionIfDue, acknowledgeTicket, assignTicket, markResolved, verifyAndCloseTickets, detectAndCreateTickets } from "./tickets.js";
import { prisma } from "./prisma.js";
import { getTopologyForDT } from "./topology.js";
import { injectSpanFault, injectDTFault, injectFeederFault, repairFault, killDevice, reviveDevice, sendRandomHeartbeat, getActiveFaults, getDeadDevices } from "./simulator.js";
import { z } from "zod";

export const router = Router();

router.get("/health", (_req, res) => {
  res.json({ status: "ok", ts: new Date().toISOString() });
});

router.post("/telemetry", async (req, res) => {
  const body = Array.isArray(req.body) ? req.body : [req.body];
  const result = await ingestTelemetryBatch(body);
  setImmediate(() => triggerDetectionIfDue());
  res.status(202).json(result);
});

router.get("/poles", async (req, res) => {
  const take = Math.min(parseInt((req.query.limit as string) || "500", 10), 2000);
  const dtId = req.query.dtId as string | undefined;
  const feederId = req.query.feederId as string | undefined;
  const where: any = {};
  if (dtId) where.dtId = dtId;
  if (feederId) where.feederId = feederId;
  const poles = await prisma.pole.findMany({
    where,
    take,
    include: { currentState: true },
  });
  res.json(poles);
});

router.get("/poles/:id", async (req, res) => {
  const p = await prisma.pole.findUnique({
    where: { id: req.params.id },
    include: { currentState: true, transformer: true },
  });
  if (!p) return res.status(404).json({ error: "not found" });
  res.json(p);
});

router.get("/transformers", async (_req, res) => {
  const dts = await prisma.transformer.findMany({
    include: {
      _count: { select: { poles: true } },
    },
    orderBy: { householdsServed: "desc" as const },
    take: 50,
  });
  res.json(dts);
});

router.get("/transformers/:id/topology", async (req, res) => {
  try {
    const topo = await getTopologyForDT(req.params.id);
    res.json(topo);
  } catch (e: any) {
    res.status(404).json({ error: e.message });
  }
});

router.get("/feeders", async (_req, res) => {
  const feeders = await prisma.feeder.findMany({
    include: {
      _count: { select: { transformers: true } },
      substation: true,
    },
  });
  res.json(feeders);
});

router.get("/tickets", async (req, res) => {
  const status = req.query.status as string | undefined;
  const where: any = {};
  if (status) where.status = { in: (status as string).split(",") };
  const tickets = await prisma.faultTicket.findMany({
    where,
    orderBy: { detectedAt: "desc" as const },
    take: 100,
    include: {
      events: {
        orderBy: { createdAt: "asc" as const },
        take: 20,
      },
    },
  });
  res.json(tickets);
});

router.get("/tickets/:id", async (req, res) => {
  const t = await prisma.faultTicket.findUnique({
    where: { id: req.params.id },
    include: {
      events: { orderBy: { createdAt: "asc" as const } },
    },
  });
  if (!t) return res.status(404).json({ error: "not found" });
  res.json(t);
});

router.post("/tickets/:id/acknowledge", async (req, res) => {
  try {
    await acknowledgeTicket(req.params.id);
    res.json({ ok: true });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

const assignSchema = z.object({ crew: z.string().min(1) });
router.post("/tickets/:id/assign", async (req, res) => {
  const p = assignSchema.safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: "crew required" });
  try {
    await assignTicket(req.params.id, p.data.crew);
    res.json({ ok: true });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

const resolveSchema = z.object({ notes: z.string().default("") });
router.post("/tickets/:id/resolve", async (req, res) => {
  const p = resolveSchema.safeParse(req.body);
  const result = await markResolved(req.params.id, p.success ? p.data.notes : "");
  if (!result.ok) return res.status(409).json(result);
  setImmediate(() => verifyAndCloseTickets());
  res.json(result);
});

router.post("/detection/run", async (_req, res) => {
  const n = await detectAndCreateTickets();
  const closed = await verifyAndCloseTickets();
  res.json({ newTickets: n, autoClosed: closed });
});

router.get("/scheduled-outages", async (req, res) => {
  const from = req.query.from ? new Date(req.query.from as string) : new Date(Date.now() - 7 * 86400000);
  const to = req.query.to ? new Date(req.query.to as string) : new Date(Date.now() + 14 * 86400000);
  const sos = await prisma.scheduledOutage.findMany({
    where: { OR: [{ start: { gte: from, lte: to } }, { end: { gte: from, lte: to } }] },
    orderBy: { start: "asc" as const },
  });
  res.json(sos);
});

router.get("/simulator/state", (_req, res) => {
  res.json({
    activeFaults: getActiveFaults(),
    deadDevices: getDeadDevices(),
  });
});

const injectSpanSchema = z.object({ poleId: z.string() });
router.post("/simulator/inject/span", async (req, res) => {
  const p = injectSpanSchema.safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: "poleId required" });
  try {
    const r = await injectSpanFault(p.data.poleId);
    res.json(r);
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

const dtSchema = z.object({ dtId: z.string() });
router.post("/simulator/inject/dt", async (req, res) => {
  const p = dtSchema.safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: "dtId required" });
  try {
    res.json(await injectDTFault(p.data.dtId));
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

const feederSchema = z.object({ feederId: z.string() });
router.post("/simulator/inject/feeder", async (req, res) => {
  const p = feederSchema.safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: "feederId required" });
  try {
    res.json(await injectFeederFault(p.data.feederId));
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

const repairSchema = z.object({ faultId: z.string() });
router.post("/simulator/repair", async (req, res) => {
  const p = repairSchema.safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: "faultId required" });
  const r = await repairFault(p.data.faultId);
  setTimeout(() => verifyAndCloseTickets(), 1000);
  res.json(r);
});

const deadDeviceSchema = z.object({ deviceId: z.string() });
router.post("/simulator/kill-device", async (req, res) => {
  const p = deadDeviceSchema.safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: "deviceId required" });
  killDevice(p.data.deviceId);
  res.json({ ok: true });
});

router.post("/simulator/revive-device", async (req, res) => {
  const p = deadDeviceSchema.safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: "deviceId required" });
  reviveDevice(p.data.deviceId);
  res.json({ ok: true });
});

router.post("/simulator/heartbeat", async (req, res) => {
  const n = parseInt((req.body?.count as string) || "100", 10);
  const sent = await sendRandomHeartbeat(Math.max(10, Math.min(1000, n)));
  res.json({ sent });
});

router.get("/stats/summary", async (_req, res) => {
  const [totalPoles, devices, polesDark, transformers, feeders, openTickets] = await Promise.all([
    prisma.pole.count(),
    prisma.pole.count({ where: { deviceId: { not: null } } }),
    prisma.poleState.count({ where: { energized: false } }),
    prisma.transformer.count(),
    prisma.feeder.count(),
    prisma.faultTicket.count({ where: { status: { in: ["detected", "acknowledged", "assigned", "resolved"] } } }),
  ]);
  res.json({
    totalPoles,
    devices,
    polesDark,
    transformers,
    feeders,
    openTickets,
  });
});
