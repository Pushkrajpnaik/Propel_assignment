import { prisma } from "./prisma.js";
import { getTopologyForDT, getDownstreamPoles, InferredTopology } from "./topology.js";

export interface LocalizedFault {
  faultType: "span" | "dt" | "feeder" | "sensor_failure";
  dtId?: string;
  feederId?: string;
  spanFromPoleId?: string;
  spanToPoleId?: string;
  boundaryLiveId?: string;
  boundaryDarkId?: string;
  lat: number;
  lon: number;
  pincode?: string;
  polesAffected: number;
  householdsAffected: number;
  affectedPoleIds: string[];
  confidence: number;
  confidenceReasons: string[];
  topologyKnown: boolean;
}

interface PoleStateInfo {
  id: string;
  lat: number;
  lon: number;
  dtId: string;
  feederId: string;
  pincode?: string;
  energized: boolean;
  lastSeen: Date;
  hasDevice: boolean;
  deviceId?: string;
  parentPoleId?: string | null;
}

export async function ingestTelemetryAndDetect(): Promise<LocalizedFault[]> {
  return runDetection();
}

export async function runDetection(): Promise<LocalizedFault[]> {
  const now = new Date();
  const fifteenMinAgo = new Date(now.getTime() - 15 * 60 * 1000 - 2 * 60 * 1000);

  const poleStates = await prisma.poleState.findMany({
    include: {
      pole: {
        select: {
          id: true,
          lat: true,
          lon: true,
          dtId: true,
          feederId: true,
          pincode: true,
          deviceId: true,
          parentPoleId: true,
        },
      },
    },
  });

  const darkPolesByFeeder = new Map<string, PoleStateInfo[]>();
  const darkPolesByDT = new Map<string, PoleStateInfo[]>();
  const allDark: PoleStateInfo[] = [];

  for (const ps of poleStates) {
    const info: PoleStateInfo = {
      id: ps.pole.id,
      lat: ps.pole.lat,
      lon: ps.pole.lon,
      dtId: ps.pole.dtId,
      feederId: ps.pole.feederId,
      pincode: ps.pole.pincode ?? undefined,
      energized: ps.energized,
      lastSeen: ps.lastSeen,
      hasDevice: !!ps.pole.deviceId,
      deviceId: ps.pole.deviceId ?? undefined,
      parentPoleId: ps.pole.parentPoleId,
    };

    const stale = ps.lastSeen < fifteenMinAgo;
    if (!ps.energized || (stale && info.hasDevice)) {
      allDark.push(info);
      if (!darkPolesByFeeder.has(info.feederId)) darkPolesByFeeder.set(info.feederId, []);
      darkPolesByFeeder.get(info.feederId)!.push(info);
      if (!darkPolesByDT.has(info.dtId)) darkPolesByDT.set(info.dtId, []);
      darkPolesByDT.get(info.dtId)!.push(info);
    }
  }

  const existingOpenTicketTargets = new Set<string>();
  const openTickets = await prisma.faultTicket.findMany({
    where: { status: { in: ["detected", "acknowledged", "assigned", "resolved"] } },
    select: { id: true, dtId: true, feederId: true, spanFromPoleId: true, spanToPoleId: true },
  });
  for (const t of openTickets) {
    if (t.feederId) existingOpenTicketTargets.add(`feeder:${t.feederId}`);
    if (t.dtId) existingOpenTicketTargets.add(`dt:${t.dtId}`);
    if (t.spanFromPoleId && t.spanToPoleId) {
      existingOpenTicketTargets.add(`span:${t.spanFromPoleId}-${t.spanToPoleId}`);
    }
  }

  const faults: LocalizedFault[] = [];
  const handledDts = new Set<string>();
  const handledFeeders = new Set<string>();

  for (const [feederId, darkPoles] of darkPolesByFeeder.entries()) {
    const feederDTs = new Set(darkPoles.map((p) => p.dtId));
    const totalDtsInFeeder = await prisma.transformer.count({ where: { feederId } });
    const darkDtRatio = feederDTs.size / Math.max(1, totalDtsInFeeder);

    if (feederDTs.size >= 3 && darkDtRatio >= 0.75) {
      const key = `feeder:${feederId}`;
      if (!existingOpenTicketTargets.has(key)) {
        const f = await detectFeederFault(feederId, darkPoles);
        if (f) {
          faults.push(f);
          for (const d of feederDTs) handledDts.add(d);
          handledFeeders.add(feederId);
        }
      } else {
        for (const d of feederDTs) handledDts.add(d);
        handledFeeders.add(feederId);
      }
    }
  }

  for (const [dtId, darkPoles] of darkPolesByDT.entries()) {
    if (handledDts.has(dtId)) continue;
    const dtFaults = await detectFaultsInDT(dtId, darkPoles);
    for (const f of dtFaults) {
      let dedupeKey: string | null = null;
      if (f.faultType === "dt") dedupeKey = `dt:${f.dtId}`;
      else if (f.faultType === "span" && f.spanFromPoleId && f.spanToPoleId)
        dedupeKey = `span:${f.spanFromPoleId}-${f.spanToPoleId}`;
      else if (f.faultType === "span" && f.boundaryDarkId)
        dedupeKey = `span-approx:${f.boundaryDarkId}`;
      if (dedupeKey && !existingOpenTicketTargets.has(dedupeKey)) {
        faults.push(f);
      }
    }
  }

  return faults;
}

async function detectFeederFault(feederId: string, darkPoles: PoleStateInfo[]): Promise<LocalizedFault | null> {
  const affected = darkPoles.map((p) => p.id);
  const households = await prisma.transformer.aggregate({
    _sum: { householdsServed: true },
    where: { feederId },
  });
  const center = centroid(darkPoles);
  const scheduled = await isScheduledOutage("feeder", feederId);
  if (scheduled) return null;

  return {
    faultType: "feeder",
    feederId,
    lat: center.lat,
    lon: center.lon,
    pincode: mostCommonPincode(darkPoles),
    polesAffected: affected.length,
    householdsAffected: households._sum.householdsServed || 0,
    affectedPoleIds: affected,
    confidence: 0.8,
    confidenceReasons: [
      `${affected.length} poles dark across feeder ${feederId}`,
      "Multiple DTs affected simultaneously - feeder or substation level fault",
      "Confidence reduced due to coarser localization",
    ],
    topologyKnown: true,
  };
}

async function detectFaultsInDT(dtId: string, darkPoles: PoleStateInfo[]): Promise<LocalizedFault[]> {
  if (darkPoles.length < 1) return [];

  const dt = await prisma.transformer.findUnique({
    where: { id: dtId },
    select: { householdsServed: true, lat: true, lon: true, hasTopology: true, poles: { select: { id: true } } },
  });
  if (!dt) return [];

  const scheduled = await isScheduledOutage("dt", dtId);
  if (scheduled) return [];

  const topology = await getTopologyForDT(dtId);
  const totalPolesInDt = dt.poles.length;
  const darkPoleIds = new Set(darkPoles.map((p) => p.id));

  if (darkPoles.length >= Math.max(5, totalPolesInDt * 0.85) && darkPoles.length >= 10) {
    const livePolesInDt = totalPolesInDt - darkPoles.length;
    if (livePolesInDt <= Math.min(3, totalPolesInDt * 0.1)) {
      return [
        {
          faultType: "dt",
          dtId,
          lat: dt.lat,
          lon: dt.lon,
          pincode: mostCommonPincode(darkPoles),
          polesAffected: darkPoles.length,
          householdsAffected: dt.householdsServed,
          affectedPoleIds: darkPoles.map((p) => p.id),
          confidence: 0.85,
          confidenceReasons: [
            `${darkPoles.length} of ${totalPolesInDt} poles (${Math.round(100 * darkPoles.length / totalPolesInDt)}%) under DT ${dtId} are dark`,
            "Pattern consistent with DT failure or HT fuse blow",
            topology.known ? "Exact topology available" : "Topology inferred geometrically",
          ],
          topologyKnown: topology.known,
        },
      ];
    }
  }

  return findSpanFaults(dt, topology, darkPoleIds, darkPoles);
}

function findSpanFaults(
  dt: any,
  topology: InferredTopology,
  darkPoleIds: Set<string>,
  darkPoles: PoleStateInfo[]
): LocalizedFault[] {
  const parentMap = new Map<string, string>();
  const childrenMap = new Map<string, string[]>();
  const poleInfoMap = new Map<string, { lat: number; lon: number; pincode?: string }>();
  for (const p of topology.poles) {
    if (p.parentId) {
      parentMap.set(p.id, p.parentId);
      if (!childrenMap.has(p.parentId)) childrenMap.set(p.parentId, []);
      childrenMap.get(p.parentId)!.push(p.id);
    }
  }
  for (const dp of darkPoles) {
    poleInfoMap.set(dp.id, { lat: dp.lat, lon: dp.lon, pincode: dp.pincode });
  }
  for (const p of topology.poles) {
    if (!poleInfoMap.has(p.id)) {
      poleInfoMap.set(p.id, { lat: p.lat, lon: p.lon });
    }
  }

  const rootBoundaries: { live: string | null; dark: string; darkCluster: string[] }[] = [];
  const assigned = new Set<string>();

  const sortedDark = [...darkPoleIds].sort((a, b) => {
    const pa = topology.poles.find((p) => p.id === a);
    const pb = topology.poles.find((p) => p.id === b);
    return (pa?.distanceFromDT || 0) - (pb?.distanceFromDT || 0);
  });

  for (const darkId of sortedDark) {
    if (assigned.has(darkId)) continue;
    const path = climbToBoundary(darkId, parentMap, darkPoleIds);
    if (!path) continue;
    const { liveId, firstDarkId } = path;

    const downstream = getDownstreamPoles(topology, firstDarkId).filter((id) => darkPoleIds.has(id));
    for (const d of downstream) assigned.add(d);

    let actualLive = liveId;
    if (actualLive && darkPoleIds.has(actualLive)) {
      actualLive = null;
    }

    rootBoundaries.push({
      live: actualLive,
      dark: firstDarkId,
      darkCluster: downstream,
    });
  }

  const merged = mergeBoundaries(rootBoundaries, topology, poleInfoMap);
  const results: LocalizedFault[] = [];

  for (const m of merged) {
    if (m.darkCluster.length < 2) {
      const onlyDark = m.darkCluster[0];
      if (onlyDark) {
        const kids = childrenMap.get(onlyDark) || [];
        const liveChildren = kids.filter((k) => !darkPoleIds.has(k));
        if (liveChildren.length > 0) {
          continue;
        }
      }
      if (m.darkCluster.length === 1) {
        const dp = darkPoles.find((x) => x.id === onlyDark);
        if (dp) {
          const lastSeenAgoMin = (Date.now() - dp.lastSeen.getTime()) / 60000;
          if (lastSeenAgoMin < 35) continue;
        }
      }
    }

    const clusterPoles = m.darkCluster
      .map((id) => poleInfoMap.get(id))
      .filter(Boolean) as { lat: number; lon: number; pincode?: string }[];
    const center = clusterPoles.length > 0 ? centroid(clusterPoles) : { lat: dt.lat, lon: dt.lon };

    const householdsAffected = Math.round(
      (m.darkCluster.length / Math.max(1, dt.poles.length)) * dt.householdsServed
    );

    let confidence = 0.7;
    const reasons: string[] = [];

    if (m.live && m.dark) {
      confidence += 0.15;
      reasons.push(`Clear live/dark boundary between ${m.live} and ${m.dark}`);
    } else if (m.dark) {
      reasons.push(`Boundary detected at first dark pole ${m.dark}; live side near DT root or unobserved`);
    }

    if (topology.known) {
      confidence += 0.05;
      reasons.push("Exact recorded topology used");
    } else {
      confidence *= topology.confidence / 0.85;
      reasons.push(`Topology inferred geometrically (confidence ${(topology.confidence * 100).toFixed(0)}%)`);
    }

    if (m.darkCluster.length >= 5) {
      confidence += 0.03;
      reasons.push(`${m.darkCluster.length} downstream poles consistent with a single upstream fault`);
    } else if (m.darkCluster.length < 3) {
      confidence -= 0.1;
      reasons.push("Small affected cluster - increased false-positive risk");
    }

    confidence = Math.max(0.3, Math.min(0.97, confidence));

    results.push({
      faultType: "span",
      dtId: dt.id,
      spanFromPoleId: m.live || undefined,
      spanToPoleId: m.dark,
      boundaryLiveId: m.live || undefined,
      boundaryDarkId: m.dark,
      lat: center.lat,
      lon: center.lon,
      pincode: clusterPoles.find((p) => p.pincode)?.pincode,
      polesAffected: m.darkCluster.length,
      householdsAffected,
      affectedPoleIds: m.darkCluster,
      confidence,
      confidenceReasons: reasons,
      topologyKnown: topology.known,
    });
  }

  return results;
}

function climbToBoundary(
  poleId: string,
  parentMap: Map<string, string>,
  darkPoleIds: Set<string>
): { liveId: string | null; firstDarkId: string } | null {
  let firstDark = poleId;
  let cur = poleId;
  const visited = new Set<string>();
  while (cur) {
    visited.add(cur);
    const parent = parentMap.get(cur);
    if (!parent) return { liveId: null, firstDarkId: firstDark };
    if (!darkPoleIds.has(parent)) {
      return { liveId: parent, firstDarkId: firstDark };
    }
    firstDark = parent;
    cur = parent;
    if (visited.has(cur)) return { liveId: null, firstDarkId: firstDark };
  }
  return { liveId: null, firstDarkId: firstDark };
}

function mergeBoundaries(
  boundaries: { live: string | null; dark: string; darkCluster: string[] }[],
  topology: InferredTopology,
  poleInfo: Map<string, { lat: number; lon: number }>
): { live: string | null; dark: string; darkCluster: string[] }[] {
  if (boundaries.length <= 1) return boundaries;

  const n = boundaries.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  function find(x: number): number {
    while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; }
    return x;
  }
  function union(a: number, b: number) { parent[find(a)] = find(b); }

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const bi = boundaries[i];
      const bj = boundaries[j];
      const sameLive = bi.live && bj.live && bi.live === bj.live;
      let adjacent = false;
      for (const a of bi.darkCluster) {
        const ai = poleInfo.get(a);
        if (!ai) continue;
        for (const b of bj.darkCluster) {
          const bj2 = poleInfo.get(b);
          if (!bj2) continue;
          const dx = ai.lat - bj2.lat;
          const dy = ai.lon - bj2.lon;
          if (Math.sqrt(dx * dx + dy * dy) * 111000 < 80) {
            adjacent = true;
            break;
          }
        }
        if (adjacent) break;
      }
      if (sameLive || adjacent) union(i, j);
    }
  }

  const groups = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r)!.push(i);
  }

  const result: { live: string | null; dark: string; darkCluster: string[] }[] = [];
  for (const idxs of groups.values()) {
    const clusters = idxs.flatMap((i) => boundaries[i].darkCluster);
    const uniq = [...new Set(clusters)];
    const sorted = uniq.sort((a, b) => {
      const pa = topology.poles.find((p) => p.id === a);
      const pb = topology.poles.find((p) => p.id === b);
      return (pa?.distanceFromDT || 0) - (pb?.distanceFromDT || 0);
    });
    const liveCandidates = idxs.map((i) => boundaries[i].live).filter(Boolean) as string[];
    const live = liveCandidates.length > 0 ? liveCandidates[0] : null;
    const firstDark = sorted[0];
    if (firstDark) result.push({ live, dark: firstDark, darkCluster: sorted });
  }
  return result;
}

export function centroid(points: { lat: number; lon: number }[]): { lat: number; lon: number } {
  if (points.length === 0) return { lat: 0, lon: 0 };
  let latSum = 0, lonSum = 0;
  for (const p of points) { latSum += p.lat; lonSum += p.lon; }
  return { lat: latSum / points.length, lon: lonSum / points.length };
}

function mostCommonPincode(poles: PoleStateInfo[]): string | undefined {
  const counts = new Map<string, number>();
  for (const p of poles) {
    if (p.pincode) counts.set(p.pincode, (counts.get(p.pincode) || 0) + 1);
  }
  let best: string | undefined;
  let bestN = 0;
  for (const [c, n] of counts) if (n > bestN) { best = c; bestN = n; }
  return best;
}

async function isScheduledOutage(scope: "feeder" | "dt", targetId: string): Promise<boolean> {
  const now = new Date();
  const plusWindow = new Date(now.getTime() + 45 * 60 * 1000);
  const minusWindow = new Date(now.getTime() - 45 * 60 * 1000);
  const match = await prisma.scheduledOutage.findFirst({
    where: {
      scope,
      targetId,
      start: { lte: plusWindow },
      end: { gte: minusWindow },
    },
  });
  if (!match) return false;
  const active = match.start <= now && match.end >= now;
  const early = now < match.start && (match.start.getTime() - now.getTime()) < 45 * 60000;
  const overrun = now > match.end && (now.getTime() - match.end.getTime()) < 45 * 60000;
  return active || early || overrun;
}
