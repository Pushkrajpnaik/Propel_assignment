import { useState, useCallback } from "react";

export async function apiFetcher<T = any>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!res.ok) {
    let text = "";
    try { text = await res.text(); } catch {}
    let msg = `HTTP ${res.status}`;
    try {
      const j = JSON.parse(text);
      if (j.reason || j.error) msg = j.reason || j.error;
    } catch {}
    throw new Error(msg);
  }
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) return res.json();
  return res.text() as any;
}

export function useToast() {
  const [toast, setToastState] = useState<string | null>(null);
  const [toastType, setToastType] = useState<"success" | "error">("success");
  const setToast = useCallback((msg: string, type: "success" | "error" = "success") => {
    setToastState(msg);
    setToastType(type);
    setTimeout(() => setToastState(null), 4500);
  }, []);
  return { toast, setToast, toastType };
}

export function confBucket(c: number): "high" | "medium" | "low" {
  if (c >= 0.8) return "high";
  if (c >= 0.55) return "medium";
  return "low";
}

export function ago(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const abs = Math.abs(ms);
  const s = Math.floor(abs / 1000);
  if (s < 60) return ms >= 0 ? `${s}s ago` : `in ${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return ms >= 0 ? `${m}m ago` : `in ${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return ms >= 0 ? `${h}h ago` : `in ${h}h`;
  const d = Math.floor(h / 24);
  return ms >= 0 ? `${d}d ago` : `in ${d}d`;
}

export function faultTypeLabel(t: string): string {
  if (t === "span") return "Span Fault";
  if (t === "dt") return "Transformer Fault";
  if (t === "feeder") return "Feeder Fault";
  if (t === "sensor_failure") return "Sensor Failure";
  return t;
}
