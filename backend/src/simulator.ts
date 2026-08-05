import { prisma } from "./prisma.js";
import { getTopologyForDT, getDownstreamPoles } from "./topology.js";
import { ingestTelemetryBatch } from "./ingestion.js";
import { triggerDetectionIfDue } from "./tickets.js";

interface FaultConfig {
  type: "span" | "dt" | "feeder";
  spanFromId?: string;
  spanToId?: string;
  dtId?: string;
  feederId?: string;
}

const activeFaults = new Map<string, { config: FaultConfig; affectedPoles: string[]; seqCounters: Map<string, number> }>();
const deadDevices = new Set<string>();
const seqCounters = new Map<string, number>();

export function getActiveFaults() {
  return Array.from(activeFaults.entries()).map(([id, v]) => ({
    id,
    config: v.config,
    affectedPoleCount: v.affectedPoles.length,
  }));
}

export function getDeadDevices() {
  return Array.from(deadDevices);
}

export async function injectSpanFault(poleIdDark: string): Promise<{ faultId: string; affectedCount: number }> {
  const pole = await prisma.pole.findUnique({
    where: { id: poleIdDark },
    select: { id: true, dtId: true, lat: true, lon: true },
  });
  if (!pole) throw new Error("Pole not found");

  const topology = await getTopologyForDT(pole.dtId);
  const downstream = getDownstreamPoles(topology, poleIdDark);
  if (downstream.length === 0) downstream.push(poleIdDark);

  const faultId = `fault-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  activeFaults.set(faultId, {
    config: { type: "span", spanToId: poleIdDark },
    affectedPoles: downstream,
    seqCounters: new Map(),
  });

  await sendPowerLostMessages(downstream);
  await triggerDetectionIfDue();
  return { faultId, affectedCount: downstream.length };
}

export async function injectDTFault(dtId: string): Promise<{ faultId: string; affectedCount: number }> {
  const dt = await prisma.transformer.findUnique({
    where: { id: dtId },
    select: { id: true, poles: { select: { id: true } } },
  });
  if (!dt) throw new Error("DT not found");
  const poleIds = dt.poles.map((p) => p.id);
  const faultId = `fault-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  activeFaults.set(faultId, {
    config: { type: "dt", dtId },
    affectedPoles: poleIds,
    seqCounters: new Map(),
  });
  await sendPowerLostMessages(poleIds);
  await triggerDetectionIfDue();
  return { faultId, affectedCount: poleIds.length };
}

export async function injectFeederFault(feederId: string): Promise<{ faultId: string; affectedCount: number }> {
  const poles = await prisma.pole.findMany({
    where: { feederId },
    select: { id: true },
  });
  const poleIds = poles.map((p) => p.id);
  const faultId = `fault-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  activeFaults.set(faultId, {
    config: { type: "feeder", feederId },
    affectedPoles: poleIds,
    seqCounters: new Map(),
  });
  await sendPowerLostMessages(poleIds);
  await triggerDetectionIfDue();
  return { faultId, affectedCount: poleIds.length };
}

export async function repairFault(faultId: string): Promise<{ repaired: number }> {
  const fault = activeFaults.get(faultId);
  if (!fault) return { repaired: 0 };
  activeFaults.delete(faultId);
  await sendPowerRestoredMessages(fault.affectedPoles);
  return { repaired: fault.affectedPoles.length };
}

export function killDevice(deviceId: string) {
  deadDevices.add(deviceId);
}

export function reviveDevice(deviceId: string) {
  deadDevices.delete(deviceId);
}

async function sendPowerLostMessages(poleIds: string[]) {
  const poles = await prisma.pole.findMany({
    where: { id: { in: poleIds } },
    select: { id: true, deviceId: true, firmware: true, lat: true, lon: true },
  });

  const payloads: any[] = [];
  for (const p of poles) {
    if (deadDevices.has(p.deviceId || "__none__")) continue;
    if (!p.deviceId) continue;

    if (p.firmware && p.firmware.startsWith("1.2")) {
      continue;
    }

    if (Math.random() < 0.3) {
      continue;
    }

    const ts = new Date(Date.now() - Math.floor(Math.random() * 90000));
    const seq = nextSeq(p.deviceId);
    payloads.push({
      device_id: p.deviceId,
      pole_id: p.id,
      event: "power_lost",
      energized: false,
      ts: ts.toISOString(),
      seq,
      battery_mv: 3200 + Math.floor(Math.random() * 400),
      rssi: -100 + Math.floor(Math.random() * 30),
      fw: p.firmware || "1.4.2",
    });
  }

  for (let i = payloads.length - 1; i > 0; i--) {
    if (Math.random() < 0.3) {
      const j = Math.floor(Math.random() * (i + 1));
      [payloads[i], payloads[j]] = [payloads[j], payloads[i]];
    }
  }

  const dupes: any[] = [];
  for (const p of payloads) {
    if (Math.random() < 0.08) dupes.push({ ...p });
  }
  const all = [...payloads, ...dupes];

  const chunks = [];
  for (let i = 0; i < all.length; i += 50) chunks.push(all.slice(i, i + 50));
  for (const c of chunks) {
    await ingestTelemetryBatch(c);
    await new Promise((r) => setTimeout(r, 5));
  }
}

async function sendPowerRestoredMessages(poleIds: string[]) {
  const poles = await prisma.pole.findMany({
    where: { id: { in: poleIds } },
    select: { id: true, deviceId: true, firmware: true },
  });
  const payloads: any[] = [];
  for (const p of poles) {
    if (deadDevices.has(p.deviceId || "__none__")) continue;
    if (!p.deviceId) continue;
    const bootSeq = nextSeq(p.deviceId);
    payloads.push({
      device_id: p.deviceId,
      pole_id: p.id,
      event: "boot",
      energized: true,
      ts: new Date().toISOString(),
      seq: bootSeq,
      battery_mv: 3700 + Math.floor(Math.random() * 200),
      rssi: -90 + Math.floor(Math.random() * 25),
      fw: p.firmware || "1.4.2",
    });
    const restSeq = nextSeq(p.deviceId);
    payloads.push({
      device_id: p.deviceId,
      pole_id: p.id,
      event: "power_restored",
      energized: true,
      ts: new Date(Date.now() + 1000).toISOString(),
      seq: restSeq,
      battery_mv: 3700 + Math.floor(Math.random() * 200),
      rssi: -90 + Math.floor(Math.random() * 25),
      fw: p.firmware || "1.4.2",
    });
  }
  const chunks = [];
  for (let i = 0; i < payloads.length; i += 50) chunks.push(payloads.slice(i, i + 50));
  for (const c of chunks) {
    await ingestTelemetryBatch(c);
    await new Promise((r) => setTimeout(r, 5));
  }
}

function nextSeq(deviceId: string): number {
  const cur = seqCounters.get(deviceId) || Math.floor(Math.random() * 50000) + 1000;
  const next = cur + 1;
  seqCounters.set(deviceId, next);
  return next;
}

export async function sendRandomHeartbeat(count: number = 100) {
  const devices = await prisma.pole.findMany({
    where: { deviceId: { not: null } },
    select: { id: true, deviceId: true, firmware: true, dtId: true },
    take: 2000,
  });
  const affectedSet = new Set<string>();
  for (const f of activeFaults.values()) for (const id of f.affectedPoles) affectedSet.add(id);

  const alive = devices.filter((d) => !deadDevices.has(d.deviceId!));
  const shuffled = alive.sort(() => Math.random() - 0.5).slice(0, count);

  const payloads: any[] = [];
  for (const p of shuffled) {
    const energized = !affectedSet.has(p.id);
    payloads.push({
      device_id: p.deviceId,
      pole_id: p.id,
      event: "heartbeat",
      energized,
      ts: new Date().toISOString(),
      seq: nextSeq(p.deviceId!),
      battery_mv: 3600 + Math.floor(Math.random() * 300),
      rssi: -90 + Math.floor(Math.random() * 25),
      fw: p.firmware || "1.4.2",
    });
  }
  await ingestTelemetryBatch(payloads);
  return payloads.length;
}
