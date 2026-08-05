import { prisma } from "./prisma.js";
import { v4 as uuidv4 } from "uuid";

const SUBSTATION_COUNT = 4;
const FEEDERS_PER_SUBSTATION = [7, 8, 8, 8];
const TRANSFORMERS_PER_FEEDER = 12;
const POLES_PER_TRANSFORMER_MIN = 25;
const POLES_PER_TRANSFORMER_MAX = 110;
const POLES_PER_TRANSFORMER_MEDIAN = 65;
const TOPOLOGY_KNOWN_RATIO = 0.4;
const DEVICE_MISSING_RATIO = 0.09;
const OLD_FIRMWARE_RATIO = 0.08;
const PINCODE_MISSING_RATIO = 0.03;

const WARDS = ["W-071", "W-072", "W-073", "W-074", "W-075", "W-076", "W-077", "W-078", "W-079", "W-080", "W-081", "W-082", "W-083", "W-084", "W-085"];
const PINCODES = ["560001", "560002", "560003", "560004", "560009", "560020", "560027", "560038", "560043", "560078", "560095"];
const POLE_TYPES = ["LT-9m-PCC", "LT-8m-Steel", "LT-10m-RCC", "LT-9m-Steel", "LT-8m-PCC"];

function seededRandom(seed: number) {
  let s = seed;
  return () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
}

function gaussian(rand: () => number, mean: number, std: number): number {
  const u1 = rand() || 0.001;
  const u2 = rand() || 0.001;
  const z = Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
  return mean + z * std;
}

function pick<T>(arr: T[], rand: () => number): T {
  return arr[Math.floor(rand() * arr.length)];
}

function pad(n: number, width: number): string {
  return n.toString().padStart(width, "0");
}

export async function seedDatabase() {
  const rand = seededRandom(42);

  const existing = await prisma.substation.count();
  if (existing > 0) {
    console.log("Database already seeded. Skipping.");
    return;
  }

  console.log("Seeding database...");

  const substations: { id: string; name: string; lat: number; lon: number }[] = [];
  let poleCounter = 1;
  let deviceCounter = 1;
  let dtCounter = 1;

  const baseLat = 12.95;
  const baseLon = 77.57;

  for (let s = 0; s < SUBSTATION_COUNT; s++) {
    const ss = {
      id: `SS-0${s + 1}`,
      name: `Substation ${s + 1}`,
      lat: baseLat + rand() * 0.08,
      lon: baseLon + rand() * 0.1,
    };
    substations.push(ss);
  }
  await prisma.substation.createMany({ data: substations });

  const feeders: { id: string; substationId: string; name: string }[] = [];
  const transformers: { id: string; feederId: string; lat: number; lon: number; capacityKva: number; householdsServed: number; hasTopology: boolean }[] = [];
  const poles: any[] = [];
  const poleStates: any[] = [];

  for (let s = 0; s < SUBSTATION_COUNT; s++) {
    const ssId = substations[s].id;
    const nFeeders = FEEDERS_PER_SUBSTATION[s];
    for (let f = 0; f < nFeeders; f++) {
      const feederId = `F-0${s + 1}-${pad(f + 1, 2)}`;
      feeders.push({
        id: feederId,
        substationId: ssId,
        name: `Feeder ${feederId}`,
      });

      for (let t = 0; t < TRANSFORMERS_PER_FEEDER; t++) {
        const dtId = `D-${pad(dtCounter++, 4)}`;
        const dtLat = substations[s].lat + (rand() - 0.5) * 0.035;
        const dtLon = substations[s].lon + (rand() - 0.5) * 0.045;
        const capacity = pick([100, 160, 250, 315, 400], rand);
        const poleCount = Math.max(
          POLES_PER_TRANSFORMER_MIN,
          Math.min(POLES_PER_TRANSFORMER_MAX, Math.round(gaussian(rand, POLES_PER_TRANSFORMER_MEDIAN, 25)))
        );
        const householdsPerPole = 5 + Math.floor(rand() * 8);
        const hasTopology = rand() < TOPOLOGY_KNOWN_RATIO;

        transformers.push({
          id: dtId,
          feederId,
          lat: dtLat,
          lon: dtLon,
          capacityKva: capacity,
          householdsServed: poleCount * householdsPerPole,
          hasTopology,
        });

        const dtPoles = generatePolesForDT(
          dtId,
          feederId,
          dtLat,
          dtLon,
          poleCount,
          hasTopology,
          rand,
          () => poleCounter++,
          () => deviceCounter++
        );
        for (const p of dtPoles.poles) {
          poles.push(p);
          poleStates.push({
            poleId: p.id,
            energized: true,
            lastSeen: new Date(),
            lastEvent: "heartbeat",
            lastSeq: Math.floor(rand() * 10000),
          });
        }
      }
    }
  }

  await prisma.feeder.createMany({ data: feeders });
  console.log(`Created ${feeders.length} feeders`);
  await prisma.transformer.createMany({ data: transformers });
  console.log(`Created ${transformers.length} transformers`);
  await prisma.pole.createMany({ data: poles });
  console.log(`Created ${poles.length} poles`);
  await prisma.poleState.createMany({ data: poleStates });
  console.log(`Created ${poleStates.length} pole states`);

  await prisma.simulationState.create({
    data: {
      id: 1,
      running: false,
      faults: [],
      deadDevices: [],
    },
  });

  await prisma.scheduledOutage.createMany({
    data: generateScheduledOutages(feeders, transformers, rand),
  });

  console.log("Seeding complete.");
}

function generatePolesForDT(
  dtId: string,
  feederId: string,
  dtLat: number,
  dtLon: number,
  poleCount: number,
  hasTopology: boolean,
  rand: () => number,
  nextPoleId: () => number,
  nextDeviceId: () => number
): { poles: any[] } {
  const poles: any[] = [];
  const dtNum = parseInt(dtId.replace(/\D/g, ""), 10) || 1;

  const nBranches = poleCount > 60 ? (rand() < 0.5 ? 1 : 2) : 0;
  const mainRunCount = Math.max(8, Math.round(poleCount * 0.55));
  const branchCounts: number[] = [];
  let remaining = poleCount - mainRunCount;
  for (let b = 0; b < nBranches; b++) {
    const bc = Math.max(5, Math.round(remaining / (nBranches - b) * (0.8 + rand() * 0.4)));
    branchCounts.push(bc);
    remaining -= bc;
  }
  if (remaining > 0) branchCounts[0] = (branchCounts[0] || 0) + remaining;

  const mainAngle = rand() * Math.PI * 2;
  let mainLat = dtLat;
  let mainLon = dtLon;
  let mainSeq = 1;
  let prevMainPoleId: string | null = null;
  const mainPoles: { id: string; lat: number; lon: number; seq: number; parentId: string | null }[] = [];

  for (let i = 0; i < mainRunCount; i++) {
    const poleId = `P-${pad(nextPoleId(), 6)}`;
    const dist = 0.00025 + rand() * 0.0002;
    const angle = mainAngle + (rand() - 0.5) * 0.6;
    mainLat += Math.cos(angle) * dist;
    mainLon += Math.sin(angle) * dist;

    mainPoles.push({
      id: poleId,
      lat: mainLat,
      lon: mainLon,
      seq: mainSeq,
      parentId: prevMainPoleId,
    });

    poles.push(makePole(
      poleId, mainLat, mainLon, feederId, dtId,
      hasTopology ? mainSeq : null,
      hasTopology ? prevMainPoleId : null,
      rand, dtNum, nextDeviceId
    ));

    prevMainPoleId = poleId;
    mainSeq++;
  }

  for (let bi = 0; bi < branchCounts.length; bi++) {
    const branchCount = branchCounts[bi];
    const branchStartIdx = Math.max(2, Math.floor(mainRunCount * (0.3 + bi * 0.25)));
    const startPole = mainPoles[branchStartIdx - 1];
    const branchAngle = mainAngle + (rand() < 0.5 ? -1 : 1) * (0.8 + rand() * 1.0);
    let blat = startPole.lat;
    let blon = startPole.lon;
    let prevPoleId: string | null = startPole.id;
    let bseq = mainSeq;

    for (let j = 0; j < branchCount; j++) {
      const poleId = `P-${pad(nextPoleId(), 6)}`;
      const dist = 0.00022 + rand() * 0.00018;
      const angle = branchAngle + (rand() - 0.5) * 0.5;
      blat += Math.cos(angle) * dist;
      blon += Math.sin(angle) * dist;

      poles.push(makePole(
        poleId, blat, blon, feederId, dtId,
        hasTopology ? bseq : null,
        hasTopology ? prevPoleId : null,
        rand, dtNum, nextDeviceId
      ));

      prevPoleId = poleId;
      bseq++;
    }
    mainSeq = bseq;
  }

  return { poles };
}

function makePole(
  poleId: string,
  lat: number,
  lon: number,
  feederId: string,
  dtId: string,
  seqOnLine: number | null,
  parentPoleId: string | null,
  rand: () => number,
  _dtNum: number,
  nextDeviceId: () => number
): any {
  const hasDevice = rand() >= DEVICE_MISSING_RATIO;
  const isOldFirmware = rand() < OLD_FIRMWARE_RATIO;
  const hasPincode = rand() >= PINCODE_MISSING_RATIO;
  return {
    id: poleId,
    lat,
    lon,
    feederId,
    dtId,
    seqOnLine,
    parentPoleId,
    poleType: pick(POLE_TYPES, rand),
    ward: pick(WARDS, rand),
    pincode: hasPincode ? pick(PINCODES, rand) : null,
    deviceId: hasDevice
      ? `KSPDB-SD07-D${dtId.slice(-4)}-${pad(nextDeviceId(), 4)}`
      : null,
    firmware: hasDevice ? (isOldFirmware ? "1.2.7" : "1.4.2") : null,
  };
}

function generateScheduledOutages(
  feeders: { id: string }[],
  transformers: { id: string }[],
  rand: () => number
): any[] {
  const outages: any[] = [];
  const now = new Date();
  for (let i = 0; i < 8; i++) {
    const dayOffset = Math.floor(rand() * 14) - 3;
    const startH = 9 + Math.floor(rand() * 6);
    const durMin = 60 + Math.floor(rand() * 180);
    const start = new Date(now);
    start.setDate(start.getDate() + dayOffset);
    start.setHours(startH, 0, 0, 0);
    const end = new Date(start.getTime() + durMin * 60000);
    const useFeeder = rand() < 0.5;
    outages.push({
      id: `SO-2026-${pad(now.getMonth() + 1, 2)}-${pad(100 + i, 3)}`,
      scope: useFeeder ? "feeder" : "dt",
      targetId: useFeeder ? pick(feeders, rand).id : pick(transformers, rand).id,
      start,
      end,
      reason: pick(["Planned maintenance - jumper replacement", "Load shedding", "Equipment upgrade", "Line insulation work"], rand),
    });
  }
  return outages;
}

if (process.argv[1] && process.argv[1].endsWith("seed.js")) {
  seedDatabase()
    .then(() => {
      prisma.$disconnect();
      process.exit(0);
    })
    .catch((err) => {
      console.error(err);
      prisma.$disconnect();
      process.exit(1);
    });
}

