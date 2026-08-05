import { prisma } from "./prisma.js";
import { runDetection, LocalizedFault } from "./localization.js";
import { getTopologyForDT } from "./topology.js";
import { v4 as uuidv4 } from "uuid";

const DETECTION_COOLDOWN_MS = 30000;
let lastDetectionAt = 0;
let detectionRunning = false;

export async function triggerDetectionIfDue(): Promise<void> {
  const now = Date.now();
  if (detectionRunning) return;
  if (now - lastDetectionAt < DETECTION_COOLDOWN_MS) return;
  detectionRunning = true;
  try {
    await detectAndCreateTickets();
  } finally {
    lastDetectionAt = Date.now();
    detectionRunning = false;
  }
}

export async function detectAndCreateTickets(): Promise<number> {
  const faults = await runDetection();
  let created = 0;
  for (const f of faults) {
    const id = await createTicketFromFault(f);
    if (id) created++;
  }
  return created;
}

async function createTicketFromFault(f: LocalizedFault): Promise<string | null> {
  const existing = await findDuplicateTicket(f);
  if (existing) return null;

  const ticketId = uuidv4();
  await prisma.faultTicket.create({
    data: {
      id: ticketId,
      faultType: f.faultType,
      status: "detected",
      confidence: f.confidence,
      spanFromPoleId: f.spanFromPoleId,
      spanToPoleId: f.spanToPoleId,
      dtId: f.dtId,
      feederId: f.feederId,
      lat: f.lat,
      lon: f.lon,
      pincode: f.pincode,
      polesAffected: f.polesAffected,
      householdsAffected: f.householdsAffected,
      affectedPoleIds: f.affectedPoleIds,
      boundaryLiveId: f.boundaryLiveId,
      boundaryDarkId: f.boundaryDarkId,
      topologyKnown: f.topologyKnown,
      aiSummary: await buildAISummary(f),
      events: {
        create: {
          type: "fault_detected",
          message: `Fault detected: ${describeFault(f)}`,
          data: f as any,
        },
      },
    },
  });
  return ticketId;
}

async function findDuplicateTicket(f: LocalizedFault): Promise<boolean> {
  const windowStart = new Date(Date.now() - 2 * 60 * 60 * 1000);
  let where: any = {
    status: { in: ["detected", "acknowledged", "assigned"] },
    detectedAt: { gte: windowStart },
    faultType: f.faultType,
  };
  if (f.faultType === "feeder" && f.feederId) where.feederId = f.feederId;
  else if (f.faultType === "dt" && f.dtId) where.dtId = f.dtId;
  else if (f.spanToPoleId) where.OR = [
    { spanToPoleId: f.spanToPoleId },
    { spanFromPoleId: f.spanFromPoleId || "" },
  ];
  const count = await prisma.faultTicket.count({ where });
  return count > 0;
}

export async function acknowledgeTicket(ticketId: string): Promise<void> {
  await prisma.faultTicket.update({
    where: { id: ticketId, status: "detected" },
    data: {
      status: "acknowledged",
      acknowledgedAt: new Date(),
      events: { create: { type: "acknowledged", message: "Operator acknowledged the ticket" } },
    },
  });
}

export async function assignTicket(ticketId: string, crewName: string): Promise<void> {
  await prisma.faultTicket.update({
    where: { id: ticketId, status: { in: ["detected", "acknowledged"] } },
    data: {
      status: "assigned",
      assignedAt: new Date(),
      assignedCrew: crewName,
      events: { create: { type: "assigned", message: `Crew assigned: ${crewName}` } },
    },
  });
}

export async function markResolved(ticketId: string, notes: string): Promise<{ ok: boolean; reason?: string }> {
  const ticket = await prisma.faultTicket.findUnique({
    where: { id: ticketId },
    select: {
      id: true,
      status: true,
      affectedPoleIds: true,
      polesAffected: true,
    },
  });
  if (!ticket) return { ok: false, reason: "Ticket not found" };

  const liveCount = await countLivePoles(ticket.affectedPoleIds);
  const liveRatio = ticket.affectedPoleIds.length > 0 ? liveCount / ticket.affectedPoleIds.length : 0;
  if (liveRatio < 0.8) {
    await prisma.ticketEvent.create({
      data: {
        ticketId,
        type: "resolution_rejected",
        message: `Crew marked resolved but only ${liveCount}/${ticket.affectedPoleIds.length} poles live (${(liveRatio * 100).toFixed(0)}%). Requiring 80%.`,
      },
    });
    return { ok: false, reason: `Telemetry verification failed: only ${liveCount}/${ticket.affectedPoleIds.length} poles live. Power not restored.` };
  }

  await prisma.faultTicket.update({
    where: { id: ticketId },
    data: {
      status: "resolved",
      resolvedAt: new Date(),
      resolutionNotes: notes,
      events: { create: { type: "resolved", message: `Crew resolved: ${notes}` } },
    },
  });
  return { ok: true };
}

async function countLivePoles(ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const now = Date.now();
  const twoMinAgo = new Date(now - 2 * 60 * 1000);
  const fifteenMinAgo = new Date(now - 16 * 60 * 1000);
  return prisma.poleState.count({
    where: {
      poleId: { in: ids },
      energized: true,
      lastSeen: { gt: fifteenMinAgo },
    },
  });
}

export async function verifyAndCloseTickets(): Promise<number> {
  const tickets = await prisma.faultTicket.findMany({
    where: { status: { in: ["resolved", "assigned", "acknowledged"] } },
    select: {
      id: true,
      status: true,
      affectedPoleIds: true,
    },
  });
  let closed = 0;
  for (const t of tickets) {
    if (t.affectedPoleIds.length === 0) continue;
    const liveCount = await countLivePoles(t.affectedPoleIds);
    const liveRatio = liveCount / t.affectedPoleIds.length;
    if (liveRatio >= 0.9) {
      if (t.status === "resolved") {
        await prisma.faultTicket.update({
          where: { id: t.id },
          data: {
            status: "verified",
            verifiedAt: new Date(),
            events: { create: { type: "verified", message: `Verified: ${liveCount}/${t.affectedPoleIds.length} poles live` } },
          },
        });
        await prisma.faultTicket.update({
          where: { id: t.id },
          data: {
            status: "closed",
            closedAt: new Date(),
            events: { create: { type: "closed", message: "Ticket closed after verification" } },
          },
        });
        closed++;
      } else if (t.status === "assigned" || t.status === "acknowledged") {
        await prisma.ticketEvent.create({
          data: {
            ticketId: t.id,
            type: "auto_restoration",
            message: `Auto-detected restoration: ${liveCount}/${t.affectedPoleIds.length} poles live. Please acknowledge.`,
          },
        });
      }
    }
  }
  return closed;
}

function describeFault(f: LocalizedFault): string {
  if (f.faultType === "feeder") return `Feeder-level outage on ${f.feederId}`;
  if (f.faultType === "dt") return `Distribution transformer ${f.dtId} failure`;
  if (f.spanFromPoleId && f.spanToPoleId) return `Span fault between ${f.spanFromPoleId} and ${f.spanToPoleId}`;
  if (f.boundaryDarkId) return `Span fault near pole ${f.boundaryDarkId}`;
  return "Span fault";
}

async function buildAISummary(f: LocalizedFault): Promise<string> {
  const typeLabel = f.faultType === "feeder" ? "Feeder-level outage"
    : f.faultType === "dt" ? "Transformer failure"
    : "Span fault";
  const confPct = (f.confidence * 100).toFixed(0);
  const pin = f.pincode ? `PIN ${f.pincode}` : "PIN unknown";
  const hh = f.householdsAffected > 0 ? `~${f.householdsAffected} households` : "h/h unknown";
  const topo = f.topologyKnown ? "topology recorded" : "topology inferred";
  const details = f.confidenceReasons.slice(0, 2).join("; ");

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return `${typeLabel} · ${pin} · ${f.polesAffected} poles affected (${hh}) · ${confPct}% confidence · ${topo}. Key signals: ${details}`;
  }

  try {
    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0.2,
        messages: [
          {
            role: "system",
            content: "You are an electrical-grid control-room copilot. Write a 1-paragraph briefing for the operator on duty. Be specific, action-oriented, and state uncertainty plainly. Under 100 words.",
          },
          {
            role: "user",
            content: JSON.stringify({
              type: typeLabel,
              lat: f.lat,
              lon: f.lon,
              pincode: f.pincode,
              poles_affected: f.polesAffected,
              households_affected: f.householdsAffected,
              confidence_pct: confPct,
              topology_known: f.topologyKnown,
              between_poles: f.spanFromPoleId ? [f.spanFromPoleId, f.spanToPoleId] : null,
              dt_id: f.dtId,
              feeder_id: f.feederId,
              reasons: f.confidenceReasons,
            }),
          },
        ],
      }),
    });
    if (resp.ok) {
      const json = await resp.json();
      const txt = json?.choices?.[0]?.message?.content;
      if (txt) return txt.trim();
    }
  } catch (_) {}

  return `${typeLabel} · ${pin} · ${f.polesAffected} poles affected (${hh}) · ${confPct}% confidence · ${topo}. Key signals: ${details}`;
}
