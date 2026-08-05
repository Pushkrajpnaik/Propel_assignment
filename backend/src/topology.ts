import { prisma } from "./prisma.js";

export interface InferredTopology {
  dtId: string;
  known: boolean;
  poles: TopoPole[];
  edges: { from: string; to: string; distance: number }[];
  confidence: number;
}

export interface TopoPole {
  id: string;
  lat: number;
  lon: number;
  parentId: string | null;
  seqOnLine: number | null;
  distanceFromDT: number;
}

const topologyCache = new Map<string, InferredTopology>();

function haversine(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000;
  const toRad = (x: number) => (x * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export async function getTopologyForDT(dtId: string): Promise<InferredTopology> {
  const cached = topologyCache.get(dtId);
  if (cached) return cached;

  const dt = await prisma.transformer.findUnique({
    where: { id: dtId },
    select: {
      id: true,
      lat: true,
      lon: true,
      hasTopology: true,
      poles: {
        select: {
          id: true,
          lat: true,
          lon: true,
          parentPoleId: true,
          seqOnLine: true,
        },
        orderBy: { seqOnLine: "asc" as const },
      },
    },
  });
  if (!dt) throw new Error(`DT not found: ${dtId}`);

  let result: InferredTopology;
  if (dt.hasTopology && dt.poles.some((p) => p.seqOnLine != null)) {
    result = buildKnownTopology(dt);
  } else {
    result = inferTopologyGeometrically(dt);
  }

  topologyCache.set(dtId, result);
  return result;
}

function buildKnownTopology(dt: any): InferredTopology {
  const poles: TopoPole[] = dt.poles.map((p: any) => ({
    id: p.id,
    lat: p.lat,
    lon: p.lon,
    parentId: p.parentPoleId,
    seqOnLine: p.seqOnLine,
    distanceFromDT: haversine(dt.lat, dt.lon, p.lat, p.lon),
  }));

  const edges: { from: string; to: string; distance: number }[] = [];
  const poleMap = new Map(poles.map((p) => [p.id, p]));
  for (const p of poles) {
    if (p.parentId && poleMap.has(p.parentId)) {
      const parent = poleMap.get(p.parentId)!;
      edges.push({
        from: p.parentId,
        to: p.id,
        distance: haversine(parent.lat, parent.lon, p.lat, p.lon),
      });
    }
  }

  return {
    dtId: dt.id,
    known: true,
    poles,
    edges,
    confidence: 0.98,
  };
}

function inferTopologyGeometrically(dt: any): InferredTopology {
  const poleData = dt.poles as { id: string; lat: number; lon: number }[];
  if (poleData.length === 0) {
    return { dtId: dt.id, known: false, poles: [], edges: [], confidence: 0 };
  }

  const withDistance = poleData.map((p) => ({
    id: p.id,
    lat: p.lat,
    lon: p.lon,
    dist: haversine(dt.lat, dt.lon, p.lat, p.lon),
  }));

  withDistance.sort((a, b) => a.dist - b.dist);

  const assigned = new Set<string>();
  const poles: TopoPole[] = [];
  const edges: { from: string; to: string; distance: number }[] = [];

  const firstBatch = Math.min(3, withDistance.length);
  for (let i = 0; i < firstBatch; i++) {
    const p = withDistance[i];
    poles.push({
      id: p.id,
      lat: p.lat,
      lon: p.lon,
      parentId: null,
      seqOnLine: i + 1,
      distanceFromDT: p.dist,
    });
    assigned.add(p.id);
  }

  for (let i = firstBatch; i < withDistance.length; i++) {
    const p = withDistance[i];
    let bestParentId: string | null = null;
    let bestScore = Infinity;

    for (const ap of poles) {
      const d = haversine(ap.lat, ap.lon, p.lat, p.lon);
      if (d < 80) {
        const score = d + Math.max(0, p.dist - ap.distanceFromDT - 5) * 0.3;
        if (score < bestScore) {
          bestScore = score;
          bestParentId = ap.id;
        }
      }
    }

    if (!bestParentId) {
      for (const ap of poles) {
        const d = haversine(ap.lat, ap.lon, p.lat, p.lon);
        const score = d + Math.max(0, p.dist - ap.distanceFromDT) * 0.2;
        if (score < bestScore) {
          bestScore = score;
          bestParentId = ap.id;
        }
      }
    }

    poles.push({
      id: p.id,
      lat: p.lat,
      lon: p.lon,
      parentId: bestParentId,
      seqOnLine: i + 1,
      distanceFromDT: p.dist,
    });
    if (bestParentId) {
      const parent = poles.find((x) => x.id === bestParentId)!;
      edges.push({
        from: bestParentId,
        to: p.id,
        distance: haversine(parent.lat, parent.lon, p.lat, p.lon),
      });
    }
    assigned.add(p.id);
  }

  let totalEdges = 0;
  let shortEdges = 0;
  for (const e of edges) {
    totalEdges++;
    if (e.distance < 100) shortEdges++;
  }
  const edgeRatio = totalEdges > 0 ? shortEdges / totalEdges : 0;
  const confidence = Math.min(0.85, 0.55 + edgeRatio * 0.3 + (poles.length < 60 ? 0.05 : 0));

  return {
    dtId: dt.id,
    known: false,
    poles,
    edges,
    confidence,
  };
}

export function getDownstreamPoles(topology: InferredTopology, fromPoleId: string): string[] {
  const children = new Map<string, string[]>();
  for (const e of topology.edges) {
    if (!children.has(e.from)) children.set(e.from, []);
    children.get(e.from)!.push(e.to);
  }
  const result: string[] = [];
  const stack = [fromPoleId];
  const seen = new Set<string>();
  while (stack.length) {
    const cur = stack.pop()!;
    if (seen.has(cur)) continue;
    seen.add(cur);
    result.push(cur);
    for (const c of children.get(cur) || []) stack.push(c);
  }
  return result;
}

export function getUpstreamPath(topology: InferredTopology, poleId: string): string[] {
  const parentMap = new Map<string, string>();
  for (const p of topology.poles) {
    if (p.parentId) parentMap.set(p.id, p.parentId);
  }
  const path: string[] = [];
  let cur: string | undefined = poleId;
  const seen = new Set<string>();
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    path.push(cur);
    cur = parentMap.get(cur);
  }
  return path;
}

export function clearTopologyCache() {
  topologyCache.clear();
}
