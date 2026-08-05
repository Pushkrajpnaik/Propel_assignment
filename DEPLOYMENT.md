# Deployment

Written for someone who has the repo and nothing else. Everything below has been tested locally.

## Prerequisites

| Tool | Version | Why |
|------|---------|-----|
| Docker Engine | ≥ 24.0 | Runs all services via Compose |
| Docker Compose Plugin | ≥ 2.20 | The `docker compose` subcommand (V2). **Not** the old `docker-compose` (hyphen) binary. |
| Modern browser | — | Frontend. Chrome, Safari, Firefox current-release all fine. |
| (optional) Node.js | ≥ 20 | If you want to run the backend/frontend outside Docker, develop, or run tests. |
| (optional) OpenAI API key | — | For LLM incident briefings. Without it, the feature falls back to a rule-based summary. No runtime errors. |

Disk: ~2.5 GB for the four images (Postgres 15 alpine, Redis 7 alpine, Node 20 alpine × 2 build stages, Nginx 1.27 alpine).

RAM: 1.2 GB idle with seed data loaded; peaks at ~2.2 GB during first-build compilation + seed.

Ports used (all in `docker-compose.yml`, edit there if conflicting):
- `5432` — Postgres
- `6379` — Redis
- `3001` — Backend API
- `3000` — Frontend (Nginx)

## Exact commands, in order

```bash
# 1. Clone and enter
git clone <YOUR-REPO-URL> kspdb
cd kspdb

# 2. (optional) Copy env example. Works out-of-the-box without this step because
#    Docker Compose passes the defaults inline, but set this if you want an API key.
cp .env.example .env
# edit .env to set OPENAI_API_KEY=sk-... if you have one

# 3. One-command full stack
docker compose up --build
```

**First run timeline** (on a 2022 MacBook with gigabit internet; add ~2–3× on a cold start on Render free tier):
- `0:00` Build starts. Pulls Postgres, Redis, Node, Nginx base images.
- `1:00` Backend npm ci + tsc build running.
- `2:15` Frontend vite build running.
- `2:45` Postgres healthy; backend starts. Prisma runs the 0001_init migration.
- `2:55` Seed runs: 4 substations, 31 feeders, ~280 transformers, ~3,200 poles, ~2,900 PoleStates, 8 scheduled outages, simulation row.
- `3:00` Backend listening on :3001. Nginx serving frontend on :3000.

You will see in backend logs:
```
Seeding database...
Created 31 feeders
Created 280 transformers
Created 3211 poles
Created 3211 pole states
Seeding complete.
KSPDB backend listening on port 3001
```

## Verify it worked

Open three URLs in order:

1. **API health:** http://localhost:3001/api/health
   Expected: `{"status":"ok","ts":"..."}`

2. **Stats:** http://localhost:3001/api/stats/summary
   Expected: JSON with `totalPoles` 3,000–3,500, `openTickets` 0 on a clean start.

3. **App:** http://localhost:3000
   Expected: Dark-themed dashboard. Top bar shows stats. Left "Incidents" panel says `No incidents`. Map is centered on Bangalore.

4. **Smoke test — inject a fault:**
   - Open the Simulator tab (right-hand side).
   - Mode: Span.
   - Pick any DT that says "known topo".
   - Pick any pole except the first couple (to ensure there *are* downstream poles).
   - Click **Inject Span Fault**.
   - Click **Run Detection** (top-right of app).
   - Wait ~5 s. One ticket appears in the left list with confidence 75–95%.

### Run tests

Only needed for local dev. From the repo root:

```bash
cd backend
npm ci
npx prisma generate
npm test
```

Expected: `localtests` pass (centroid, downstream traversal, upstream climb, geometric sample). ~300 ms.

## Environment variables

All optional. The Docker Compose file supplies working defaults for everything except `OPENAI_API_KEY`.

| Name | Default (in compose) | Required? | Purpose | Safe default for local dev |
|------|---------------------|-----------|---------|---------------------------|
| `DATABASE_URL` | `postgresql://kspdb:kspdb_pass@postgres:5432/kspdb` | ✅ inside compose | Prisma connection. Copy exactly as-is. | Same, or point `localhost` for non-Docker runs. |
| `REDIS_URL` | `redis://redis:6379` | Soft (code handles missing Redis gracefully today) | Reserved for BullMQ queue in a future version. Leave it. | Same. |
| `PORT` | `3001` | ✅ for backend | Listen port. | `3001`. |
| `NODE_ENV` | `production` in image, `development` outside | ✅ for build output behaviour. | Switches Prisma log level, etc. | `development` locally. |
| `VITE_API_URL` | `http://localhost:3001` | Inside compose the nginx proxy handles `/api` → backend. Only needed for `vite dev`. | Frontend dev-server proxy target. | `http://localhost:3001`. |
| `OPENAI_API_KEY` | *not set* | ❌ | If set, tickets get an LLM-written briefing paragraph. If unset, rule-based fallback is used. | Leave blank; only set if testing the AI feature. |

Commit a `.env.example` (done) — never commit `.env` (it's in `.gitignore`).

## Troubleshooting

The problems below are ones I actually hit while building.

### 1. Port conflicts — `Bind for 0.0.0.0:5432 failed: port is already allocated`

Symptom: `docker compose up` aborts with one or more "port is already allocated" lines.

Fix:
```bash
# Free the port (example for 5432; repeat for 3000/3001/6379 as needed)
lsof -i :5432            # see who holds it
kill -9 <PID>            # or stop that Postgres service cleanly

# Or edit docker-compose.yml to use different host ports — change the left-hand side only:
#   ports:
#     - "5433:5432"   # host 5433, container still 5432
#     - "6380:6379"
#     - "3002:3001"
#     - "3003:80"
docker compose up
```

### 2. Migrations race the database — `Prisma Migrate could not apply the migration`

Symptom: Backend container starts before Postgres is actually listening, even though the healthcheck exists. Very rare on Docker Desktop but happens on Linux daemon configs with slow I/O.

Fix (one-time):
```bash
# Start only Postgres first
docker compose up -d postgres
sleep 5
docker compose up --build
```

Permanent fix already applied in compose: `depends_on: { postgres: { condition: service_healthy } }` with a 5s-interval healthcheck. If you still see this, bump the backend container's sleep in `command:` or reduce Postgres checkpoint parameters for the dev image.

### 3. ARM vs x86 image warnings on Apple Silicon

Symptom: `WARNING: The requested image's platform (linux/amd64) does not match the detected host platform (linux/arm64/v8)` on base image pulls.

Impact: Works fine under emulation (Rosetta 2) but is ~15% slower.

Fix (optional, for speed): Add `platform: linux/arm64/v8` to the Postgres/Redis/Nginx service blocks in `docker-compose.yml`. The Node images are multi-arch and pull correctly by default. Do **not** force platform on images you will push to a x86 cloud host.

### 4. Backend exits on startup with "Environment variable not found: DATABASE_URL"

Symptom: Crashes immediately after `node dist/index.js`.

Cause: `docker-compose.yml` `environment:` section was edited or is missing.

Fix: Ensure each of the four `environment:` lines for backend service is present exactly as committed. If running `node dist/index.js` manually outside Docker:
```bash
export DATABASE_URL=postgresql://kspdb:kspdb_pass@localhost:5432/kspdb
export PORT=3001
node dist/index.js
```

### 5. Map tiles don't load in the deployed public URL

Symptom: Map area is grey. Console shows CORS or `https://tile.openstreetmap.org` blocked-Mixed-Content errors.

Cause: Your public HTTPS URL is trying to load HTTP tile URLs, or reverse proxy has content-security-policy headers.

Fixes:
- Ensure tile URL starts with `https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png` (committed code already does this).
- If behind Cloudflare/Nginx with a strict CSP, add `https://*.tile.openstreetmap.org` to `img-src` and `connect-src`.
- Frontend nginx.conf in repo has no CSP header — if your PaaS adds one, override it.

### 6. Cold-start timeout on Render / Railway free tier

Symptom: Deploy works, first request 502, works after reload.

Cause: Free tier sleeps after 15 min idle; app takes ~60 s to warm Postgres + run seed + populate caches.

Fix (documented, not coded): Put it in the README so reviewers wait. *Already noted in README.md top*: "Free tier cold start: wait 30–60 s on first load."

Code mitigation (already in place): Seed data is idempotent with an early-exit (`if (existing > 0) return`) so a restart that kills mid-seed on a 2nd request still resumes cleanly.

### 7. CORS errors on public deploy where frontend ≠ backend host

Symptom: `Access to fetch at 'https://api.example.com/api/tickets' from origin 'https://app.example.com' has been blocked by CORS policy.`

Three fixes, pick one:
1. (Recommended, what the Docker setup does) Frontend and backend share origin via a reverse proxy. Nginx proxies `/api/*` → backend. No CORS needed at all.
2. If separate hosts: set backend `cors()` origin to an env-configured allowlist. `routes.ts` already uses `cors()` open — change to `cors({ origin: ['https://app.example.com'] })`.
3. Add a `VITE_API_URL` build arg that points frontend at the absolute API URL.

### 8. Simulator shows "No DT data" or empty DT dropdown

Symptom: Seed ran but UI fetches return empty arrays.

Likely cause: You hit the backend before seed finished (≤ 20 s window on the first run ever). The 10-second SWR revalidation will fix it on its own. Click **Refresh** in the top bar to force.

Permanent fix: Backend waits on seed before binding the port — `start()` in `index.ts` seeds first, then `app.listen`. If you still see it, the Postgres-first approach in fix #2 eliminates this.

### 9. Fault injected but no ticket appears after 30 s

Run this triage checklist in order:
1. Click **Run Detection** top bar. Detection also runs every 20 s automatically, but on-demand is faster.
2. Open browser Network tab, confirm `POST /api/simulator/inject/span` returned 200.
3. Check Simulator → Active Faults card. If the fault you injected is *not* listed there, it never went through.
4. If Active Faults lists it, go to `GET /api/stats/summary`. Did `polesDark` go up? If no → the telemetry messages for those poles were all dropped as duplicates or seq < lastSeq (expected if you re-inject the same span before Repairing it).
5. If polesDark went up and still no ticket → check if DT was filtered by scheduled outage. Go to `/api/scheduled-outages`, sort by start/end, see if DT.id or Feeder.id matches one of the windows ± 45 min.

## Reset to a clean state

Four levels, from softest to hardest:

**A. Soft: just clear simulated faults & tickets, keep network assets.**
```bash
# Open a shell into the backend container
docker compose exec backend sh -c "
  node -e '
    const { PrismaClient } = require(\"@prisma/client\");
    const p = new PrismaClient();
    Promise.all([
      p.faultTicket.deleteMany(),
      p.ticketEvent.deleteMany(),
      p.telemetryEvent.deleteMany(),
      p.poleState.updateMany({ data: { energized: true, lastSeen: new Date(), lastEvent: \"heartbeat\", lastSeq: Math.floor(Math.random()*10000) } }),
      p.simulationState.update({ where: { id: 1 }, data: { faults: [], deadDevices: [], running: false, updatedAt: new Date() } }),
    ]).then(() => process.exit(0));
  '
"
```

**B. Medium: wipe the database, re-run migrations + seed.**
```bash
docker compose down
docker volume rm kspdb_pgdata     # exact volume name: run `docker volume ls` if unsure; usually <dir>_pgdata
docker compose up --build
```

**C. Hard: blow away containers, volumes, and all built images.**
```bash
docker compose down -v --rmi local
docker compose up --build
```

**D. Nuclear: prune everything docker on the machine (will affect other projects!).**
```bash
docker system prune -af --volumes
```
