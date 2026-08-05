import { useState } from "react";
import type { Ticket } from "../types";
import { apiFetcher, ago, confBucket, faultTypeLabel } from "../lib";

interface Props {
  ticket: Ticket | null;
  onUpdate: () => void;
  setToast: (msg: string, type?: "success" | "error") => void;
}

export default function TicketDetail({ ticket, onUpdate, setToast }: Props) {
  const [crew, setCrew] = useState("Lineman Team A");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);

  if (!ticket) {
    return (
      <div className="empty-state" style={{ paddingTop: 48 }}>
        Select an incident from the list, or inject one via the Simulator tab.
      </div>
    );
  }

  const doAction = async (path: string, body: any = {}, label: string) => {
    setBusy(true);
    try {
      await apiFetcher(`/api/tickets/${ticket.id}${path}`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      setToast(`${label} OK`, "success");
      onUpdate();
    } catch (e: any) {
      setToast(e.message || `Failed to ${label}`, "error");
    } finally {
      setBusy(false);
    }
  };

  const confB = confBucket(ticket.confidence);

  return (
    <div className="ticket-detail">
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
        <span className={`badge ${ticket.faultType}`}>{faultTypeLabel(ticket.faultType)}</span>
        <span className={`badge ${ticket.status}`}>{ticket.status}</span>
      </div>
      <h2>#{ticket.id.slice(0, 8)}…</h2>
      <div style={{ fontSize: 12, color: "#94a3b8", marginTop: 2 }}>
        Detected {ago(ticket.detectedAt)}
      </div>

      <div className="section">
        <h3>AI Summary · Copilot briefing</h3>
        {ticket.aiSummary ? (
          <div className="ai-summary">{ticket.aiSummary}</div>
        ) : (
          <div style={{ fontSize: 12, color: "#64748b" }}>No summary available.</div>
        )}
      </div>

      <div className="section">
        <h3>Location</h3>
        <div className="kv">
          <div className="kv-key">Coordinates</div>
          <div className="kv-val">{ticket.lat.toFixed(5)}°, {ticket.lon.toFixed(5)}°</div>
          <div className="kv-key">PIN code</div>
          <div className="kv-val">{ticket.pincode || "— unavailable"}</div>
          <div className="kv-key">Feeder</div>
          <div className="kv-val">{ticket.feederId || "—"}</div>
          <div className="kv-key">Transformer</div>
          <div className="kv-val">{ticket.dtId || "—"}</div>
          {ticket.spanFromPoleId && (
            <>
              <div className="kv-key">Span from</div>
              <div className="kv-val">{ticket.spanFromPoleId}</div>
              <div className="kv-key">Span to</div>
              <div className="kv-val">{ticket.spanToPoleId}</div>
            </>
          )}
          {ticket.boundaryDarkId && !ticket.spanFromPoleId && (
            <>
              <div className="kv-key">Boundary dark</div>
              <div className="kv-val">{ticket.boundaryDarkId}</div>
            </>
          )}
          <div className="kv-key">Topology</div>
          <div className="kv-val">
            {ticket.topologyKnown ? (
              <span style={{ color: "#22c55e" }}>Known · recorded</span>
            ) : (
              <span style={{ color: "#f59e0b" }}>⚠ Inferred geometrically</span>
            )}
          </div>
        </div>
      </div>

      <div className="section">
        <h3>Impact</h3>
        <div className="kv">
          <div className="kv-key">Poles affected</div>
          <div className="kv-val">{ticket.polesAffected}</div>
          <div className="kv-key">Households</div>
          <div className="kv-val">{ticket.householdsAffected.toLocaleString()}</div>
          <div className="kv-key">Confidence</div>
          <div className="kv-val">
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <div className="confidence-bar" style={{ flex: 1, maxWidth: 100 }}>
                <div
                  className={`confidence-fill ${confB}`}
                  style={{ width: `${Math.round(ticket.confidence * 100)}%` }}
                />
              </div>
              <span>{Math.round(ticket.confidence * 100)}%</span>
            </div>
          </div>
        </div>
      </div>

      <div className="section">
        <h3>Workflow</h3>
        {ticket.status === "detected" && (
          <div className="action-row">
            <button
              className="btn btn-primary"
              disabled={busy}
              onClick={() => doAction("/acknowledge", {}, "Acknowledge")}
            >
              Acknowledge
            </button>
          </div>
        )}
        {(ticket.status === "detected" || ticket.status === "acknowledged") && (
          <div className="action-row" style={{ marginTop: 10 }}>
            <input
              style={{
                flex: 1,
                minWidth: 150,
                background: "#0f172a",
                border: "1px solid #334155",
                color: "#e2e8f0",
                padding: "6px 10px",
                borderRadius: 6,
                fontSize: 13,
              }}
              value={crew}
              onChange={(e) => setCrew(e.target.value)}
              placeholder="Crew name"
            />
            <button
              className="btn btn-primary"
              disabled={busy || !crew}
              onClick={() => doAction("/assign", { crew }, "Assign crew")}
            >
              Assign
            </button>
          </div>
        )}
        {(ticket.status === "assigned" || ticket.status === "resolved") && (
          <div style={{ marginTop: 10 }}>
            <textarea
              style={{
                width: "100%",
                background: "#0f172a",
                border: "1px solid #334155",
                color: "#e2e8f0",
                padding: "6px 10px",
                borderRadius: 6,
                fontSize: 13,
                minHeight: 60,
                resize: "vertical",
                marginBottom: 8,
              }}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="What was repaired? (e.g., 'Replaced blown fuse at P-2211 jumper')"
            />
            <div className="action-row">
              <button
                className="btn btn-success"
                disabled={busy}
                onClick={() => doAction("/resolve", { notes }, "Mark resolved")}
              >
                Mark Resolved
              </button>
              <span style={{ fontSize: 11, color: "#64748b", alignSelf: "center" }}>
                System will verify via telemetry. Rejected if poles still dark.
              </span>
            </div>
          </div>
        )}
        {ticket.assignedCrew && (
          <div className="kv" style={{ marginTop: 10 }}>
            <div className="kv-key">Assigned crew</div>
            <div className="kv-val">{ticket.assignedCrew}</div>
            {ticket.assignedAt && (
              <>
                <div className="kv-key">Assigned at</div>
                <div className="kv-val">{ago(ticket.assignedAt)}</div>
              </>
            )}
            {ticket.resolutionNotes && (
              <>
                <div className="kv-key">Resolution</div>
                <div className="kv-val">{ticket.resolutionNotes}</div>
              </>
            )}
          </div>
        )}
      </div>

      <div className="section">
        <h3>Events</h3>
        <div className="event-feed">
          {[...ticket.events].reverse().map((e) => (
            <div key={e.id} className="event-item">
              <div className="event-time">{ago(e.createdAt)}</div>
              <div>
                <span className="event-type">{e.type}</span>
                <span className="event-msg">{e.message}</span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
