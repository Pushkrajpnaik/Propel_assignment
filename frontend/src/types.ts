export interface Pole {
  id: string;
  lat: number;
  lon: number;
  feederId: string;
  dtId: string;
  seqOnLine: number | null;
  parentPoleId: string | null;
  poleType: string;
  ward: string;
  pincode: string | null;
  deviceId: string | null;
  firmware?: string;
  currentState?: PoleState | null;
}

export interface PoleState {
  poleId: string;
  energized: boolean;
  lastSeen: string;
  lastEvent: string;
  lastSeq: number;
}

export interface Transformer {
  id: string;
  feederId: string;
  lat: number;
  lon: number;
  capacityKva: number;
  householdsServed: number;
  hasTopology: boolean;
  _count?: { poles: number };
}

export interface Feeder {
  id: string;
  substationId: string;
  name: string;
  _count?: { transformers: number };
  substation?: { lat: number; lon: number };
}

export interface Ticket {
  id: string;
  faultType: "span" | "dt" | "feeder" | "sensor_failure";
  status: "detected" | "acknowledged" | "assigned" | "resolved" | "verified" | "closed";
  confidence: number;
  spanFromPoleId: string | null;
  spanToPoleId: string | null;
  dtId: string | null;
  feederId: string | null;
  lat: number;
  lon: number;
  pincode: string | null;
  polesAffected: number;
  householdsAffected: number;
  affectedPoleIds: string[];
  boundaryLiveId: string | null;
  boundaryDarkId: string | null;
  topologyKnown: boolean;
  detectedAt: string;
  acknowledgedAt: string | null;
  assignedAt: string | null;
  resolvedAt: string | null;
  verifiedAt: string | null;
  closedAt: string | null;
  assignedCrew: string | null;
  resolutionNotes: string | null;
  aiSummary: string | null;
  events: TicketEvent[];
}

export interface TicketEvent {
  id: string;
  ticketId: string;
  type: string;
  message: string;
  data?: any;
  createdAt: string;
}

export interface Stats {
  totalPoles: number;
  devices: number;
  polesDark: number;
  transformers: number;
  feeders: number;
  openTickets: number;
}

export interface ScheduledOutage {
  id: string;
  scope: "feeder" | "dt";
  targetId: string;
  start: string;
  end: string;
  reason: string;
}

export interface SimulatorState {
  activeFaults: { id: string; config: any; affectedPoleCount: number }[];
  deadDevices: string[];
}
