// views/live.js - the default view: every running run as a capture. With nothing
// running, the scope reads ARMED over the most recent run.

import { h, put } from "../dom.js";
import { createCapture } from "./run.js";

export function create(ctx) {
  const el = h("section", { class: "view view-live", "data-view": "live" });
  const armed = h("p", { class: "armed", role: "status" });
  const list = h("div", { class: "captures" });
  el.append(armed, list);
  const captures = new Map();

  function update() {
    const all = ctx.runList();
    const running = all.filter((r) => r.status === "running");
    const shown = running.length ? running : all.slice(0, 1);
    armed.hidden = running.length > 0;
    if (!running.length) {
      put(armed, h("span", { class: "armed-mark", "aria-hidden": "true" }), "ARMED - WAITING FOR TRIGGER",
        all.length ? h("span", { class: "armed-sub" }, "Showing the last run. A new /consensus or /ask-all appears here as it starts.") : null);
    }
    if (!all.length) {
      put(list, h("div", { class: "empty" },
        h("p", {}, "No runs recorded yet."),
        h("p", {}, "Start a /consensus or /ask-all in Claude Code. Each model becomes a channel on the scope below, its calls draw as pulses, and verdicts decode under them."),
        h("p", {}, "Runs are journaled only while dashboard.enabled is true in the deliberation config.")));
      captures.clear();
      return;
    }
    const full = shown.length === 1;
    for (const [id, cap] of captures) {
      if (!shown.some((r) => r.runId === id) || cap.full !== full) captures.delete(id);
    }
    const nodes = shown.map((r) => {
      let cap = captures.get(r.runId);
      if (!cap) {
        cap = { ...createCapture(ctx, r.runId, { full }), full };
        captures.set(r.runId, cap);
        ctx.ensureLoaded(r.runId);
      }
      cap.update(ctx.S.runs[r.runId]);
      return cap.el;
    });
    if (nodes.length !== list.children.length || nodes.some((n, i) => list.children[i] !== n)) put(list, ...nodes);
  }

  return {
    el,
    update,
    tick(now, redraw) {
      for (const cap of captures.values()) cap.tick(now, redraw);
    },
    runIds: () => [...captures.keys()],
  };
}
