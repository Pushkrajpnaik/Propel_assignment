import { prisma } from "./prisma.js";
import { z } from "zod";

const telemetrySchema = z.object({
  device_id: z.string(),
  pole_id: z.string(),
  event: z.enum(["heartbeat", "power_lost", "power_restored", "boot"]),
  energized: z.boolean(),
  ts: z.string().transform((s) => new Date(s)),
  seq: z.number().int(),
  battery_mv: z.number().int().optional(),
  rssi: z.number().int().optional(),
  fw: z.string().optional(),
});

type TelemetryInput = z.infer<typeof telemetrySchema>;

const seenKeys = new Map<string, number>();
const DEVICE_WINDOW_MS = 24 * 60 * 60 * 1000;

export async function ingestTelemetryBatch(payloads: unknown[]): Promise<{ accepted: number; duplicates: number; errors: number; poleIds: string[] }> {
  let accepted = 0;
  let duplicates = 0;
  let errors = 0;
  const poleIds: string[] = [];
  const stateUpdates: { poleId: string; energized: boolean; lastSeen: Date; lastEvent: string; lastSeq: number }[] = [];
  const events: any[] = [];

  for (const raw of payloads) {
    const parsed = telemetrySchema.safeParse(raw);
    if (!parsed.success) {
      errors++;
      continue;
    }
    const t = parsed.data;
    const dedupeKey = `${t.device_id}:${t.seq}`;
    const prev = seenKeys.get(dedupeKey);
    const now = Date.now();
    if (prev && now - prev < DEVICE_WINDOW_MS) {
      duplicates++;
      continue;
    }
    seenKeys.set(dedupeKey, now);

    const existingState = await prisma.poleState.findUnique({
      where: { poleId: t.pole_id },
      select: { lastSeq: true },
    });
    if (existingState && existingState.lastSeq > t.seq) {
      duplicates++;
      continue;
    }

    events.push({
      deviceId: t.device_id,
      poleId: t.pole_id,
      event: t.event,
      energized: t.energized,
      ts: t.ts,
      seq: t.seq,
      batteryMv: t.battery_mv,
      rssi: t.rssi,
      fw: t.fw,
    });
    stateUpdates.push({
      poleId: t.pole_id,
      energized: t.energized,
      lastSeen: t.ts,
      lastEvent: t.event,
      lastSeq: t.seq,
    });
    poleIds.push(t.pole_id);
    accepted++;
  }

  if (events.length > 0) {
    await prisma.$transaction(async (tx) => {
      await tx.telemetryEvent.createMany({ data: events, skipDuplicates: true });
      for (const u of stateUpdates) {
        await tx.poleState.upsert({
          where: { poleId: u.poleId },
          update: {
            energized: u.energized,
            lastSeen: u.lastSeen,
            lastEvent: u.lastEvent,
            lastSeq: u.lastSeq,
          },
          create: u,
        });
      }
    });
  }

  return { accepted, duplicates, errors, poleIds };
}

export async function ingestSingleTelemetry(raw: unknown) {
  return ingestTelemetryBatch([raw]);
}
