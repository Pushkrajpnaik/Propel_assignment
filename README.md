# KSPDB Outage Control Room

Power distribution fault detection system for the Karnataka State Power Distribution Board. Ingests pole-level IoT telemetry, localizes faults to the span/transformer/feeder, and manages a ticket lifecycle with telemetry-based auto-verification.

## One-command start

```bash
git clone <repo-url> && cd <repo-name>
docker compose up
```

Wait ~90 seconds for Postgres, migrations, seed data, backend, and frontend. Then open:

- **App**: http://localhost:3000
- **API**: http://localhost:3001/api/health

Seed generates ~3,200 poles across ~280 transformers on 31 feeders, matching the real-world proportions (60% missing topology, 9% no device, 8% old firmware, 3% missing PIN).

## Quick smoke test

1. Open http://localhost:3000
2. Go to **Simulator** tab → pick a DT with "known topo" → pick any mid-line pole → **Inject Span Fault**
3. Click **Run Detection** (top bar) — wait ~5 seconds
4. One ticket appears in the Incidents list, localized to the span. Map shows the fault marker.
5. Go to **Ticket Detail** → Acknowledge → Assign → Mark Resolved (or go back to Simulator and click **Repair** on the active fault)
6. Ticket auto-verifies and closes once the poles come back live.

## Public demo URL

> _Replace before submitting. Suggested hosts: Render, Fly.io, Railway, or any free tier that supports Docker Compose / multi-service. Note cold-start time for reviewers._

- App: `https://YOUR-APP.example.com`
- API: `https://YOUR-API.example.com/api/health`
- _(Free tier cold start: please wait 30–60 seconds on first load.)_

## Demo video

> _Record a 5-minute Loom/YouTube-unlisted walkthrough and paste link here. Script:_
> 1. 0:00 Open the app, show stats, map
> 2. 0:40 Inject span fault → run detection → show ticket appearing
> 3. 1:30 Walk through the ticket detail: AI summary, location, confidence, topology warning
> 4. 2:20 Inject 2nd + 3rd fault simultaneously → show 3 tickets (not merged, not split)
> 5. 3:10 Kill a device → show NO ticket being created (false-positive avoidance)
> 6. 3:40 Repair the first fault → ticket auto-verifies and closes
> 7. 4:20 Attempt to mark a ticket resolved while poles are still dark → system rejects
> 8. 4:40 Closing remarks, what you cut, known issues

`https://REPLACE-ME.example.com/demo-video`

## Docs map

| File | What's inside |
|------|---------------|
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | Diagram, data model, localization algorithm (incl. 60% missing-topology approach), API surface, UI reasoning, AI feature |
| [`DEPLOYMENT.md`](DEPLOYMENT.md) | Prereqs, env vars, exact commands, troubleshooting, reset |
| [`DECISIONS.md`](DECISIONS.md) | Decision log, assumptions, what's fragile, what I'd do with 2 more weeks |
| [`AI-WORKFLOW.md`](AI-WORKFLOW.md) | Tools used, what was delegated, AI mistakes caught, code origin estimate |

## Repository layout

```
Propel_assignment/
├── docker-compose.yml          # Single entry: docker compose up
├── backend/
│   ├── Dockerfile
│   ├── prisma/                 # Postgres schema + initial migration
│   │   └── migrations/
│   ├── src/
│   │   ├── index.ts            # Express bootstrap, periodic jobs
│   │   ├── routes.ts           # REST endpoints
│   │   ├── seed.ts             # Synthetic network generator (3k+ poles)
│   │   ├── ingestion.ts        # Telemetry ingest: dedupe, out-of-order, seq
│   │   ├── topology.ts         # Known topology + geometric inference (the 60% problem)
│   │   ├── localization.ts     # Fault boundary detection, grouping, confidence
│   │   ├── tickets.ts          # Lifecycle, telemetry-verified resolution, AI summary
│   │   ├── simulator.ts        # Fault injector with realistic noise
│   │   └── prisma.ts
│   └── tests/
│       └── localization.test.ts
└── frontend/
    ├── Dockerfile
    ├── nginx.conf              # Also proxies /api → backend
    └── src/
        ├── App.tsx
        ├── lib.ts              # fetcher, conf bucket, ago(), toast
        ├── types.ts
        ├── index.css
        └── components/
            ├── MapView.tsx     # Leaflet / OSM. Poles, DTs, fault markers, span lines
            ├── TicketList.tsx  # Priority-sorted incident feed
            ├── TicketDetail.tsx # Workflow + AI briefing + events
            └── Simulator.tsx   # Span/DT/Feeder injection + repair
```
