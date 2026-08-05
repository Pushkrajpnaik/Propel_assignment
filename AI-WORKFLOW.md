# AI Workflow

## Which tools, for what

I used AI tooling heavily. Summary of tools and rough allocation of effort:

| Tool | Used for | % of AI-assisted labour |
|------|----------|------------------------|
| **Claude / Claude Code (IDE-integrated)** | Architectural planning, schema design, localization algorithm pseudocode → real code, ticket lifecycle logic, documentation prose. | ~55% |
| **GitHub Copilot** | Autocomplete inside the IDE while wiring up REST handlers, Zod schemas, component prop plumbing, CSS. | ~25% |
| **GPT-4o (web)** | Rubber-ducking the missing-topology approach with a "pretend you're the Karnataka ESCOM engineer reviewing my plan" role-play; sanity-checking the confidence scoring rules; editing the 5 markdown docs for tone and scannability. | ~20% |

## What I delegated wholesale versus wrote myself

**Delegated (AI output → landed with light edits or none):**
- Docker Compose structure + Dockerfiles (Node build stages, nginx proxy, healthchecks). Copied from a mental template then adjusted.
- Prisma schema and the initial SQL migration. Scaffolded from the domain table list, then manually reviewed every relation and index.
- Leaflet / react-leaflet boilerplate for the map component (tile layer, CircleMarker styling, polyline, divIcon pulsing marker).
- The long-form markdown docs: structure outline, first draft of the simulator's "how to evaluate" bullet list, first-pass troubleshooting section.
- Zod validation schemas and API route plumbing in `routes.ts`. Boring, mechanical, perfect for AI.
- Synthetic seed data: the geometric shape generation for main run + branches, distribution functions (gaussian pole count, old-firmware ratio, pincode missing).

**Wrote myself, then checked with AI:**
- **Topology inference algorithm.** I designed the sort-by-distance + nearest-attached-neighbour + score-bias approach by hand, wrote the code, then asked GPT-4o "find the bug — how could this produce a cycle and what's the worst case on a grid of poles?" It correctly pointed out the missing visited-set guard in the upstream climber; I added it.
- **Localization boundary detection + grouping.** The 4-step climb/merge/filter/confidence pipeline was designed on a whiteboard first; I typed it in and used Copilot for completion on the inner loops. The crucial "single dark pole with live children = sensor failure" rule is mine; I explicitly did not let AI choose that threshold.
- **Ticket-resolution telemetry-vs-button enforcement.** The 80%/90% thresholds and the rejection flow (HTTP 409 + TicketEvent row) were a design decision I made before opening any code.
- **AI feature placement argument.** The "LLM for the briefing paragraph only, never for localization" call was mine. I used AI to refine the justification paragraph after writing the first version.
- **Every constant and threshold.** 17 min staleness window, 80 m merge radius, 75% feeder-dark ratio, 0.30/0.97 confidence clamp, 45 min scheduled-outage slack. I set every number; AI was never allowed to "suggest a good threshold".

Line-by-line, **roughly 65–70% of the final code was AI-generated or AI-autocompleted**, and **100% of it was reviewed line-by-line by me before committing.** The pure-logic sections (topology, localization, ticket rejection) are majority-authored by me with autocomplete; the boilerplate sections (API routes, Docker, seed data schema, CSS, React layout) are majority-AI with me doing final edits.

## Two or three concrete cases where the AI was wrong or misleading

### 1. Geometric topology inference silently produced disconnected components.
**What AI wrote:** The first version of `inferTopologyGeometrically` only tried to attach each pole to already-assigned poles *within 80 m*. If a branch spurred off a main run at an angle and stepped > 80 m per pole (common on street corners), all poles beyond the gap ended up with `parentId = null`, and `getDownstreamPoles` from the boundary returned nothing = zero tickets for real faults.

**How I caught it:** I wrote the test case `geometric topology inference / collinear points` and asserted that the tree had 10 nodes connected. On the AI draft it returned 1 connected component of size 3, plus 7 orphans. Failed. Second AI attempt fixed the 80 m threshold but forgot to add "score bonus toward poles closer-to-DT", producing a tree where a pole 100 m away on the opposite side of the DT could be chosen as parent — wrong wiring. The final version has a two-stage attachment with a distance-from-DT penalty in the scoring function. Hand-authored scoring formula; fixed.

### 2. Ticket resolution let a crew mark "resolved" without a rejection on 79% live poles.
**What AI wrote:** An `if (liveRatio < 0.5)` check. This is way too loose. A DT with 100 poles can have 40 still dark and the AI draft was fine with that. The brief explicitly says: "If a lineman marks it fixed and the poles are still dark, the system should not believe him." 50% is not "poles still dark"-worthy; 79% live is still 21% dark with no good reason.

**How I caught it:** Reading the generated code against the self-check checklist in 03-deliverables-and-submission.md:
> "Marked a ticket resolved while the poles were still dark. The system pushed back."

I changed the thresholds to **< 80% → HTTP 409 + TicketEvent rejection**, **≥ 90% → auto-verified closed**. Added a specific unit-checklist entry against the doc. I also wrote the "HTTP 409 with a reason string + a TicketEvent row" so the rejection is auditable in the event feed, not just a toast.

### 3. Incorrect assumption that `parent_pole_id` was the downstream-leaning direction.
**What AI wrote for seed data:** When generating a parent-linked tree for known-topology DTs, it set `parentPoleId` to point *away* from DT (so each pole points at its child, not its parent). The localization climber in `getUpstreamPath` then ran *away* from the live region instead of toward it. Boundaries were wrong; a span fault was reported 12 poles downstream of the real break.

**How I caught it:** I injected a span fault on a known-topology DT, found the ticket, and noticed in the map that the fault marker was at the *leaf* of the affected branch instead of the root. Cross-checked against `01-problem-context.md`:
> "When a span fails, everything electrically downstream of it goes dark. Everything upstream stays live. … The fault is on the span between [last live pole] and [first dark pole beyond it]."

Flipped the direction in seed (poles point at their *upstream* / DT-side parent), deleted the DB volume, re-seeded, re-injected, correct boundary. Added a regression test in `getUpstreamPath` to ensure the direction ends at the root pole. This was the most expensive AI-produced bug in the whole project; cost me ~20 minutes of tracing.

## Rough code-origin estimate

| Category | LOC approx | % AI-authored | % human-authored |
|----------|------------|---------------|------------------|
| Algorithm (topology + localization + tickets lifecycle) | ~850 | 35% | 65% |
| Seed data + simulator | ~500 | 70% | 30% |
| API routes + ingestion + prisma + boot | ~550 | 75% | 25% |
| React components + CSS + types + lib | ~1300 | 65% | 35% |
| Markdown docs (5 files) | ~4500 lines | 45% | 55% |
| Docker + config + package.json | ~150 | 80% | 20% |
| **Total** | **~7850** | **~55%** | **~45%** |

These are honest ranges. If I had to give one number to the question in the brief: **a narrow majority of the code was produced or heavily shaped by AI tooling. Every line was read, changed where needed, and understood by me.**

## Best-work prompts / session excerpts

### Prompt 1 — Architecture design, before writing any code
> "I'm designing a fault-detection system for a power utility. The domain: radial LV network, each pole has an IoT device that only reports energized y/n plus lat/lon per pole. For 60% of transformers the parent-pole topology is not digitized. I need the output to be a localized span (not just a DT) with confidence, plus a way to avoid alerting for dead modems and scheduled load shedding. Brainstorm 3 different approaches to the missing-topology problem, rank them by (1) value on day 0, (2) operator trust, (3) long-term correctness as data arrives, then write the core data structures for your recommended approach. Do NOT reach for an LLM for the localization step — explain why not."

Why it worked: Forced trade-off thinking, ranked output, the "explain why no LLM" line ensured the response grounded itself in the physical problem, not the trendiest tool. Produced the geometric-inference-plus-honest-confidence direction I went with.

### Prompt 2 — Review pass on the localization algorithm (after writing it)
> "Here is a TypeScript file. It localizes power distribution faults by finding the last-live / first-dark boundary on a tree. Read the functions: `runDetection`, `findSpanFaults`, `climbToBoundary`, `mergeBoundaries`. Play the role of the Karnataka ESCOM control-room head, then play the role of a grumpy SRE at a cloud provider. For each role, list the specific ways this algorithm will fail or get you paged at 3 am. Be concrete — not 'it might have bugs' but 'scenario X with poles in shape Y produces wrong output Z'. Then rank the failure modes by how often each will actually happen in a Bangalore urban network. Do NOT fix anything; just list them ranked."

Why it worked: Got me the single-dark-pole-live-children case, the parallel-spur-80-m case, the "firmware 1.2 takes 17 minutes so detection seems broken to an operator who just injected a fault" case, and the scheduled-outage-±window case. Exactly 4 bugs worth fixing; I then fixed them by hand.

### Prompt 3 — Documentation rewrite pass
> "I have a 5-document set for a hiring take-home assignment (README, ARCHITECTURE, DEPLOYMENT, DECISIONS, AI-WORKFLOW). The reviewer has 45 minutes, skims, and assumes anything undocumented is broken. Rewrite these principles for me to apply while editing:
> 1. Every section of every doc should answer a question the reader is *actually asking at that point in the 45 min*.
> 2. If I claim a number, say how I measured it or that I estimated it.
> 3. The DEPLOYMENT troubleshooting section must describe symptoms a human actually sees, not internal causes.
> 4. Every AI-mistakes story in AI-WORKFLOW must end with the exact mechanism that caught it (a test, a checklist item, a manual injection, reading the brief).
> Apply these 4 rules as the editing rubric. Do NOT rewrite the docs — write the 4 rubric items plus 3 additional rules you'd add for this exact context."

Why it worked: Made the docs reviewer-centric instead of author-centric. The 8 troubleshooting items with "symptom → cause → fix" all came from re-editing with this rubric. Also directly motivated the "HOW TO EVALUATE THIS SYSTEM" section inside the Simulator tab, because the reviewer-question was "how do I test this?" — not "show me a cool control panel."
