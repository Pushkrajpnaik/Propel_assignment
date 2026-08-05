import { useState, useEffect } from "react";
import useSWR from "swr";
import type { Transformer, Feeder, Pole, SimulatorState } from "../types";
import { apiFetcher } from "../lib";

interface Props {
  onFaultInjected: () => void;
  onRepaired: () => void;
  setToast: (msg: string, type?: "success" | "error") => void;
}

export default function Simulator({ onFaultInjected, onRepaired, setToast }: Props) {
  const { data: dts = [], mutate: mutateDts } = useSWR<Transformer[]>("/api/transformers", apiFetcher);
  const { data: feeders = [] } = useSWR<Feeder[]>("/api/feeders", apiFetcher);
  const { data: simState, mutate: mutateSimState } = useSWR<SimulatorState>("/api/simulator/state", apiFetcher, {
    refreshInterval: 2500,
  });

  const [mode, setMode] = useState<"span" | "dt" | "feeder" | "noise">("span");
  const [dtId, setDtId] = useState<string>("");
  const [feederId, setFeederId] = useState<string>("");
  const [poleId, setPoleId] = useState<string>("");
  const [dtPoles, setDtPoles] = useState<Pole[]>([]);
  const [busy, setBusy] = useState(false);
  const [deviceId, setDeviceId] = useState<string>("");

  useEffect(() => {
    if (!dtId) { setDtPoles([]); return; }
    let cancelled = false;
    apiFetcher<Pole[]>(`/api/poles?dtId=${encodeURIComponent(dtId)}&limit=500`)
      .then((p) => { if (!cancelled) setDtPoles(p); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [dtId]);

  useEffect(() => {
    if (!dtId && dts.length > 0) {
      const withTopo = dts.find((d) => d.hasTopology && (d._count?.poles || 0) > 20);
      setDtId(withTopo?.id || dts[0].id);
    }
    if (!feederId && feeders.length > 0) {
      setFeederId(feeders[0].id);
    }
  }, [dts, feeders, dtId, feederId]);

  const run = async <T,>(path: string, body: any): Promise<T | null> => {
    setBusy(true);
    try {
      const r = await apiFetcher<T>(path, {
        method: "POST",
        body: JSON.stringify(body),
      });
      mutateSimState();
      mutateDts();
      return r;
    } catch (e: any) {
      setToast(e.message || "Request failed", "error");
      return null;
    } finally {
      setBusy(false);
    }
  };

  const injectSpan = async () => {
    if (!poleId) { setToast("Pick a pole (first dark after fault)", "error"); return; }
    const r = await run<{ faultId: string; affectedCount: number }>("/api/simulator/inject/span", { poleId });
    if (r) {
      onFaultInjected();
      setToast(`Span fault injected: ${r.affectedCount} poles affected (faultId ${r.faultId.slice(-5)})`);
    }
  };

  const injectDT = async () => {
    if (!dtId) { setToast("Pick a transformer", "error"); return; }
    const r = await run<{ faultId: string; affectedCount: number }>("/api/simulator/inject/dt", { dtId });
    if (r) {
      onFaultInjected();
      setToast(`DT fault: ${r.affectedCount} poles under ${dtId} gone dark (faultId ${r.faultId.slice(-5)})`);
    }
  };

  const injectFeeder = async () => {
    if (!feederId) { setToast("Pick a feeder", "error"); return; }
    const r = await run<{ faultId: string; affectedCount: number }>("/api/simulator/inject/feeder", { feederId });
    if (r) {
      onFaultInjected();
      setToast(`Feeder-level fault on ${feederId}: ${r.affectedCount} poles (faultId ${r.faultId.slice(-5)})`);
    }
  };

  const repair = async (faultId: string) => {
    const r = await run<{ repaired: number }>("/api/simulator/repair", { faultId });
    if (r) {
      onRepaired();
      setToast(`Repair telemetry sent for ${r.repaired} poles. Awaiting auto-verification...`);
    }
  };

  const killDevice = async () => {
    if (!deviceId.trim()) { setToast("Enter a device_id to simulate modem failure", "error"); return; }
    await run("/api/simulator/kill-device", { deviceId: deviceId.trim() });
    setToast(`Device ${deviceId.trim()} now dead (no telemetry). Will not trigger a fault if neighbors are live.`, "success");
  };

  const reviveDevice = async () => {
    if (!deviceId.trim()) return;
    await run("/api/simulator/revive-device", { deviceId: deviceId.trim() });
    setToast(`Device ${deviceId.trim()} revived.`, "success");
  };

  const sendHeartbeat = async () => {
    await run("/api/simulator/heartbeat", { count: 200 });
    setToast("200 random heartbeats injected.", "success");
  };

  return (
    <div className="simulator-wrap">
      <div className="sim-card">
        <h4>🔧 Inject Fault</h4>
        <div className="tab-bar" style={{ borderBottom: "none", marginBottom: 10 }}>
          {(["span", "dt", "feeder", "noise"] as const).map((m) => (
            <div
              key={m}
              className={`tab ${mode === m ? "active" : ""}`}
              style={{ padding: "6px 10px", fontSize: 12 }}
              onClick={() => setMode(m)}
            >
              {m === "span" ? "Span" : m === "dt" ? "DT" : m === "feeder" ? "Feeder" : "Noise"}
            </div>
          ))}
        </div>

        {mode === "span" && (
          <>
            <div className="sim-row">
              <label>DT</label>
              <select value={dtId} onChange={(e) => setDtId(e.target.value)}>
                <option value="">Select transformer</option>
                {dts.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.id} · {(d._count?.poles || 0)} poles · {d.hasTopology ? "known topo" : "inferred"}
                  </option>
                ))}
              </select>
            </div>
            <div className="sim-row">
              <label>Pole (dark)</label>
              <select value={poleId} onChange={(e) => setPoleId(e.target.value)}>
                <option value="">Pick 'first dark' pole</option>
                {dtPoles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.id}
                    {p.seqOnLine != null ? ` #${p.seqOnLine}` : ""}
                    {p.parentPoleId ? ` ←${p.parentPoleId}` : ""}
                    {!p.deviceId ? " [no device]" : ""}
                  </option>
                ))}
              </select>
            </div>
            <div className="action-row">
              <button className="btn btn-danger" disabled={busy || !poleId} onClick={injectSpan}>
                Inject Span Fault
              </button>
            </div>
            <div style={{ fontSize: 11, color: "#64748b", marginTop: 8, lineHeight: 1.45 }}>
              Everything downstream of this pole will go dark. ~30% of power_lost messages are dropped (capacitor radio failure). FW 1.2.x devices simply go silent.
            </div>
          </>
        )}

        {mode === "dt" && (
          <>
            <div className="sim-row">
              <label>DT</label>
              <select value={dtId} onChange={(e) => setDtId(e.target.value)}>
                <option value="">Select transformer</option>
                {dts.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.id} · {(d._count?.poles || 0)} poles
                  </option>
                ))}
              </select>
            </div>
            <div className="action-row">
              <button className="btn btn-danger" disabled={busy || !dtId} onClick={injectDT}>
                Blow DT Fuse
              </button>
            </div>
          </>
        )}

        {mode === "feeder" && (
          <>
            <div className="sim-row">
              <label>Feeder</label>
              <select value={feederId} onChange={(e) => setFeederId(e.target.value)}>
                <option value="">Select feeder</option>
                {feeders.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.id} · {(f._count?.transformers || 0)} DTs
                  </option>
                ))}
              </select>
            </div>
            <div className="action-row">
              <button className="btn btn-danger" disabled={busy || !feederId} onClick={injectFeeder}>
                Trip Feeder
              </button>
            </div>
          </>
        )}

        {mode === "noise" && (
          <>
            <div className="sim-row">
              <label>Device ID</label>
              <input
                placeholder="e.g. KSPDB-SD07-D0012-0001"
                value={deviceId}
                onChange={(e) => setDeviceId(e.target.value)}
              />
            </div>
            <div className="action-row" style={{ marginTop: 6 }}>
              <button className="btn" disabled={busy} onClick={killDevice}>Kill device (modem dead)</button>
              <button className="btn btn-success" disabled={busy} onClick={reviveDevice}>Revive</button>
            </div>
            <div className="action-row" style={{ marginTop: 6 }}>
              <button className="btn" disabled={busy} onClick={sendHeartbeat}>Send 200 Heartbeats</button>
            </div>
            <div style={{ fontSize: 11, color: "#64748b", marginTop: 10, lineHeight: 1.45 }}>
              Killing a device with power still on should NOT create a fault ticket. If the pole's children are live, the system knows it's a sensor failure.
            </div>
          </>
        )}
      </div>

      <div className="sim-card">
        <h4>🩸 Active Faults</h4>
        {!simState || simState.activeFaults.length === 0 ? (
          <div style={{ fontSize: 12, color: "#64748b", padding: "4px 0" }}>
            No active simulated faults.
          </div>
        ) : (
          <div className="active-faults">
            {simState.activeFaults.map((f) => (
              <div key={f.id} className="active-fault-item">
                <div>
                  <div style={{ fontWeight: 600 }}>
                    {f.config.type === "span" ? "Span" : f.config.type === "dt" ? "DT" : "Feeder"}
                  </div>
                  <div style={{ fontSize: 11, color: "#fca5a5", marginTop: 2 }}>
                    {f.affectedPoleCount} poles · {f.id.slice(-6)}
                  </div>
                </div>
                <button className="btn btn-success" disabled={busy} onClick={() => repair(f.id)}>
                  Repair
                </button>
              </div>
            ))}
          </div>
        )}
        <div style={{ fontSize: 11, color: "#64748b", marginTop: 10, lineHeight: 1.45 }}>
          Click Repair to send boot + power_restored telemetry. The system will auto-verify poles before closing the ticket.
        </div>
      </div>

      <div className="sim-card">
        <h4>ℹ How to evaluate this system</h4>
        <ol style={{ margin: 0, paddingLeft: 18, fontSize: 12, color: "#cbd5e1", lineHeight: 1.6 }}>
          <li>Pick a known-topology DT and inject a span fault → exactly <strong>1 ticket</strong>.</li>
          <li>Inject 3 span faults in different DTs → <strong>3 tickets</strong>, not 1, not 30.</li>
          <li>Noise → kill a device: <strong>no ticket</strong>.</li>
          <li>Repair → ticket <strong>auto-verifies</strong> within ~20s.</li>
          <li>Mark resolved while poles still dark → system <strong>rejects</strong>.</li>
          <li>Try a no-topology DT → note confidence drop and "inferred" badge.</li>
        </ol>
      </div>
    </div>
  );
}
