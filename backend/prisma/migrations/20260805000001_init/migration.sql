-- CreateTable
CREATE TABLE "Substation" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "lat" DOUBLE PRECISION NOT NULL,
    "lon" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "Substation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Feeder" (
    "id" TEXT NOT NULL,
    "substationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "Feeder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Transformer" (
    "id" TEXT NOT NULL,
    "feederId" TEXT NOT NULL,
    "lat" DOUBLE PRECISION NOT NULL,
    "lon" DOUBLE PRECISION NOT NULL,
    "capacityKva" INTEGER NOT NULL,
    "householdsServed" INTEGER NOT NULL,
    "hasTopology" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "Transformer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Pole" (
    "id" TEXT NOT NULL,
    "lat" DOUBLE PRECISION NOT NULL,
    "lon" DOUBLE PRECISION NOT NULL,
    "feederId" TEXT NOT NULL,
    "dtId" TEXT NOT NULL,
    "seqOnLine" INTEGER,
    "parentPoleId" TEXT,
    "poleType" TEXT NOT NULL,
    "ward" TEXT NOT NULL,
    "pincode" TEXT,
    "deviceId" TEXT,
    "firmware" TEXT DEFAULT '1.4.2',

    CONSTRAINT "Pole_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PoleState" (
    "poleId" TEXT NOT NULL,
    "energized" BOOLEAN NOT NULL,
    "lastSeen" TIMESTAMP(3) NOT NULL,
    "lastEvent" TEXT NOT NULL,
    "lastSeq" INTEGER NOT NULL,

    CONSTRAINT "PoleState_pkey" PRIMARY KEY ("poleId")
);

-- CreateTable
CREATE TABLE "TelemetryEvent" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "poleId" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "energized" BOOLEAN NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL,
    "seq" INTEGER NOT NULL,
    "batteryMv" INTEGER,
    "rssi" INTEGER,
    "fw" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TelemetryEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScheduledOutage" (
    "id" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "start" TIMESTAMP(3) NOT NULL,
    "end" TIMESTAMP(3) NOT NULL,
    "reason" TEXT NOT NULL,

    CONSTRAINT "ScheduledOutage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FaultTicket" (
    "id" TEXT NOT NULL,
    "faultType" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'detected',
    "confidence" DOUBLE PRECISION NOT NULL,
    "spanFromPoleId" TEXT,
    "spanToPoleId" TEXT,
    "dtId" TEXT,
    "feederId" TEXT,
    "lat" DOUBLE PRECISION NOT NULL,
    "lon" DOUBLE PRECISION NOT NULL,
    "pincode" TEXT,
    "polesAffected" INTEGER NOT NULL DEFAULT 0,
    "householdsAffected" INTEGER NOT NULL DEFAULT 0,
    "affectedPoleIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "boundaryLiveId" TEXT,
    "boundaryDarkId" TEXT,
    "topologyKnown" BOOLEAN NOT NULL DEFAULT true,
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acknowledgedAt" TIMESTAMP(3),
    "assignedAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "verifiedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "assignedCrew" TEXT,
    "resolutionNotes" TEXT,
    "aiSummary" TEXT,

    CONSTRAINT "FaultTicket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TicketEvent" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "data" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TicketEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SimulationState" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "running" BOOLEAN NOT NULL DEFAULT false,
    "faults" JSONB[] DEFAULT ARRAY[]::JSONB[],
    "deadDevices" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SimulationState_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "Feeder" ADD CONSTRAINT "Feeder_substationId_fkey" FOREIGN KEY ("substationId") REFERENCES "Substation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Transformer" ADD CONSTRAINT "Transformer_feederId_fkey" FOREIGN KEY ("feederId") REFERENCES "Feeder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Pole" ADD CONSTRAINT "Pole_dtId_fkey" FOREIGN KEY ("dtId") REFERENCES "Transformer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Pole" ADD CONSTRAINT "Pole_parentPoleId_fkey" FOREIGN KEY ("parentPoleId") REFERENCES "Pole"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PoleState" ADD CONSTRAINT "PoleState_poleId_fkey" FOREIGN KEY ("poleId") REFERENCES "Pole"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TelemetryEvent" ADD CONSTRAINT "TelemetryEvent_poleId_fkey" FOREIGN KEY ("poleId") REFERENCES "Pole"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketEvent" ADD CONSTRAINT "TicketEvent_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "FaultTicket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateIndex
CREATE INDEX "TelemetryEvent_poleId_ts_idx" ON "TelemetryEvent"("poleId", "ts");
CREATE INDEX "TelemetryEvent_deviceId_seq_idx" ON "TelemetryEvent"("deviceId", "seq");
CREATE INDEX "ScheduledOutage_targetId_start_end_idx" ON "ScheduledOutage"("targetId", "start", "end");
CREATE INDEX "FaultTicket_status_detectedAt_idx" ON "FaultTicket"("status", "detectedAt");
