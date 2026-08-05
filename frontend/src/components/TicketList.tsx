import type { Ticket } from "../types";
import { ago, confBucket, faultTypeLabel } from "../lib";

interface Props {
  tickets: Ticket[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}

export default function TicketList({ tickets, selectedId, onSelect }: Props) {
  if (tickets.length === 0) {
    return (
      <div className="empty-state">
        No incidents — all clear.
        <div style={{ marginTop: 10, fontSize: 11 }}>
          Use the <strong>Simulator</strong> tab to inject a fault.
        </div>
      </div>
    );
  }

  return (
    <>
      {tickets.map((t) => (
        <div
          key={t.id}
          className={`ticket-list-item ${selectedId === t.id ? "active" : ""}`}
          onClick={() => onSelect(t.id)}
        >
          <div className="ticket-head">
            <div>
              <span className={`badge ${t.faultType}`} style={{ marginRight: 6 }}>
                {faultTypeLabel(t.faultType)}
              </span>
              <span className="ticket-type">#{t.id.slice(0, 6)}</span>
            </div>
            <span className={`badge ${t.status}`}>{t.status}</span>
          </div>
          <div className="ticket-meta">
            {t.polesAffected} poles · {t.householdsAffected.toLocaleString()} h/h
            {t.pincode ? ` · PIN ${t.pincode}` : ""}
            {t.topologyKnown ? "" : " · ⚠ inferred topology"}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <div className="confidence-bar" style={{ flex: 1 }}>
              <div
                className={`confidence-fill ${confBucket(t.confidence)}`}
                style={{ width: `${Math.round(t.confidence * 100)}%` }}
              />
            </div>
            <span style={{ fontSize: 11, color: "#94a3b8", minWidth: 40, textAlign: "right" }}>
              {Math.round(t.confidence * 100)}%
            </span>
          </div>
          <div style={{ fontSize: 11, color: "#64748b" }}>
            Detected {ago(t.detectedAt)}
          </div>
        </div>
      ))}
    </>
  );
}
