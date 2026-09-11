// Formatting helpers shared by all windows. Pure functions only.

const pad2 = (n) => String(n).padStart(2, "0");

/** 4523 s → "1:15:23"; 383 s → "06:23" */
export function fmtDuration(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds || 0));
  const hrs = Math.floor(s / 3600);
  const mins = Math.floor((s % 3600) / 60);
  const secs = s % 60;
  return hrs > 0 ? `${hrs}:${pad2(mins)}:${pad2(secs)}` : `${pad2(mins)}:${pad2(secs)}`;
}

/** Billed seconds → "12.4 min" */
export function fmtMinutes(seconds) {
  const m = (seconds || 0) / 60;
  return `${m < 10 ? m.toFixed(1) : Math.round(m)} min`;
}

/** Milliseconds → "412 ms" | "1.2 s" | "1:04" */
export function fmtMs(ms) {
  if (ms == null || Number.isNaN(ms)) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
  return fmtDuration(ms / 1000);
}

/** "+412 ms" style delta label */
export function fmtDelta(ms) {
  return ms == null ? "—" : `+${fmtMs(ms)}`;
}

/** Wall clock → "14:03:22" */
export function fmtTime(ts, withSeconds = true) {
  const d = new Date(ts);
  const base = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  return withSeconds ? `${base}:${pad2(d.getSeconds())}` : base;
}

/** Relative time, compact: "now", "12s", "3m", "2h", "yesterday", "Sep 3" */
export function fmtRelative(ts, now = Date.now()) {
  const diff = Math.max(0, now - ts);
  const s = Math.floor(diff / 1000);
  if (s < 5) return "now";
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const hrs = Math.floor(m / 60);
  if (hrs < 24) return `${hrs}h`;
  const days = Math.floor(hrs / 24);
  if (days === 1) return "yesterday";
  if (days < 7) return `${days}d`;
  const d = new Date(ts);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** "2026-09-10" → "Wed, Sep 10" (or "Today"/"Yesterday") */
export function fmtDay(dateString, now = new Date()) {
  const [y, m, d] = dateString.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const diffDays = Math.round((today - date) / 86_400_000);
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  return date.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

/** Middle-ellipsize a path, keeping the tail: "/Users/kevinliu/…/packages/shell" */
export function truncPath(path, max = 34) {
  if (!path) return "";
  let p = path.replace(/^\/Users\/[^/]+/, "~");
  if (p.length <= max) return p;
  const parts = p.split("/");
  let tail = parts.pop() ?? "";
  while (parts.length > 1 && tail.length + parts[parts.length - 1].length + 2 <= max - 3) {
    tail = `${parts.pop()}/${tail}`;
  }
  const head = parts[0] === "~" ? "~/" : "";
  const out = `${head}…/${tail}`;
  return out.length <= max ? out : `…${tail.slice(-(max - 1))}`;
}

/** Truncate text to n chars with an ellipsis */
export function truncate(text, n = 80) {
  if (!text) return "";
  return text.length <= n ? text : `${text.slice(0, n - 1).trimEnd()}…`;
}

/** Short id: "sess_7f3a9c2e…" → "7f3a9c2e" */
export function shortId(id, n = 8) {
  if (!id) return "—";
  const tail = id.split(/[:_-]/).pop() ?? id;
  return tail.length > n ? tail.slice(0, n) : tail;
}

/** JSON preview for tool inputs/outputs; strings are shown raw. */
export function previewJson(value, max = 600) {
  if (value == null) return "";
  let text;
  if (typeof value === "string") text = value;
  else {
    try {
      text = JSON.stringify(value, null, 2);
    } catch {
      text = String(value);
    }
  }
  return text.length > max ? `${text.slice(0, max)}\n…` : text;
}

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
