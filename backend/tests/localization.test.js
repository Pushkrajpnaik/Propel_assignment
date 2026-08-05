import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { centroid } from "../src/localization.js";
import { getDownstreamPoles, getUpstreamPath, clearTopologyCache } from "../src/topology.js";
describe("centroid", () => {
    it("computes correct centroid for 2 points", () => {
        const c = centroid([
            { lat: 13.0, lon: 77.0 },
            { lat: 13.2, lon: 77.2 },
        ]);
        assert.ok(Math.abs(c.lat - 13.1) < 0.0001);
        assert.ok(Math.abs(c.lon - 77.1) < 0.0001);
    });
    it("returns zeros for empty input", () => {
        const c = centroid([]);
        assert.equal(c.lat, 0);
        assert.equal(c.lon, 0);
    });
});
describe("topology traversal helpers", () => {
    const sampleTopo = {
        dtId: "D-TEST",
        known: true,
        confidence: 0.9,
        poles: [
            { id: "P1", lat: 0, lon: 0, parentId: null, seqOnLine: 1, distanceFromDT: 0 },
            { id: "P2", lat: 0, lon: 0, parentId: "P1", seqOnLine: 2, distanceFromDT: 1 },
            { id: "P3", lat: 0, lon: 0, parentId: "P2", seqOnLine: 3, distanceFromDT: 2 },
            { id: "P4", lat: 0, lon: 0, parentId: "P3", seqOnLine: 4, distanceFromDT: 3 },
            { id: "P5", lat: 0, lon: 0, parentId: "P2", seqOnLine: 5, distanceFromDT: 2.5 },
            { id: "P6", lat: 0, lon: 0, parentId: "P5", seqOnLine: 6, distanceFromDT: 3.5 },
        ],
        edges: [
            { from: "P1", to: "P2", distance: 1 },
            { from: "P2", to: "P3", distance: 1 },
            { from: "P3", to: "P4", distance: 1 },
            { from: "P2", to: "P5", distance: 1.5 },
            { from: "P5", to: "P6", distance: 1 },
        ],
    };
    it("returns all downstream poles including start", () => {
        const ds = getDownstreamPoles(sampleTopo, "P2");
        assert.equal(new Set(ds).size, 5);
        assert.ok(ds.includes("P2"));
        assert.ok(ds.includes("P3"));
        assert.ok(ds.includes("P4"));
        assert.ok(ds.includes("P5"));
        assert.ok(ds.includes("P6"));
    });
    it("returns leaf pole as just itself", () => {
        const ds = getDownstreamPoles(sampleTopo, "P4");
        assert.deepEqual(ds, ["P4"]);
    });
    it("climbs upstream correctly", () => {
        const path = getUpstreamPath(sampleTopo, "P6");
        assert.equal(path[0], "P6");
        assert.equal(path[1], "P5");
        assert.equal(path[2], "P2");
        assert.equal(path[3], "P1");
    });
});
describe("geometric topology inference", () => {
    it("produces a connected-ish graph on collinear points", () => {
        clearTopologyCache();
        const inferred = {
            dtId: "D-GEO",
            known: false,
            confidence: 0.7,
            poles: [],
            edges: [],
        };
        const latBase = 12.97;
        const lonBase = 77.59;
        for (let i = 0; i < 10; i++) {
            inferred.poles.push({
                id: `GP${i}`,
                lat: latBase + i * 0.0002,
                lon: lonBase + i * 0.0003,
                parentId: i === 0 ? null : `GP${i - 1}`,
                seqOnLine: i + 1,
                distanceFromDT: i * 40,
            });
        }
        for (let i = 1; i < 10; i++) {
            inferred.edges.push({ from: `GP${i - 1}`, to: `GP${i}`, distance: 40 });
        }
        const ds = getDownstreamPoles(inferred, "GP3");
        assert.equal(ds.length, 7);
        const path = getUpstreamPath(inferred, "GP7");
        assert.equal(path.length, 8);
    });
});
//# sourceMappingURL=localization.test.js.map