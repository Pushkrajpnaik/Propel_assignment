import { useEffect, useState, useCallback } from "react";
import useSWR from "swr";
import MapView from "./components/MapView";
import TicketList from "./components/TicketList";
import TicketDetail from "./components/TicketDetail";
import Simulator from "./components/Simulator";
import type { Ticket, Stats } from "./types";
import { apiFetcher, useToast } from "./lib";

export default function App() {
  const { toast, setToast, toastType } = useToast();
  const [selectedTicketId, setSelectedTicketId] = useState<string | null>(null);
  const [rightTab, setRightTab] = useState<"ticket" | "simulator">("simulator");
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [statusFilter, setStatusFilter] = useState<string>("open");

  const statusParam = statusFilter === "open"
    ? "detected,acknowledged,assigned,resolved"
    : statusFilter === "all" ? "" : statusFilter;

  const { data: stats, mutate: mutateStats } = useSWR<Stats>("/api/stats/summary", apiFetcher, {
    refreshInterval: autoRefresh ? 5000 : 0,
  });

  const { data: tickets = [], mutate: mutateTickets } = useSWR<Ticket[]>(
    `/api/tickets${statusParam ? `?status=${encodeURIComponent(statusParam)}` : ""}`,
    apiFetcher,
    {
      refreshInterval: autoRefresh ? 3000 : 0,
    }
  );

  const selectedTicket = tickets.find((t) => t.id === selectedTicketId) || null;

  useEffect(() => {
    if (!selectedTicketId && tickets.length > 0) {
      const openTicket = tickets.find((t) => ["detected", "acknowledged", "assigned", "resolved"].includes(t.status));
      setSelectedTicketId(openTicket?.id || tickets[0]?.id || null);
    }
  }, [tickets, selectedTicketId]);

  const runDetection = useCallback(async () => {
    try {
      const res = await apiFetcher("/api/detection/run", { method: "POST" });
      setToast(`Detection run: ${res.newTickets} new tickets, ${res.autoClosed} auto-closed.`, "success");
      mutateTickets();
      mutateStats();
    } catch (e: any) {
      setToast(e.message || "Detection failed", "error");
    }
  }, [mutateTickets, mutateStats, setToast]);

  const refreshAll = useCallback(() => {
    mutateTickets();
    mutateStats();
  }, [mutateTickets, mutateStats]);

  return (
    <div className="app">
      <div className="topbar">
        <div className="brand">
          <span className="bolt">⚡</span>
          REDSTONE GRID · OUTAGE CONTROL
        </div>
        <div className="stats">
          <div className="stat">
            <span className="stat-label">Open incidents</span>
            <span className={`stat-value ${(stats?.openTickets || 0) > 0 ? "alert" : "good"}`}>
              {stats?.openTickets ?? "—"}
            </span>
          </div>
          <div className="stat">
            <span className="stat-label">Poles reporting dark</span>
            <span className={`stat-value ${(stats?.polesDark || 0) > 10 ? "warn" : ""}`}>
              {stats?.polesDark ?? "—"} / {stats?.totalPoles ?? "—"}
            </span>
          </div>
          <div className="stat">
            <span className="stat-label">Transformers</span>
            <span className="stat-value">{stats?.transformers ?? "—"}</span>
          </div>
          <div className="stat">
            <span className="stat-label">Feeders</span>
            <span className="stat-value">{stats?.feeders ?? "—"}</span>
          </div>
        </div>
        <div className="auto-refresh">
          <input
            id="ar"
            type="checkbox"
            checked={autoRefresh}
            onChange={(e) => setAutoRefresh(e.target.checked)}
          />
          <label htmlFor="ar">Auto-refresh</label>
        </div>
        <div className="topbar-actions">
          <button className="btn" onClick={refreshAll}>Refresh</button>
          <button className="btn btn-primary" onClick={runDetection}>
            Run Detection
          </button>
        </div>
      </div>

      <div className="main">
        <div className="panel left">
          <div className="panel-header">
            Incidents
            <span style={{ fontSize: 11, color: "#94a3b8" }}>{tickets.length}</span>
          </div>
          <div className="filters">
            {[
              { v: "open", l: "Open" },
              { v: "detected", l: "New" },
              { v: "assigned", l: "Assigned" },
              { v: "resolved", l: "Resolved" },
              { v: "verified,closed", l: "Closed" },
              { v: "all", l: "All" },
            ].map((f) => (
              <span
                key={f.v}
                className={`empty-filter-chip ${statusFilter === f.v ? "on" : ""}`}
                onClick={() => setStatusFilter(f.v)}
              >
                {f.l}
              </span>
            ))}
          </div>
          <div className="panel-body">
            <TicketList
              tickets={tickets}
              selectedId={selectedTicketId}
              onSelect={(id) => {
                setSelectedTicketId(id);
                setRightTab("ticket");
              }}
            />
          </div>
        </div>

        <div className="panel map-wrap">
          <MapView
            tickets={tickets}
            selectedTicketId={selectedTicketId}
            autoRefresh={autoRefresh}
          />
          <div className="map-legend">
            <div style={{ fontWeight: 600, marginBottom: 6, fontSize: 11 }}>Legend</div>
            <div className="legend-row"><span className="legend-dot dot-live"></span>Pole energized</div>
            <div className="legend-row"><span className="legend-dot dot-dark"></span>Pole dark / stale</div>
            <div className="legend-row"><span className="legend-dot dot-unknown"></span>No device</div>
            <div className="legend-row"><span className="legend-dot dot-dt"></span>Transformer</div>
            <div className="legend-row"><span className="legend-dot dot-fault"></span>Fault location</div>
          </div>
        </div>

        <div className="panel right">
          <div className="tab-bar">
            <div
              className={`tab ${rightTab === "ticket" ? "active" : ""}`}
              onClick={() => setRightTab("ticket")}
            >
              Ticket Detail
            </div>
            <div
              className={`tab ${rightTab === "simulator" ? "active" : ""}`}
              onClick={() => setRightTab("simulator")}
            >
              Simulator
            </div>
          </div>
          <div className="panel-body">
            {rightTab === "ticket" ? (
              <TicketDetail
                ticket={selectedTicket}
                onUpdate={() => { mutateTickets(); mutateStats(); }}
                setToast={setToast}
              />
            ) : (
              <Simulator
                onFaultInjected={() => { mutateTickets(); mutateStats(); setToast("Fault injected.", "success"); }}
                onRepaired={() => { mutateTickets(); mutateStats(); setToast("Repair telemetry sent.", "success"); }}
                setToast={setToast}
              />
            )}
          </div>
        </div>
      </div>

      {toast && (
        <div className={toastType === "error" ? "error-toast" : "success-toast"}>
          {toast}
        </div>
      )}
    </div>
  );
}
