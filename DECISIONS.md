# Decisions

Newest first. Format per entry: **Date — Decision.** Chose X, rejected Y, why. Ambiguity-resolution assumptions are interleaved and flagged as such.

---

## 2026-08-05 — Stack: Node.js 20 + Express + TypeScript + Postgres + React 18 + Vite + Leaflet

**Chose:**
- Backend: Node + Express + Prisma ORM + Postgres + Zod validation.
- Frontend: React 18, Vite, SWR for data fetching, react-leaflet on top of plain Leaflet + OSM tiles.
- Orchestration: Docker Compose (V2). Single `docker compose up`.

**Rejected:**
- Python/FastAPI backend — my personal build velocity in TS is higher, plus the same team can share types across frontend and backend. Nothing wrong with FastAPI; pure pragmatic choice.
- PostGIS / Postgres geography columns — pole queries are all-by-id or all-by-DT; no geospatial joins in the hot path. Plain floats are faster, simpler, and the haversine formula in application code over ~200 poles (max per DT) is free.
- Next.js full stack — wanted the frontend/backend separation to be obvious for a reviewer reading the repo in 45 minutes. Nginx proxy in compose makes `/api` work like a monolith anyway.
- Mapbox / Google Maps tiles — would require a reviewer to bring or trust an API key. OSM is free, works everywhere, explicit in docs. Accuracy is plenty for a drive-to span.
- Websocket push — polling via SWR at 3 s for tickets, 5 s for stats, 10 s for poles is totally fine at this scale. Avoids a well-known deployment failure mode (reverse proxy + ws upgrade + sticky sessions). ARCHITECTURE.md documents this choice.

## 2026-08-05 — Topology strategy for the 60% missing DTs

**Chose: geometric inference with honest confidence + explicit survey, not coarse DT-only fallback.**

Reasons this won over alternatives:
1. *vs "DT-level fallback everywhere"* — gives the operator nothing better than the old system for 60% of the network. They hired us to get to *a span*, not a transformer. Even a 70%-accurate geometric span saves most of the lineman's walk.
2. *vs "correlate outages over time to learn topology"* — elegant but you need *months of data*. The system has to ship on day 0 with value. Could be layered on later (see 2-week plan below).
3. *vs "survey first, ship after"* — the brief explicitly says this isn't acceptable as a full answer. Survey *plus* an interim system is the full answer.

**Honesty:** Every ticket carries `topologyKnown: boolean`, which is badged everywhere (list item, map tooltip, ticket detail, AI summary, confidence multiplier). A reviewer can tell *at a glance* whether we're sure.

**Survey recommendation (documented for the department):**
- Priority-order DTs by households-served × historical fault-rate (once we have 3 months of data). Start with the top 240 DTs (~17% of fleet) that cover ~60% of households.
- 2-person team: pole-to-pole GPS walk, tag parents + seq in a mobile form. 25 DTs/person/week = ~5 weeks of field work + 3 weeks QA.
- Budget rough: 2 people × 8 weeks × ₹35k/wk all-in = ₹5.6L field cost, plus ₹40k contractor to clean the data and import, ~₹6L total. A fraction of the 2-hour-per-outage cost the department is currently paying.
- System keeps running; we flip `hasTopology` per DT as data lands. No migration.

## 2026-08-05 — Firmware 1.2 handling: stale-heartbeat rule, not a separate code path.

FW 1.2 (~8% of fleet, ~2,800 devices) **never sends a `power_lost` event**. Only stops heartbeating when power dies.

**Chose a single unified rule for "pole is dark":** `state.energized === false` OR (`hasDevice && lastSeen > 17 min ago`). The 17 minutes = 15 min heartbeat interval + 45 s jitter + 90 s clock skew + small safety margin.

Rejected: separate firmware-version detection logic, per-device timers, FW 1.2 asset tagging. The unified rule correctly handles *all* of:
- FW ≥ 1.3 that *did* send `power_lost` (fast).
- FW ≥ 1.3 where `power_lost` was the 30% capacitor-radio failure (slow, but still caught at 17 min).
- FW 1.2 devices (slow, 17 min).
- Dead modems with power still up *only if the pole has no live downstream children* — this filter is the physics-impossibility check and prevents false positives.

Trade-off clearly documented: detection speed for a FW-1.2-only outage is 17 min instead of 10 s. Still **7× faster than the 2-hour baseline**, and honestly reported in the ticket-creation "detected X ago" timestamp.

## 2026-08-05 — Ticket resolution: crew can click "resolved" but the system overrules via telemetry.

Chose two-stage enforcement:
1. **POST `/tickets/:id/resolve` → HTTP 409 with a `reason` string and a `TicketEvent` row** if < 80% of `affectedPoleIds` are live. UI displays the rejection reason inline.
2. **Auto-verification every 15 s** independently promotes `resolved → verified → closed` at ≥ 90% live.

Rejected:
- Blind trust on button-click. The brief explicitly forbids this.
- Requiring both telemetry AND a button-click. The brief says restoration *must be verified from telemetry, not from someone clicking a button*. We still let a crew member *claim* resolved (because that's how work actually gets reported in), but verification is telemetry-only after that.
- 100% live threshold. A single FW-1.2 device on the fringe of the outage that hasn't heartbeated yet, or a 3% no-device pole that we can't confirm, would otherwise block closure forever. 80% for reject / 90% for accept is robust. Documented numbers.

## 2026-08-05 — One alert per fault, never one per dark pole.

Deduplication happens on three layers:
1. **Within a detection cycle:** dark poles that share a boundary live pole AND are within 80 m geographically merge into 1 cluster.
2. **Across cycles:** each ticket creation checks existing `status ∈ {detected,acknowledged,assigned}` tickets within a 2 h window that share (feederId for feeder faults) / (dtId for dt) / (spanFrom or spanTo for span). No duplicates.
3. **Feeder-level collapse:** ≥ 75% of DTs on a feeder going dark at the same time → *one* feeder-level ticket instead of ~100 DT or span tickets. This single choice is what prevents a rainy-day alert storm from being worse than no system at all.

This is explicitly called out as a major evaluation anti-pattern, so the dedupe logic is in the core algorithm, not an afterthought.

## 2026-08-05 — Scheduled outages: treat with a ±45 min window, never as gospel.

Brief says: "shutdowns start late and overrun by 20–40 min routinely; 1 in 10 cancelled without the feed being updated. Treating this feed as gospel will cause you to miss real faults."

Implementation:
- Consulted **only** for DT- and feeder-level decisions (where the scheduled-outage scope naturally maps).
- Window applied: scheduled `start - 45 min` to `end + 45 min`. Catches late starts and overruns.
- Even inside the window, a *span*-level fault is still ticketed. Scheduled outages are whole-feeders or whole-DTs. A specific span failing *during* scheduled maintenance is unexpected and still worth alerting on (someone forgot to isolate that span).

Trade-off: ~10% false-schedule-matches at the 45-min tail. But the alternative (missing real faults because the schedule was stale) is the worse error per the brief.

## 2026-08-05 — Assumptions made (ambiguity resolution)

Where the brief is silent and I had to pick something:

1. **PIN code fallback.** If a fault's affected poles don't have a pincode (the 3% gap + boundary poles), we output `pincode: null` and the UI shows "— unavailable". No online geocoding API call because that would require a key the reviewer doesn't have. For a real deployment, add India Post's offline PIN-code shapefile (open data, ~5 MB) and point-in-polygon at ticket creation time.
2. **"Households affected" for a span fault** = (poles_affected / poles_in_DT) × households_served_by_DT. Real number but linearly approximated; exact per-pole service drops aren't in the asset database and this is accurate enough for a priority sort.
3. **Pole count for synthetic data.** Brief says "a few thousand" is plenty; seed generates ~3,200 poles across ~280 transformers on 31 feeders. This matches the 38,400 / 412 ≈ 93 poles-per-DT *median-ish* ratio, keeps Docker build light, and still exercises clustering on DTs up to ~110 poles. Explicitly documented in seed.ts.
4. **Simulator UI location.** The brief says "drivable from that public URL or from one documented command." I chose the UI tab because reviewers will open the URL anyway; it removes the need for them to copy-paste curl or open a shell. The backend REST endpoints for the simulator are all also callable from curl for anyone who prefers that (documented in API table).
5. **Detection runs every 20 s automatically + on-demand button.** Brief says "< 120 s end-to-end" (p95). 20 s detection interval + 5 s UI refresh = 25 s nominal p50, well under budget. The button exists so a reviewer doesn't need to stare at a clock during a demo.
6. **What "one fault" vs "two faults" means for grouping:** Two faults on the same DT within an 80-m radius collapse to one ticket *by design* (one crew dispatches). Two faults on different DTs, or on the same DT further apart than that, stay separate. This threshold is a constant in localization.ts.

## Known things that are currently wrong or fragile

Rank by how likely I am to get a bug report in week 1 of real use.

1. **Geometric inference on parallel-close spurs.** Two spurs 50 m apart that run parallel for 100 m will have ~3 edges incorrectly bridged. Output confidence drops, badge says "inferred", but the *specific span* localization can be wrong by one spur. Mitigation: this is exactly what the confidence penalty and the UI badge are for.
2. **Simulator in-memory-only state.** `activeFaults` and `deadDevices` are in a Node `Map`, not Postgres. If the backend container restarts, the simulated faults vanish. Fine for a review simulator. Not acceptable for the scheduled-outage test case if you wanted to stress-test deploy.
3. **Dedupe in-memory map, no TTL sweep.** The `seenKeys` `Map<deviceId:seq, ts>` in ingestion never gets cleaned. At ~35k devices × 20 events/day × 24h retention, it's ~1.7 M entries (~100 MB) after which Node GC will handle it, but there is no explicit `setInterval` prune. Add a `for (const [k,t] of seenKeys) if (now - t > WINDOW) seenKeys.delete(k)` sweep once per hour in production.
4. **`FaultTicket.affectedPoleIds` stored as Postgres text-array.** Fine for ≤ 300 poles per ticket. At 10k poles (feeder level), array-array writes in Prisma are slower than a join table. Feeder faults are rare and 3,200 poles max in this dataset, so this is OK today. Refactor to `AffectedPole(ticket_id, pole_id)` join table before city-scale rollout.
5. **No WebSocket, so ticket status changes take up to one SWR polling interval (3 s) to show.** Acceptable for the scenario; documented in ARCHITECTURE.
6. **Tests only cover the pure logic helpers, not the full round-trip.** `localization.test.ts` tests centroid, downstream, upstream. No tests that inject a telemetry batch via supertest and assert that exactly one ticket is created. That's the self-check I would write given 2 more hours. The *manual* simulator UI test path covers this for reviewers.

## What I'd do with two more weeks

In priority order:

1. **Proper end-to-end tests with supertest + testcontainers.** Spin up an ephemeral Postgres, seed a 5-DT micro-network, inject span/DT/feeder/scheduled/dead-modem scenarios, assert 1 / 1 / 1 / 0 / 0 tickets respectively. This is the single biggest confidence-gain per hour for something that will be handed off.
2. **Topology-learning pass.** Store a `correlated_together(pole_a, pole_b, count)` table from historical outage co-occurrences. After ~50 real faults (≈ 3–5 days of monsoon-season data), use these weights to re-score the geometrically inferred edges and promote the tree when a high-confidence alternative emerges. No human survey needed, gets better over time.
3. **Queue + worker for ingestion.** Swap the inline transaction write for a BullMQ producer/consumer on Redis (packages already installed). Accept 5,000 msg/10 s into an in-memory buffer + queue, persist in 500-row bulkserts. Right now 5,000 × upsert in one transaction technically works but hammers Postgres WAL; the queue pattern survives a 50k burst.
4. **Offline PIN-code dataset:** India Post 6-digit PIN polygons are public. Ship as GeoJSON/CSV, add a `resolvePincode(lat,lon)` function at ticket creation so the 3% gap vanishes.
5. **Deployment hardening:** Actually deploy to Render/Fly (with healthchecks, env vars, the documented cold-start warning), record the Loom video, fill in the URLs in README. Currently the structure is there and tested locally, but the public URL + demo video are placeholders (as noted at the top of README.md).
6. **Operator role audit log + ticket assignment presets.** "Lineman Team A" is a free-form text; make it a dropdown from a crew table. Record the operator identity who did each action. The brief says stub auth is fine, but audit log is a natural add once real humans use it.
7. **Per-ticket "related poles" layer on map.** Right now we color the affected poles yellow outline. Add their upstream-path climb to the DT drawn as a connected line, so the operator sees the entire branch that went dark, not just dots. Small UI quality-of-life.
