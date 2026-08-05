import { useMemo } from "react";
import { MapContainer, TileLayer, CircleMarker, Popup, Polyline, Marker, Tooltip } from "react-leaflet";
import useSWR from "swr";
import L from "leaflet";
import type { Ticket, Pole, Transformer } from "../types";
import { apiFetcher, ago, faultTypeLabel } from "../lib";

interface Props {
  tickets: Ticket[];
  selectedTicketId: string | null;
  autoRefresh: boolean;
}

const DEFAULT_CENTER: [number, number] = [12.965, 77.595];

const faultIcon = L.divIcon({
  className: "",
  html: `<div style="
    width: 20px;
    height: 20px;
    background: #f59e0b;
    border: 3px solid #fde68a;
    border-radius: 50%;
    box-shadow: 0 0 0 4px rgba(245,158,11,0.25);
    animation: faultPulse 1.4s infinite;
  "></div>
  <style>@keyframes faultPulse { 0%,100% { transform: scale(1); } 50% { transform: scale(1.25); } }</style>`,
  iconSize: [20, 20],
  iconAnchor: [10, 10],
});

const dtIcon = L.divIcon({
  className: "",
  html: `<div style="
    width: 12px; height: 12px;
    background: #8b5cf6;
    border: 2px solid #c4b5fd;
    transform: rotate(45deg);
    box-shadow: 0 1px 3px rgba(0,0,0,0.4);
  "></div>`,
  iconSize: [12, 12],
  iconAnchor: [6, 6],
});

export default function MapView({ tickets, selectedTicketId, autoRefresh }: Props) {
  const { data: poles = [] } = useSWR<Pole[]>("/api/poles?limit=2000", apiFetcher, {
    refreshInterval: autoRefresh ? 10000 : 0,
    revalidateOnFocus: false,
  });

  const { data: transformers = [] } = useSWR<Transformer[]>("/api/transformers", apiFetcher, {
    revalidateOnFocus: false,
  });

  const selectedTicket = tickets.find((t) => t.id === selectedTicketId) || null;

  const affectedIds = useMemo(() => {
    const set = new Set<string>();
    if (selectedTicket) for (const id of selectedTicket.affectedPoleIds) set.add(id);
    return set;
  }, [selectedTicket]);

  const polylines: [number, number][][] = useMemo(() => {
    if (!selectedTicket) return [];
    const arr: [number, number][][] = [];
    const coords: [number, number][] = [];
    if (selectedTicket.spanFromPoleId || selectedTicket.spanToPoleId) {
      if (selectedTicket.boundaryLiveId) {
        const livePole = poles.find((p) => p.id === selectedTicket.boundaryLiveId);
        if (livePole) coords.push([livePole.lat, livePole.lon]);
      }
      if (selectedTicket.boundaryDarkId) {
        const darkPole = poles.find((p) => p.id === selectedTicket.boundaryDarkId);
        if (darkPole) coords.push([darkPole.lat, darkPole.lon]);
      }
      if (coords.length === 2) arr.push(coords);
    }
    return arr;
  }, [selectedTicket, poles]);

  const now = Date.now();

  return (
    <MapContainer
      center={DEFAULT_CENTER}
      zoom={14}
      zoomControl
      style={{ height: "100%", width: "100%", background: "#0f172a" }}
      preferCanvas
    >
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a>'
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        maxZoom={19}
      />

      {transformers.map((dt) => (
        <Marker
          key={`dt-${dt.id}`}
          position={[dt.lat, dt.lon]}
          icon={dtIcon}
        >
          <Tooltip direction="top" offset={[0, -6]} opacity={0.95}>
            <div style={{ fontSize: 12 }}>
              <strong>{dt.id}</strong><br />
              {dt.capacityKva} kVA · {dt.householdsServed} h/h<br />
              {dt.hasTopology ? "✓ Topology known" : "⚠ Inferred"}
            </div>
          </Tooltip>
        </Marker>
      ))}

      {poles.map((p) => {
        const state = p.currentState;
        const isAffected = affectedIds.has(p.id);
        let color = "#22c55e";
        let radius = 2.5;
        if (!p.deviceId) {
          color = "#64748b";
        } else if (!state) {
          color = "#94a3b8";
        } else {
          const stale = now - new Date(state.lastSeen).getTime() > 17 * 60 * 1000;
          if (!state.energized || stale) {
            color = "#ef4444";
            radius = 3.2;
          }
        }
        if (isAffected) {
          radius = 4.5;
        }
        return (
          <CircleMarker
            key={p.id}
            center={[p.lat, p.lon]}
            radius={radius}
            pathOptions={{
              color: isAffected ? "#fde047" : color,
              weight: isAffected ? 2 : 0,
              fillColor: color,
              fillOpacity: isAffected ? 0.95 : 0.7,
              stroke: isAffected,
            }}
            eventHandlers={isAffected ? undefined : undefined}
          >
            {isAffected && (
              <Popup>
                <div style={{ fontSize: 12, minWidth: 160 }}>
                  <strong>{p.id}</strong>
                  <div style={{ color: "#64748b", marginTop: 4 }}>
                    DT: {p.dtId} · Ward {p.ward}
                  </div>
                  {state ? (
                    <div style={{ marginTop: 4 }}>
                      {state.energized ? "⚡ Live" : "🌑 Dark"} · {ago(state.lastSeen)}
                    </div>
                  ) : (
                    <div style={{ color: "#94a3b8", marginTop: 4 }}>No device</div>
                  )}
                </div>
              </Popup>
            )}
          </CircleMarker>
        );
      })}

      {polylines.map((pts, i) => (
        <Polyline
          key={`poly-${i}`}
          positions={pts}
          pathOptions={{ color: "#f59e0b", weight: 4, opacity: 0.95, dashArray: "6,4" }}
        />
      ))}

      {tickets.map((t) => (
        <Marker
          key={`ticket-${t.id}`}
          position={[t.lat, t.lon]}
          icon={faultIcon}
        >
          <Tooltip direction="top" offset={[0, -12]} opacity={1} permanent={t.id === selectedTicketId}>
            <div style={{ fontSize: 12, minWidth: 180 }}>
              <div style={{ fontWeight: 700, marginBottom: 2 }}>
                {faultTypeLabel(t.faultType)} · #{t.id.slice(0, 6)}
              </div>
              <div style={{ color: "#475569", fontSize: 11 }}>
                {t.polesAffected} poles · ~{t.householdsAffected} h/h
                {t.pincode ? ` · PIN ${t.pincode}` : ""}
              </div>
              <div style={{ marginTop: 2, fontSize: 11, color: t.confidence >= 0.8 ? "#16a34a" : t.confidence >= 0.55 ? "#ca8a04" : "#dc2626" }}>
                {Math.round(t.confidence * 100)}% confidence
                {!t.topologyKnown && " · ⚠ inferred"}
              </div>
            </div>
          </Tooltip>
          <Popup>
            <div style={{ fontSize: 12, minWidth: 200 }}>
              <strong>{faultTypeLabel(t.faultType)}</strong>
              <div style={{ color: "#64748b", marginTop: 4 }}>
                {t.polesAffected} poles · {t.householdsAffected} households
                {t.pincode ? ` · PIN ${t.pincode}` : ""}
              </div>
              <div style={{ marginTop: 4 }}>
                Coords: {t.lat.toFixed(5)}°, {t.lon.toFixed(5)}°
              </div>
              <div style={{ marginTop: 4, fontSize: 11, color: "#475569" }}>
                Detected {ago(t.detectedAt)}
              </div>
            </div>
          </Popup>
        </Marker>
      ))}
    </MapContainer>
  );
}
