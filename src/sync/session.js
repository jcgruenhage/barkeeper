// Keeps the live Alpine data of the open space in step with its document.
//
// Local edits are written to the document shortly after they happen, as a
// change based on the heads the view was last built from, so that rows added
// remotely in the meantime are merged rather than deleted. Remote changes are
// merged back into the live data in place.

import { applyView, materialize, reconcile } from "./codec.js";

const FLUSH_DELAY_MS = 300;

export class SpaceSession {
  constructor(handle, toRaw) {
    this.handle = handle;
    this.toRaw = toRaw;
    this.keyOf = new WeakMap();
    this.data = null;
    this.heads = null;
    this.timer = null;
    this.lastJson = null;
    this.flushing = false;
    this.listeners = new Set();
  }

  /** The view to start the UI with. */
  initialView() {
    const view = materialize(this.handle.doc(), this.keyOf);
    this.heads = this.handle.heads();
    return view;
  }

  /** Start syncing `data`, the reactive object the UI mutates. */
  attach(data) {
    this.data = data;
    this.lastJson = JSON.stringify(this.toRaw(data));
    this.onChange = () => {
      if (this.flushing) return;
      if (this.timer) this.flush();
      else this.refresh();
    };
    this.handle.on("change", this.onChange);
    window.addEventListener("pagehide", () => this.flush());
  }

  /** Call whenever the data may have changed. `json` is its serialization. */
  touch(json) {
    if (json === this.lastJson) return;
    this.lastJson = json;
    // Not a debounce: continuous changes must not keep postponing the write.
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), FLUSH_DELAY_MS);
  }

  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    if (!this.data) return;
    this.flushing = true;
    try {
      this.handle.changeAt(this.heads, (d) =>
        applyView(d, this.toRaw(this.data), this.keyOf, this.toRaw),
      );
    } finally {
      this.flushing = false;
    }
    this.refresh();
  }

  refresh() {
    const doc = this.handle.doc();
    const fresh = materialize(doc, this.keyOf);
    reconcile(this.data, fresh, this.keyOf, this.toRaw);
    this.heads = this.handle.heads();
    for (const listener of this.listeners) listener(doc);
  }

  /** Be told about every change to the document, local or remote. */
  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Replace the whole space with `data`. Every record becomes a new row, so
   * edits other members make to the old records at the same time are lost.
   */
  replace(data) {
    this.flush();
    this.handle.change((d) => applyView(d, data, new WeakMap(), this.toRaw));
    this.refresh();
  }

  doc() {
    return this.handle.doc();
  }

  change(fn) {
    this.flush();
    this.handle.change(fn);
  }
}
