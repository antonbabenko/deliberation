// api.js - the dashboard server's read-only API, the SSE stream, and localStorage.
// localStorage holds preferences and a metadata-only run index; never run content.

const PREFIX = "dlb.";

export const store = {
  get(key, fallback) {
    try {
      const raw = window.localStorage.getItem(PREFIX + key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      window.localStorage.setItem(PREFIX + key, JSON.stringify(value));
    } catch {
      // private window, blocked storage, or quota: preferences are a convenience
    }
  },
};

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function getJSON(path) {
  let res;
  try {
    res = await fetch(path, { credentials: "same-origin", headers: { Accept: "application/json" } });
  } catch {
    throw new ApiError("the dashboard server did not answer", 0);
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError((body && body.error) || `HTTP ${res.status}`, res.status);
  return body;
}

const query = (filter) => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(filter || {})) if (v !== undefined && v !== null && v !== "") q.set(k, String(v));
  const s = q.toString();
  return s ? `?${s}` : "";
};

export const api = {
  runs: (filter) => getJSON(`/api/runs${query(filter)}`),
  run: (id) => getJSON(`/api/runs/${encodeURIComponent(id)}`),
  config: () => getJSON("/api/config"),
  health: () => getJSON("/api/health"),
  stats: (filter) => getJSON(`/api/stats${query(filter)}`),
};

/**
 * Subscribe to journal events. EventSource resumes with Last-Event-ID on its own.
 * @param {(event: object) => void} onEvent
 * @param {(link: "up"|"retry"|"down") => void} onLink
 * @returns {() => void} close
 */
export function openEvents(onEvent, onLink) {
  let es;
  try {
    es = new EventSource("/api/events");
  } catch {
    onLink("down");
    return () => {};
  }
  es.onopen = () => onLink("up");
  es.onerror = () => onLink(es.readyState === EventSource.CLOSED ? "down" : "retry");
  es.onmessage = (m) => {
    let event;
    try {
      event = JSON.parse(m.data);
    } catch {
      return;
    }
    if (event && typeof event === "object") onEvent(event);
  };
  return () => es.close();
}
