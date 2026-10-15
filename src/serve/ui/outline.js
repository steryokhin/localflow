// Local Flow — the Outline editor. Vanilla JS, no dependencies: one row per item, each row's text
// is a plain-text contenteditable, the structure lives in a small client model mirrored from
// GET /api/outline. Every change is applied to the model at once (so typing and moving feel
// instant) and sent as an operation by id to POST /api/outline/op; the server's answer replaces
// the model. Keys follow Bike / Workflowy: Enter new item, Tab / Shift-Tab indent with children,
// ⌥↑ / ⌥↓ move a branch, ⌘. fold, ⌘] / ⌘[ focus in / out; Esc or a mouse drag across items selects
// whole rows, and the bar over them (or the same keys) moves, folds or groups them.

(function () {
  "use strict";

  const LENS_KEY = "lf.outline.lens";
  const FOLDED_KEY = "lf.outline.folded";
  const CTX_OPEN_KEY = "lf.outline.ctx";
  const HOIST_KEY = "lf.outline.hoist";
  const SIZE_KEY = "lf.outline.size";
  // The fold arrow, drawn so that it is as big as the text in any font.
  const CHEVRON = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 6 8 10.5 12.5 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  const SIZES = [12, 13, 14, 15, 16, 17, 18, 20, 22, 24];
  const DEFAULT_SIZE = 15;
  // "· done 2026-10-15 14:30" at the end of a checked-off item: shown as a chip, not as text.
  const DONE_RE = /(^| · )(?:done|сделано) (\d{4}-\d{2}-\d{2})(?: \d{1,2}:\d{2})?(?= · |$)/i;
  const LENSES = [
    ["all", "All", "Everything"],
    ["active", "Active", "Open work: what is not done, with its parents"],
    ["today", "Today", "Loops due today or already late"],
    ["waiting", "Waiting", "Loops waiting on someone else"],
    ["expired", "Expired", "Loops past their deadline"],
    ["standup", "Standup", "Done since the last working day, mine due today, waiting on others"],
  ];
  const SAVE_DELAY = 500;
  const LETTERS = "abcdefghijkmnpqrstuvwxyz";
  const DIGITS = "23456789";
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const read = (key, fallback) => { try { const v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); } catch { return fallback; } };
  const write = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode */ } };
  const pad = (n) => String(n).padStart(2, "0");

  function newId(taken) {
    for (;;) {
      const b = crypto.getRandomValues(new Uint8Array(4));
      const id = LETTERS[b[0] % 24] + DIGITS[b[1] % 8] + LETTERS[b[2] % 24] + DIGITS[b[3] % 8];
      if (!taken.has(id)) return id;
    }
  }

  function fmtDue(due, atMs, now) {
    if (atMs === null) return due;
    const at = new Date(atMs);
    const dateOnly = !due.includes(" ");
    const same = at.toDateString() === now.toDateString();
    if (same) return dateOnly ? "today" : `${pad(at.getHours())}:${pad(at.getMinutes())}`;
    const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toDateString() === at.toDateString();
    const day = tomorrow ? "tomorrow" : `${at.getDate()} ${MONTHS[at.getMonth()]}`;
    return dateOnly ? day : `${day} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
  }

  function span(ms) {
    const m = Math.max(0, Math.round(ms / 60000));
    if (m < 60) return `${m}m`;
    if (m < 48 * 60) return `${Math.round(m / 60)}h`;
    return `${Math.round(m / 1440)}d`;
  }

  /** "2026-10-15 14:30" -> "today 14:30", "yesterday", "12 Oct", "12 Oct 2025". */
  function fmtDay(stamp, now) {
    const m = /^(\d{4})-(\d{2})-(\d{2})(?: (\d{1,2}):(\d{2}))?$/.exec(stamp);
    if (!m) return stamp;
    const at = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    const days = Math.round((new Date(now.getFullYear(), now.getMonth(), now.getDate()) - at) / 86400000);
    const time = m[4] !== undefined ? ` ${pad(Number(m[4]))}:${m[5]}` : "";
    if (days === 0) return `today${time}`;
    if (days === 1) return "yesterday";
    return `${at.getDate()} ${MONTHS[at.getMonth()]}${at.getFullYear() !== now.getFullYear() ? ` ${at.getFullYear()}` : ""}`;
  }

  const endOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999).getTime();

  // ---------- caret helpers (one text node per row) ----------

  function caretOf(el) {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount || !el.contains(sel.focusNode)) return null;
    const r = document.createRange();
    r.selectNodeContents(el);
    r.setEnd(sel.focusNode, sel.focusOffset);
    return r.toString().length;
  }

  function selectionIn(el) {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount || !el.contains(sel.anchorNode)) return null;
    const a = document.createRange();
    a.selectNodeContents(el);
    a.setEnd(sel.anchorNode, sel.anchorOffset);
    const start = a.toString().length;
    const end = caretOf(el);
    return { start: Math.min(start, end), end: Math.max(start, end) };
  }

  function setCaret(el, offset) {
    el.focus();
    const sel = window.getSelection();
    const r = document.createRange();
    let node = el.firstChild;
    if (!node) { r.setStart(el, 0); }
    else {
      const len = node.textContent.length;
      r.setStart(node, Math.max(0, Math.min(offset, len)));
    }
    r.collapse(true);
    sel.removeAllRanges();
    sel.addRange(r);
  }

  /** True when the caret sits on the first (or last) visual line of the element. */
  function caretOnEdgeLine(el, which) {
    const sel = window.getSelection();
    if (!sel.rangeCount) return true;
    const r = sel.getRangeAt(0).cloneRange();
    r.collapse(true);
    const rects = r.getClientRects();
    const box = el.getBoundingClientRect();
    if (!rects.length) return true;
    const line = parseFloat(getComputedStyle(el).lineHeight) || 20;
    return which === "up" ? rects[0].top - box.top < line * 0.8 : box.bottom - rects[0].bottom < line * 0.8;
  }

  // ---------- the editor ----------

  class Outline {
    constructor(root, deps) {
      this.root = root;
      this.api = deps.api;
      this.toast = deps.toast;
      this.go = deps.go;
      this.view = null;          // last server view
      this.sections = [];        // client model (sections with item trees)
      this.idx = new Map();      // id -> { node, parent, sec }
      this.lens = read(LENS_KEY, "all");
      this.query = "";
      this.folded = new Set(read(FOLDED_KEY, []));
      this.ctxOpen = new Set(read(CTX_OPEN_KEY, []));
      this.hoist = read(HOIST_KEY, null); // item id or section ref ("s:REF")
      this.size = SIZES.includes(read(SIZE_KEY, DEFAULT_SIZE)) ? read(SIZE_KEY, DEFAULT_SIZE) : DEFAULT_SIZE;
      this.focus = null;         // { id, offset }
      this.drafts = new Map();   // id -> text typed and not saved yet
      this.typedFrom = new Map(); // id -> text when this typing session began (for undo)
      this.typedOwn = new Map();  // id -> the server's own-content hash when typing began
      this.saveTimer = 0;
      this.queue = [];           // operation batches waiting to be sent
      this.inflight = false;
      this.undoStack = [];
      this.redoStack = [];
      this.sel = null;           // { anchor, head } ids of a row selection
      this.sticky = new Set();   // ids kept visible in a lens because they were just made or edited here
      this.flash = new Map();    // id -> "new" | "changed": changes from outside, highlighted for a while
      this.history = null;       // { mode: "item" | "key" | "days" | "day", ... } of the open history panel
      this.snapshot = null;      // { day, sections, events } when viewing a past day (read-only)
      this.menu = null;          // id of the row whose menu is open
      this.addingSection = false;
      this.drag = null;
      this.destroyed = false;
      this.status = "";
      this.build();
      this.load();
    }

    destroy() {
      this.destroyed = true;
      this.flushDrafts();
      document.removeEventListener("keydown", this.onDocKey, true);
      document.removeEventListener("mousemove", this.onDocMove);
      document.removeEventListener("mouseup", this.onDocUp);
    }

    // ---------- loading ----------

    async load() {
      try {
        const v = await this.api("GET", "/api/outline");
        this.adopt(v, { initial: true });
      } catch (err) {
        this.root.querySelector(".ol-body").innerHTML = `<div class="ol-empty">Cannot load the outline: ${esc(err.message)}</div>`;
      }
    }

    /** Called by the page on every change in the vault. */
    /** Something is being typed or chosen that a redraw would throw away. */
    busy() {
      const a = document.activeElement;
      const typingHere = a && this.root.contains(a) && (a.classList.contains("ol-htitle") || a.classList.contains("ol-ctxedit") || a.closest(".ol-secform"));
      return this.destroyed || this.inflight || this.queue.length || this.drafts.size || this.drag ||
        (this.ctxEdit !== null && this.ctxEdit !== undefined) || this.addingSection || this.menu || typingHere;
    }

    async refresh() {
      if (this.busy()) { this.pendingRefresh = true; return; }
      let v;
      try { v = await this.api("GET", "/api/outline"); } catch { return; }
      if (this.busy()) { this.pendingRefresh = true; return; }
      this.pendingRefresh = false;
      if (this.view && v.version === this.view.version) return;
      this.adopt(v, { external: true });
      if (this.history && this.history.mode !== "day") this.loadHistory();
    }

    /** Takes a server view as the model; with `external`, marks what changed since the last one. */
    adopt(v, opts = {}) {
      if (opts.external && this.view) {
        const before = new Map();
        const walk = (items) => { for (const it of items) { before.set(it.id, it.own); walk(it.children); } };
        for (const s of this.view.sections) walk(s.items);
        let n = 0;
        const mark = (items) => {
          for (const it of items) {
            if (!before.has(it.id)) { this.flash.set(it.id, "new"); n++; }
            else if (before.get(it.id) !== it.own) { this.flash.set(it.id, "changed"); n++; }
            mark(it.children);
          }
        };
        for (const s of v.sections) mark(s.items);
        if (n) {
          this.say(`${n} change${n === 1 ? "" : "s"} from outside`, "ext");
          clearTimeout(this.flashTimer);
          this.flashTimer = setTimeout(() => { this.flash.clear(); this.render(); }, 6000);
        }
      }
      this.view = v;
      this.sections = JSON.parse(JSON.stringify(v.sections));
      this.reindex();
      this.render();
      if (opts.initial && this.hoist && !this.hoistTarget()) { this.hoist = null; write(HOIST_KEY, null); this.render(); }
    }

    reindex() {
      this.idx = new Map();
      for (const sec of this.sections) {
        const walk = (items, parent) => {
          for (const node of items) {
            this.idx.set(node.id, { node, parent, sec });
            walk(node.children, node);
          }
        };
        walk(sec.items, null);
      }
    }

    siblingsOf(id) {
      const e = this.idx.get(id);
      return e.parent ? e.parent.children : e.sec.items;
    }

    depthOf(id) {
      let d = 0;
      for (let e = this.idx.get(id); e && e.parent; e = this.idx.get(e.parent.id)) d++;
      return d;
    }

    // ---------- operations: local first, then the server ----------

    /** Applies a batch to the client model; returns false when it cannot be applied here. */
    localApply(ops) {
      for (const op of ops) {
        const e = op.id ? this.idx.get(op.id) : null;
        switch (op.op) {
          case "text": if (e) e.node.text = op.text; break;
          case "check": if (e) e.node.check = op.check; break;
          case "context": if (e) e.node.context = op.context; break;
          case "insert": {
            const node = this.treeNode(op.item);
            const { list, index } = this.resolvePlace(op.place);
            list.splice(index, 0, node);
            break;
          }
          case "delete": {
            if (!e) break;
            const list = this.siblingsOf(op.id);
            list.splice(list.indexOf(e.node), 1);
            break;
          }
          case "move": {
            if (!e) break;
            const list = this.siblingsOf(op.id);
            list.splice(list.indexOf(e.node), 1);
            this.reindex();
            const { list: to, index } = this.resolvePlace(op.place);
            to.splice(index, 0, e.node);
            break;
          }
          default: break;
        }
        this.reindex();
      }
    }

    treeNode(t) {
      return { id: t.id, written: true, check: t.check, text: t.text, context: t.context || [], own: "", done: null, loop: null, children: (t.children || []).map((c) => this.treeNode(c)) };
    }

    resolvePlace(p) {
      if (p.after) {
        const e = this.idx.get(p.after);
        const list = e.parent ? e.parent.children : e.sec.items;
        return { list, index: list.indexOf(e.node) + 1 };
      }
      if (p.parent) {
        const list = this.idx.get(p.parent).node.children;
        return { list, index: p.index === undefined ? list.length : Math.min(p.index, list.length) };
      }
      const sec = this.sections.find((s) => s.ref === p.section);
      return { list: sec.items, index: p.index === undefined ? sec.items.length : Math.min(p.index, sec.items.length) };
    }

    /** A user action: applied now, sent in order, undoable. */
    act(ops, inverse, focus) {
      this.flushDrafts();
      this.localApply(ops);
      if (inverse) { this.undoStack.push({ ops, inverse }); this.redoStack = []; }
      for (const op of ops) if (op.id) this.sticky.add(op.id); else if (op.item) this.sticky.add(op.item.id);
      this.render(focus || undefined);
      this.send(ops);
    }

    send(ops) {
      this.queue.push(ops);
      this.pump();
    }

    async pump() {
      if (this.inflight || !this.queue.length) return;
      const ops = this.queue.shift();
      // Fill in what the server checks against: each item's own-content hash as last seen.
      for (const op of ops) {
        if (op.op === "context" && op.expect === undefined) {
          const own = this.serverOwn(op.id);
          if (own) op.expect = own;
        }
      }
      this.inflight = true;
      this.say("Saving…");
      try {
        const r = await this.api("POST", "/api/outline/op", { ops });
        this.inflight = false;
        if (this.destroyed) return;
        const remap = Object.entries(r.ids || {}).filter(([a, b]) => a !== b);
        if (remap.length) this.remapIds(Object.fromEntries(remap));
        if (!this.queue.length && !this.drafts.size) {
          this.view = r.view;
          this.sections = JSON.parse(JSON.stringify(r.view.sections));
          this.reindex();
          this.render();
        } else {
          this.view = r.view;
        }
        this.say(this.queue.length ? "Saving…" : "Saved");
        if (!this.queue.length && this.pendingRefresh) setTimeout(() => this.refresh(), 0);
      } catch (err) {
        this.inflight = false;
        this.queue = [];
        this.say("Not saved", "err");
        this.toast(err.status === 409 ? err.message : `Not saved: ${err.message}. Showing the outline as it is on disk.`);
        // Whatever went wrong, the page shows the file again: nothing on screen that is not saved.
        this.drafts.clear();
        this.typedFrom.clear();
        this.typedOwn.clear();
        this.undoStack = [];
        this.redoStack = [];
        await this.load();
      }
      this.pump();
    }

    serverOwn(id) {
      const find = (items) => {
        for (const it of items) {
          if (it.id === id) return it.own;
          const r = find(it.children);
          if (r) return r;
        }
        return null;
      };
      for (const s of this.view.sections) { const r = find(s.items); if (r) return r; }
      return null;
    }

    remapIds(map) {
      const fix = (op) => {
        for (const k of ["id", "after", "parent"]) if (op[k] && map[op[k]]) op[k] = map[op[k]];
        if (op.place) fix(op.place);
        if (op.item && map[op.item.id]) op.item.id = map[op.item.id];
      };
      for (const batch of this.queue) batch.forEach(fix);
      for (const u of [...this.undoStack, ...this.redoStack]) { u.ops.forEach(fix); u.inverse.forEach(fix); }
      if (this.focus && map[this.focus.id]) this.focus.id = map[this.focus.id];
    }

    undo() {
      this.flushDrafts();
      const u = this.undoStack.pop();
      if (!u) { this.say("Nothing to undo"); return; }
      this.redoStack.push(u);
      this.localApply(u.inverse);
      this.render();
      this.send(JSON.parse(JSON.stringify(u.inverse)));
    }

    redo() {
      const u = this.redoStack.pop();
      if (!u) { this.say("Nothing to redo"); return; }
      this.undoStack.push(u);
      this.localApply(u.ops);
      this.render();
      this.send(JSON.parse(JSON.stringify(u.ops)));
    }

    // ---------- typing ----------

    onInput(el) {
      const id = el.closest(".ol-row").dataset.id;
      const e = this.idx.get(id);
      if (!e) return;
      if (!this.typedFrom.has(id)) {
        this.typedFrom.set(id, e.node.text);
        // What the server had when typing began: a change made elsewhere since then is a conflict.
        this.typedOwn.set(id, this.serverOwn(id));
      }
      this.drafts.set(id, el.textContent);
      e.node.text = el.textContent;
      clearTimeout(this.saveTimer);
      this.saveTimer = setTimeout(() => this.flushDrafts(), SAVE_DELAY);
      this.say("Editing…");
    }

    flushDrafts() {
      clearTimeout(this.saveTimer);
      if (!this.drafts.size) return;
      const ops = [];
      const inverse = [];
      for (const [id, text] of this.drafts) {
        const was = this.typedFrom.get(id);
        if (was === undefined || was === text) continue;
        const own = this.typedOwn.get(id);
        ops.push(own ? { op: "text", id, text, expect: own } : { op: "text", id, text });
        inverse.push({ op: "text", id, text: was });
        this.sticky.add(id);
      }
      this.drafts.clear();
      this.typedFrom.clear();
      this.typedOwn.clear();
      if (!ops.length) return;
      this.undoStack.push({ ops, inverse: inverse.reverse() });
      this.redoStack = [];
      this.send(ops);
    }

    // ---------- structure ----------

    kindOf(node) { return node.check === null ? null : " "; }

    placeOf(id) {
      const e = this.idx.get(id);
      const list = this.siblingsOf(id);
      const i = list.indexOf(e.node);
      return e.parent ? { parent: e.parent.id, index: i } : { parent: null, section: e.sec.ref, index: i };
    }

    snapshotOf(node) {
      return { id: node.id, text: node.text, check: node.check, context: [...node.context], children: node.children.map((c) => this.snapshotOf(c)) };
    }

    taken() { return new Set(this.idx.keys()); }

    newItem(after, text, check, opts = {}) {
      const id = newId(this.taken());
      const item = { id, text, check, context: [] };
      const place = opts.place || { after };
      this.act([{ op: "insert", place, item }], [{ op: "delete", id }], { id, offset: opts.caret ?? 0 });
      return id;
    }

    moveTo(ids, placeFor) {
      const ops = [];
      const inverse = [];
      // Places are computed one by one on the model as it changes, and so are the ways back.
      this.flushDrafts();
      for (const id of ids) {
        const back = { op: "move", id, place: this.placeOf(id) };
        const place = placeFor(id);
        if (!place) continue;
        const op = { op: "move", id, place };
        ops.push(op);
        inverse.unshift(back);
        this.localApply([op]);
      }
      if (!ops.length) return;
      this.undoStack.push({ ops, inverse });
      this.redoStack = [];
      for (const op of ops) this.sticky.add(op.id);
      this.render();
      this.send(ops);
    }

    indent(ids) {
      this.moveTo(ids, (id) => {
        const list = this.siblingsOf(id);
        const i = list.indexOf(this.idx.get(id).node);
        if (i <= 0) return null;
        const prev = list[i - 1];
        this.folded.delete(prev.id);
        return { parent: prev.id };
      });
    }

    outdent(ids) {
      this.moveTo([...ids].reverse(), (id) => {
        const e = this.idx.get(id);
        if (!e.parent) return null;
        return { after: e.parent.id };
      });
    }

    shift(ids, dir) {
      const order = dir < 0 ? ids : [...ids].reverse();
      this.moveTo(order, (id) => {
        const e = this.idx.get(id);
        const list = this.siblingsOf(id);
        const i = list.indexOf(e.node);
        if (dir < 0) {
          if (i > 0) return e.parent ? { parent: e.parent.id, index: i - 1 } : { parent: null, section: e.sec.ref, index: i - 1 };
          if (e.parent) {
            const pe = this.idx.get(e.parent.id);
            const plist = this.siblingsOf(e.parent.id);
            const pi = plist.indexOf(e.parent);
            if (pi > 0) { const into = plist[pi - 1]; this.folded.delete(into.id); return { parent: into.id }; }
            return pe.parent ? { parent: pe.parent.id, index: pi } : { parent: null, section: pe.sec.ref, index: pi };
          }
          const si = this.sections.indexOf(e.sec);
          if (si > 0) return { parent: null, section: this.sections[si - 1].ref };
          return null;
        }
        if (i < list.length - 1) return e.parent ? { parent: e.parent.id, index: i + 1 } : { parent: null, section: e.sec.ref, index: i + 1 };
        if (e.parent) {
          const pe = this.idx.get(e.parent.id);
          const plist = this.siblingsOf(e.parent.id);
          const pi = plist.indexOf(e.parent);
          if (pi < plist.length - 1) { const into = plist[pi + 1]; this.folded.delete(into.id); return { parent: into.id, index: 0 }; }
          return pe.parent ? { parent: pe.parent.id, index: pi + 1 } : { parent: null, section: pe.sec.ref, index: pi + 1 };
        }
        const si = this.sections.indexOf(e.sec);
        if (si < this.sections.length - 1) return { parent: null, section: this.sections[si + 1].ref, index: 0 };
        return null;
      });
    }

    remove(ids, focusAfter) {
      const tops = ids.filter((id) => !ids.some((o) => o !== id && this.isUnder(id, o)));
      const inverse = [];
      const ops = [];
      // Put back in document order at their old places: each one's place counts the ones before it.
      const ordered = this.visibleIds().filter((id) => tops.includes(id));
      for (const id of tops) if (!ordered.includes(id)) ordered.push(id);
      for (const id of ordered) {
        inverse.push({ op: "insert", place: this.placeOf(id), item: this.snapshotOf(this.idx.get(id).node) });
        ops.push({ op: "delete", id });
      }
      this.sel = null;
      this.act(ops, inverse, focusAfter);
    }

    isUnder(id, ancestor) {
      for (let e = this.idx.get(id); e && e.parent; e = this.idx.get(e.parent.id)) if (e.parent.id === ancestor) return true;
      return false;
    }

    toggleCheck(ids) {
      const ops = [];
      const inverse = [];
      for (const id of ids) {
        const n = this.idx.get(id).node;
        const next = n.check === "x" ? " " : n.check === " " ? "x" : " ";
        ops.push({ op: "check", id, check: next });
        inverse.unshift({ op: "check", id, check: n.check });
      }
      this.act(ops, inverse, this.focus);
    }

    setKind(id, check) {
      const n = this.idx.get(id).node;
      if (n.check === check) return;
      this.act([{ op: "check", id, check }], [{ op: "check", id, check: n.check }], this.focus);
    }

    // ---------- what is shown ----------

    hoistTarget() {
      if (!this.hoist) return null;
      if (this.hoist.startsWith("s:")) {
        const sec = this.sections.find((s) => s.ref === this.hoist.slice(2));
        return sec ? { sec } : null;
      }
      const e = this.idx.get(this.hoist);
      return e ? { item: e.node, sec: e.sec } : null;
    }

    lensMatch(node) {
      const l = node.loop;
      const open = node.check === " ";
      const now = new Date();
      const at = l && l.dueAt !== null ? l.dueAt : Infinity;
      switch (this.lens) {
        case "all": return true;
        case "active": return node.check !== "x";
        case "today": return open && !!l && at <= endOfDay(now);
        case "waiting": return open && !!l && l.owner !== "me";
        case "expired": return open && !!l && at <= now.getTime();
        case "standup": return (this.view.checkedSince || []).includes(node.id) || (open && !!l && ((l.owner === "me" && at <= endOfDay(now)) || l.owner !== "me"));
        default: return true;
      }
    }

    /** Ids shown under the current lens and filter; null when everything is. */
    visible() {
      const q = this.query.trim().toLowerCase();
      if (this.lens === "all" && !q) return null;
      const show = new Set();
      for (const sec of this.sections) {
        if (this.lens === "active" && sec.closed) continue;
        const walk = (items, chain, doneAbove) => {
          for (const n of items) {
            const done = doneAbove || n.check === "x";
            const lensOk = this.lens === "active" ? !done : this.lensMatch(n);
            const textOk = !q || `${n.text}\n${n.context.join("\n")}`.toLowerCase().includes(q);
            if ((lensOk && textOk) || this.sticky.has(n.id)) { show.add(n.id); for (const c of chain) show.add(c); }
            walk(n.children, [...chain, n.id], done);
          }
        };
        walk(sec.items, [], false);
      }
      return show;
    }

    counts() {
      const out = {};
      const save = [this.lens, this.query, this.sticky];
      this.query = "";
      this.sticky = new Set();
      for (const [lens] of LENSES) {
        if (lens === "all") continue;
        this.lens = lens;
        let n = 0;
        for (const sec of this.sections) {
          if (lens === "active" && sec.closed) continue;
          const walk = (items, doneAbove) => {
            for (const it of items) {
              const done = doneAbove || it.check === "x";
              if (lens === "active" ? !done && it.check === " " : this.lensMatch(it)) n++;
              walk(it.children, done);
            }
          };
          walk(sec.items, false);
        }
        out[lens] = n;
      }
      [this.lens, this.query, this.sticky] = save;
      return out;
    }

    /** Rows in display order: { node, depth, sec } plus section heads, honouring folds, hoist and lens. */
    rows() {
      const vis = this.visible();
      const out = [];
      const target = this.hoistTarget();
      const walk = (items, depth, sec) => {
        for (const node of items) {
          if (vis && !vis.has(node.id)) continue;
          out.push({ node, depth, sec });
          const folded = this.folded.has(node.id) && !(vis && this.query);
          if (!folded) walk(node.children, depth + 1, sec);
        }
      };
      if (target && target.item) {
        walk(target.item.children, 0, target.sec);
        return out;
      }
      for (const sec of target ? [target.sec] : this.sections) {
        const secShown = !vis || sec.items.some(function any(n) { return vis.has(n.id) || n.children.some(any); }) || (this.lens === "all" && !this.query) ||
          (this.lens === "active" && !this.query && !sec.closed && !sec.items.length);
        if (!secShown) continue;
        out.push({ head: sec });
        if (!this.folded.has("s:" + sec.ref) || target) walk(sec.items, 0, sec);
      }
      return out;
    }

    // ---------- rendering ----------

    build() {
      this.root.innerHTML = `<div class="ol-page">` +
        `<div class="ol-bar"><div class="ol-lenses" role="tablist"></div>` +
        `<input class="ol-q" type="search" placeholder="Filter…" spellcheck="false" autocomplete="off" aria-label="Filter the outline">` +
        `<span class="ol-status" aria-live="polite"></span>` +
        `<span class="ol-size" title="Text size"><button data-fs="-1" aria-label="Smaller text">A−</button><button data-fs="0" title="Back to ${DEFAULT_SIZE}px"></button><button data-fs="1" aria-label="Larger text">A+</button></span>` +
        `<button class="btn ghost ol-histbtn" title="History: the outline day by day (⌥H)">History</button>` +
        `<button class="btn ghost ol-help" title="How to use the outline: keys and mouse">? Help</button></div>` +
        `<div class="ol-wrap"><div class="ol-scroll"><div class="ol-crumbs"></div><div class="ol-body" tabindex="-1"></div>` +
        `<div class="ol-foot"></div></div><aside class="ol-hist" hidden></aside></div>` +
        `<div class="ol-drop" hidden></div><div class="ol-seltools" hidden></div><div class="ol-keys" hidden></div></div>`;
      const body = this.root.querySelector(".ol-body");
      this.body = body;
      this.root.querySelector(".ol-q").addEventListener("input", (e) => { this.query = e.target.value; this.sticky.clear(); this.render(); });
      this.root.querySelector(".ol-q").addEventListener("keydown", (e) => {
        if (e.key === "Escape") { e.target.value = ""; this.query = ""; this.render(); this.body.focus(); }
        if (e.key === "ArrowDown" || e.key === "Enter") { e.preventDefault(); const first = this.body.querySelector(".ol-row .ol-text"); if (first) setCaret(first, 0); }
      });
      this.root.querySelector(".ol-histbtn").addEventListener("click", () => this.toggleHistory());
      this.root.querySelector(".ol-scroll").addEventListener("scroll", () => { if (this.sel) this.paintTools(); }, { passive: true });
      this.root.querySelector(".ol-help").addEventListener("click", () => this.toggleKeys());
      this.root.querySelectorAll("[data-fs]").forEach((b) => b.addEventListener("click", () => this.setSize(Number(b.dataset.fs))));
      this.applySize();

      body.addEventListener("input", (e) => { if (e.target.classList.contains("ol-text")) this.onInput(e.target); });
      body.addEventListener("keydown", (e) => this.onKey(e));
      body.addEventListener("focusin", (e) => this.onFocusIn(e));
      body.addEventListener("focusout", (e) => this.onFocusOut(e));
      body.addEventListener("click", (e) => this.onClick(e));
      body.addEventListener("dblclick", (e) => { const h = e.target.closest(".ol-grip"); if (h) this.hoistTo(h.closest(".ol-row").dataset.id); });
      body.addEventListener("paste", (e) => this.onPaste(e));
      body.addEventListener("copy", (e) => this.onCopy(e));
      body.addEventListener("cut", (e) => { if (this.sel) { this.onCopy(e); this.remove(this.selectedIds()); } });
      body.addEventListener("contextmenu", (e) => { const row = e.target.closest(".ol-row"); if (row && e.target.closest(".ol-grip")) { e.preventDefault(); if (this.menu !== row.dataset.id) this.openMenu(row.dataset.id); } });
      body.addEventListener("dragstart", (e) => this.onDragStart(e));
      body.addEventListener("dragover", (e) => this.onDragOver(e));
      body.addEventListener("drop", (e) => this.onDrop(e));
      body.addEventListener("dragend", () => this.endDrag());
      // Pressing in one item and moving the mouse into another selects whole items (as in Bike / Workflowy).
      body.addEventListener("mousedown", (e) => this.onPress(e));
      this.onDocMove = (e) => this.onPressMove(e);
      this.onDocUp = () => this.onPressEnd();
      document.addEventListener("mousemove", this.onDocMove);
      document.addEventListener("mouseup", this.onDocUp);
      const tools = this.root.querySelector(".ol-seltools");
      tools.addEventListener("mousedown", (e) => e.preventDefault()); // keep the selection
      tools.addEventListener("click", (e) => { const b = e.target.closest("[data-st]"); if (b) this.selTool(b.dataset.st); });
      this.onDocKey = (e) => {
        if (this.destroyed) return;
        const keys = this.root.querySelector(".ol-keys");
        if (e.key === "Escape" && !keys.hidden) { e.preventDefault(); e.stopPropagation(); keys.hidden = true; return; }
        const mod = e.metaKey || e.ctrlKey;
        if (this.body.contains(e.target)) {
          if (e.altKey && e.code === "KeyH") { e.preventDefault(); this.toggleHistory(); }
          return;
        }
        if (e.altKey && e.code === "KeyH") { e.preventDefault(); this.toggleHistory(); }
        if (mod && !e.shiftKey && e.key.toLowerCase() === "z" && !this.inField(e.target)) { e.preventDefault(); this.undo(); }
        if (mod && e.shiftKey && e.key.toLowerCase() === "z" && !this.inField(e.target)) { e.preventDefault(); this.redo(); }
      };
      document.addEventListener("keydown", this.onDocKey, true);
    }

    inField(t) {
      return t && (t.classList?.contains("ol-q") || t.tagName === "TEXTAREA" || (t.tagName === "INPUT" && !t.classList.contains("ol-text")));
    }

    say(text, kind) {
      const el = this.root.querySelector(".ol-status");
      if (!el) return;
      el.textContent = text;
      el.className = "ol-status" + (kind ? " " + kind : "");
      clearTimeout(this.sayTimer);
      if (text === "Saved" || kind === "ext") this.sayTimer = setTimeout(() => { el.textContent = ""; }, 2500);
    }

    /** One step smaller (-1) or larger (1), or back to the default (0). */
    setSize(step) {
      const i = SIZES.indexOf(this.size);
      this.size = step === 0 ? DEFAULT_SIZE : SIZES[Math.max(0, Math.min(SIZES.length - 1, i + step))];
      write(SIZE_KEY, this.size);
      this.applySize();
    }

    applySize() {
      this.root.querySelector(".ol-page").style.setProperty("--k", String(this.size / DEFAULT_SIZE));
      this.root.querySelector('[data-fs="0"]').textContent = `${this.size}px`;
    }

    /** Redraws everything; the caret goes to `focusTo` or stays where it was. */
    render(focusTo) {
      if (this.destroyed) return;
      const counts = this.counts();
      this.root.querySelector(".ol-lenses").innerHTML = LENSES.map(([id, label, title]) =>
        `<button role="tab" class="${this.lens === id ? "on" : ""}" data-lens="${id}" title="${esc(title)}">${label}${id !== "all" ? `<span>${counts[id] || 0}</span>` : ""}</button>`).join("");
      this.root.querySelectorAll("[data-lens]").forEach((b) => b.addEventListener("click", () => this.setLens(b.dataset.lens)));

      if (this.snapshot) return this.renderSnapshot();
      const active = document.activeElement;
      const editing = active && active.classList && active.classList.contains("ol-text") && this.body.contains(active);
      const keepFocus = focusTo || (editing ? { id: active.closest(".ol-row").dataset.id, offset: caretOf(active) ?? 0 } : this.focus);

      this.renderCrumbs();
      const rows = this.rows();
      const now = new Date();
      let h = "";
      const target = this.hoistTarget();
      if (target && target.item) {
        h += this.rowHtml({ node: target.item, depth: 0, sec: target.sec }, now, { title: true });
      }
      for (const r of rows) h += r.head ? this.headHtml(r.head) : this.rowHtml(r, now, { offset: target && target.item ? 1 : 0 });
      if (!this.sections.length) {
        h = `<div class="ol-empty"><p>The outline is empty.</p><p>Add a section for a ticket below, or bring your open loops and their closed steps in from loops.md.</p>` +
          `<button class="btn" data-migrate>Bring loops.md in</button></div>`;
      } else if (target && target.item && !target.item.children.length) {
        h += `<div class="ol-none">Nothing under it yet: ↵ at the end of the title adds the first step.</div>`;
      } else if (!rows.length && !(target && target.item)) {
        h += `<div class="ol-none">Nothing here${this.query ? ` matching “${esc(this.query)}”` : ` in ${esc(this.lens)}`}.</div>`;
      }
      this.body.innerHTML = h;
      this.renderFoot();
      this.paintSelection();
      if (keepFocus && !this.sel) {
        const el = this.body.querySelector(`.ol-row[data-id="${CSS.escape(keepFocus.id)}"] .ol-text`);
        if (el) {
          this.focus = keepFocus;
          if (el.textContent !== this.rawText(keepFocus.id)) el.textContent = this.rawText(keepFocus.id);
          setCaret(el, keepFocus.offset);
          el.closest(".ol-row").classList.add("editing");
        }
      }
    }

    rawText(id) {
      const e = this.idx.get(id);
      return this.drafts.get(id) ?? (e ? e.node.text : "");
    }

    renderCrumbs() {
      const el = this.root.querySelector(".ol-crumbs");
      const target = this.hoistTarget();
      if (!target) { el.innerHTML = ""; el.hidden = true; return; }
      el.hidden = false;
      const parts = [`<button data-hoist="">Outline</button>`];
      parts.push(`<button data-hoist="s:${esc(target.sec.ref)}">${esc(target.sec.key || target.sec.title)}</button>`);
      if (target.item) {
        const chain = [];
        for (let e = this.idx.get(target.item.id); e && e.parent; e = this.idx.get(e.parent.id)) chain.unshift(e.parent);
        for (const n of chain) parts.push(`<button data-hoist="${esc(n.id)}">${esc(this.display(n).text || "…")}</button>`);
      }
      el.innerHTML = parts.join(`<span>›</span>`);
      el.querySelectorAll("[data-hoist]").forEach((b) => b.addEventListener("click", () => this.hoistTo(b.dataset.hoist || null)));
    }

    renderFoot() {
      const foot = this.root.querySelector(".ol-foot");
      if (this.snapshot) { foot.innerHTML = ""; return; }
      const tickets = (this.view && this.view.tickets) || [];
      if (this.hoistTarget()) { foot.innerHTML = ""; return; }
      if (!this.addingSection) {
        foot.innerHTML = `<button class="ol-add" data-addsec>+ Section</button>`;
      } else {
        foot.innerHTML = `<div class="ol-secform"><select class="ol-tk"><option value="">Ticket…</option>` +
          tickets.map((t) => `<option value="${esc(t.key)}">${esc(t.key)} · ${esc(t.title)}</option>`).join("") +
          `</select><span>or</span><input class="ol-sectitle" placeholder="a title without a ticket" spellcheck="false">` +
          `<button class="btn" data-secok>Add</button><button class="btn ghost" data-seccancel>Cancel</button></div>`;
        const sel = foot.querySelector(".ol-tk");
        const title = foot.querySelector(".ol-sectitle");
        const ok = () => {
          const key = sel.value;
          const t = title.value.trim();
          if (!key && !t) { sel.focus(); return; }
          this.addingSection = false;
          this.sendSection(key ? { op: "section", key } : { op: "section", title: t });
        };
        foot.querySelector("[data-secok]").addEventListener("click", ok);
        title.addEventListener("keydown", (e) => { if (e.key === "Enter") ok(); if (e.key === "Escape") { this.addingSection = false; this.renderFoot(); } });
        sel.addEventListener("change", () => { if (sel.value) ok(); });
        foot.querySelector("[data-seccancel]").addEventListener("click", () => { this.addingSection = false; this.renderFoot(); });
        sel.focus();
      }
      const add = foot.querySelector("[data-addsec]");
      if (add) add.addEventListener("click", () => { this.addingSection = true; this.renderFoot(); });
    }

    async sendSection(op) {
      this.flushDrafts();
      try {
        const r = await this.api("POST", "/api/outline/op", { ops: [op] });
        this.adopt(r.view);
        const sec = r.view.sections[r.view.sections.length - 1];
        if (sec && !sec.items.length) this.newItem(null, "", " ", { place: { parent: null, section: sec.ref } });
      } catch (err) { this.toast(err.message); this.renderFoot(); }
    }

    display(node) {
      const l = node.loop;
      if (!l) return { text: node.text.replace(DONE_RE, ""), loop: null };
      const tagged = l.tag && node.text.startsWith(`#${l.tag} `);
      return { text: (tagged ? `#${l.tag} ` : "") + l.text, loop: l };
    }

    headHtml(sec) {
      const folded = this.folded.has("s:" + sec.ref);
      const t = sec.ticket;
      const st = t ? `<span class="ol-st ${esc(t.status)}">${esc(t.status)}</span>` : "";
      const key = sec.key ? `<a class="ol-key" href="#/t/${esc(sec.key)}" title="Open ${esc(sec.key)}">${esc(sec.key)}</a>` : "";
      return `<div class="ol-head${sec.closed ? " closed" : ""}" data-sec="${esc(sec.ref)}">` +
        `<button class="ol-fold${folded ? " folded" : ""}" data-foldsec="${esc(sec.ref)}" aria-label="Fold">${CHEVRON}</button>${key}` +
        `<span class="ol-htitle" contenteditable="plaintext-only" spellcheck="false" data-sectitle="${esc(sec.ref)}">${esc(sec.title)}</span>${st}` +
        `<span class="ol-hacts"><button data-secadd="${esc(sec.ref)}" title="New item">+</button>` +
        `<button data-sechist="${esc(sec.key || "")}" title="History of this ticket"${sec.key ? "" : " hidden"}>⟲</button>` +
        `<button data-secdone="${esc(sec.ref)}" title="${sec.closed ? "Reopen" : "Mark the ticket's part done"}">✓</button>` +
        `<button data-sechoist="${esc(sec.ref)}" title="Focus on this section">⤢</button></span></div>`;
    }

    rowHtml(r, now, opts = {}) {
      const n = r.node;
      const depth = r.depth + (opts.offset || 0);
      const d = this.display(n);
      const l = d.loop;
      const hasKids = n.children.length > 0;
      const folded = this.folded.has(n.id);
      const cls = ["ol-row"];
      if (n.check === "x") cls.push("done");
      if (n.check === null) cls.push("note");
      if (opts.title) cls.push("ol-title");
      const flash = this.flash.get(n.id);
      if (flash) cls.push("flash-" + flash);
      let state = "";
      if (l && n.check === " " && l.dueAt !== null) {
        if (l.dueAt <= now.getTime()) { state = "late"; cls.push("late"); }
        else if (l.dueAt <= endOfDay(now)) state = "today";
      }
      const box = n.check === null
        ? `<span class="ol-bul" data-bullet title="Click: focus on it">•</span>`
        : `<button class="ol-box${n.check === "x" ? " on" : ""}" data-check aria-label="${n.check === "x" ? "Done" : "Open"}" tabindex="-1"></button>`;
      let chips = "";
      if (l) {
        if (l.owner !== "me") chips += `<span class="ol-chip who" title="Waiting on ${esc(l.owner)}">${esc(l.owner)}</span>`;
        if (l.due) {
          const late = state === "late" ? ` · ${span(now.getTime() - l.dueAt)} late` : "";
          chips += `<span class="ol-chip due ${state}" title="Deadline ${esc(l.due)}">${n.check === "x" ? "was due " : ""}${esc(fmtDue(l.due, l.dueAt, now))}${late}</span>`;
        }
        if (l.onExpiry && n.check === " ") chips += `<span class="ol-chip else" title="If it passes">else: ${esc(l.onExpiry)}</span>`;
      }
      if (n.check === "x" && n.done) chips += `<span class="ol-chip closed" title="Checked off ${esc(n.done)}">✓ ${esc(fmtDay(n.done, now))}</span>`;
      if (n.context.length) {
        const open = this.ctxOpen.has(n.id);
        chips += `<button class="ol-chip ctx${open ? " on" : ""}" data-ctx title="${open ? "Hide" : "Show"} the note (⇧↵ to edit)">¶${n.context.length > 1 ? " " + n.context.length : ""}</button>`;
      }
      if (hasKids && folded) chips += `<span class="ol-chip kids" data-unfold>${countAll(n)} inside</span>`;
      const ctx = n.context.length && this.ctxOpen.has(n.id) ? `<div class="ol-ctxt">${n.context.map((c) => `<div>${linkify(c) || "&nbsp;"}</div>`).join("")}</div>` : "";
      const editing = this.ctxEdit === n.id ? `<textarea class="ol-ctxedit" rows="${Math.max(2, n.context.length + 1)}" placeholder="A note under this item: context, links, quotes. ⌘↵ or Esc to finish.">${esc(n.context.join("\n"))}</textarea>` : "";
      const text = this.focus && this.focus.id === n.id ? this.rawText(n.id) : d.text;
      return `<div class="${cls.join(" ")}" data-id="${esc(n.id)}" style="--d:${depth}">` +
        `<span class="ol-grip" draggable="true" title="Drag to move · click to select · double-click to focus · right-click for more">⋮⋮</span>` +
        `<button class="ol-fold${hasKids ? "" : " none"}${folded ? " folded" : ""}" data-fold tabindex="-1" aria-label="Fold">${CHEVRON}</button>${box}` +
        `<div class="ol-main"><div class="ol-line"><div class="ol-text" contenteditable="plaintext-only" spellcheck="false" data-ph="${n.check === null ? "Note" : "To do"}">${esc(text)}</div>` +
        (chips ? `<span class="ol-chips">${chips}</span>` : "") + `</div>${ctx}${editing}</div>` +
        (this.menu === n.id ? this.menuHtml(n) : "") + `</div>`;
    }

    menuHtml(n) {
      return `<div class="ol-menu" role="menu">` +
        `<button data-mmove="in">Shift right: under the item above <kbd>Tab</kbd></button>` +
        `<button data-mmove="out">Shift left: one level out <kbd>⇧Tab</kbd></button>` +
        `<button data-mmove="up">Move up <kbd>⌥↑</kbd></button>` +
        `<button data-mmove="down">Move down <kbd>⌥↓</kbd></button>` +
        `<hr>` +
        (n.check === null ? `<button data-mk="task">Make it a task</button>` : `<button data-mk="note">Make it a note (no checkbox)</button>`) +
        `<button data-mctx>${n.context.length ? "Edit the note" : "Add a note"} <kbd>⇧↵</kbd></button>` +
        `<button data-mhoist>Focus on it <kbd>⌘]</kbd></button>` +
        `<button data-mhist>History <kbd>⌥H</kbd></button>` +
        `<button data-mcopy>Copy id ^${esc(n.id)}</button>` +
        `<button data-mdel class="del">Delete with what is under it</button></div>`;
    }

    // ---------- events ----------

    rowOf(el) { const r = el.closest(".ol-row"); return r ? r.dataset.id : null; }

    textEl(id) { return this.body.querySelector(`.ol-row[data-id="${CSS.escape(id)}"] .ol-text`); }

    onFocusIn(e) {
      const t = e.target;
      if (t.classList.contains("ol-text")) {
        const id = this.rowOf(t);
        const row = t.closest(".ol-row");
        row.classList.add("editing");
        if (this.sel) { this.sel = null; this.paintSelection(); }
        const raw = this.rawText(id);
        if (t.textContent !== raw) {
          // The row showed the loop's short text; edit the full line with its fields.
          requestAnimationFrame(() => {
            if (document.activeElement !== t) return; // left already (a drag across items)
            const off = caretOf(t);
            t.textContent = raw;
            setCaret(t, off === null ? raw.length : off);
          });
        }
        this.focus = { id, offset: caretOf(t) ?? 0 };
      }
    }

    onFocusOut(e) {
      const t = e.target;
      if (t.classList.contains("ol-text")) {
        const row = t.closest(".ol-row");
        row.classList.remove("editing");
        const id = this.rowOf(t);
        this.flushDrafts();
        setTimeout(() => {
          if (this.destroyed) return;
          const a = document.activeElement;
          if (!a || !a.classList || !a.classList.contains("ol-text")) {
            this.focus = null;
            // Show the short form of a loop again.
            const e2 = this.idx.get(id);
            const el = this.textEl(id);
            if (e2 && el && document.activeElement !== el) el.textContent = this.display(e2.node).text;
          }
        }, 0);
      }
      if (t.classList.contains("ol-htitle")) {
        const ref = t.dataset.sectitle;
        const sec = this.sections.find((s) => s.ref === ref);
        const title = t.textContent.trim();
        if (sec && !sec.key && !title) { t.textContent = sec.title; this.toast("A section without a ticket needs a title."); }
        else if (sec && title !== sec.title) {
          const old = sec.title;
          // A free section is known by its title, so its ref changes with it.
          const newRef = sec.key ? ref : "#" + title;
          sec.title = title;
          sec.ref = newRef;
          this.undoStack.push({ ops: [{ op: "sectionSet", section: ref, title }], inverse: [{ op: "sectionSet", section: newRef, title: old }] });
          this.redoStack = [];
          this.send([{ op: "sectionSet", section: ref, title }]);
        }
      }
      if (t.classList.contains("ol-ctxedit")) this.finishContext(t);
    }

    onClick(e) {
      const t = e.target;
      if (this.snapshot) return;
      if (t.closest("[data-migrate]")) return this.migrate();
      const row = t.closest(".ol-row");
      const head = t.closest(".ol-head");
      if (head) {
        const ref = head.dataset.sec;
        if (t.closest("[data-foldsec]")) return this.toggleFold("s:" + ref);
        if (t.closest("[data-secadd]")) {
          const sec = this.sections.find((s) => s.ref === ref);
          this.folded.delete("s:" + ref);
          return this.newItem(null, "", " ", { place: { parent: null, section: ref, index: sec.items.length } });
        }
        if (t.closest("[data-sechist]")) return this.openHistory({ mode: "key", key: t.closest("[data-sechist]").dataset.sechist });
        if (t.closest("[data-sechoist]")) return this.hoistTo("s:" + ref);
        if (t.closest("[data-secdone]")) {
          const sec = this.sections.find((s) => s.ref === ref);
          sec.closed = !sec.closed;
          const op = { op: "sectionSet", section: ref, closed: sec.closed };
          this.undoStack.push({ ops: [op], inverse: [{ op: "sectionSet", section: ref, closed: !sec.closed }] });
          this.render();
          return this.send([op]);
        }
        return;
      }
      if (!row) {
        if (this.menu) { this.menu = null; this.render(); }
        return;
      }
      const id = row.dataset.id;
      if (t.closest(".ol-menu")) return this.onMenu(t, id);
      if (this.menu) { this.menu = null; this.render(); }
      if (this.sel && !e.shiftKey && row.classList.contains("sel") && !t.closest("button, .ol-grip, .ol-chips")) {
        this.sel = null;
        this.paintSelection();
        return this.focusRow(id, "end");
      }
      if (t.closest("[data-check]")) { e.preventDefault(); return this.toggleCheck([id]); }
      if (t.closest("[data-fold]") || t.closest("[data-unfold]")) return this.toggleFold(id);
      if (t.closest("[data-bullet]")) return this.hoistTo(id);
      if (t.closest("[data-ctx]")) {
        if (this.ctxOpen.has(id)) this.ctxOpen.delete(id); else this.ctxOpen.add(id);
        write(CTX_OPEN_KEY, [...this.ctxOpen]);
        return this.render();
      }
      if (t.closest(".ol-grip")) {
        if (e.shiftKey && this.sel) this.sel.head = id;
        else this.sel = { anchor: id, head: id };
        document.activeElement && document.activeElement.blur && document.activeElement.blur();
        this.body.focus();
        return this.paintSelection();
      }
      if (t.closest(".ol-ctxt")) {
        if (t.tagName === "A") return;
        return this.editContext(id);
      }
      if (!t.closest(".ol-text") && !t.closest(".ol-chips") && !t.closest("textarea")) {
        const el = this.textEl(id);
        if (el) setCaret(el, el.textContent.length);
      }
    }

    onMenu(t, id) {
      this.menu = null;
      const mv = t.closest("[data-mmove]");
      if (mv) {
        const how = mv.dataset.mmove;
        if (how === "in") return this.indent([id]);
        if (how === "out") return this.outdent([id]);
        return this.shift([id], how === "up" ? -1 : 1);
      }
      if (t.closest("[data-mk]")) return this.setKind(id, t.closest("[data-mk]").dataset.mk === "task" ? " " : null);
      if (t.closest("[data-mctx]")) return this.editContext(id);
      if (t.closest("[data-mhoist]")) return this.hoistTo(id);
      if (t.closest("[data-mhist]")) return this.openHistory({ mode: "item", id });
      if (t.closest("[data-mcopy]")) { navigator.clipboard && navigator.clipboard.writeText("^" + id); this.say(`Copied ^${id}`); return this.render(); }
      if (t.closest("[data-mdel]")) return this.remove([id], this.neighbourFocus(id));
      this.render();
    }

    openMenu(id) { this.menu = this.menu === id ? null : id; this.render(); }

    toggleFold(key) {
      if (this.folded.has(key)) this.folded.delete(key); else this.folded.add(key);
      write(FOLDED_KEY, [...this.folded]);
      this.render();
    }

    hoistTo(target) {
      this.flushDrafts();
      this.hoist = target || null;
      write(HOIST_KEY, this.hoist);
      this.sel = null;
      this.focus = null;
      this.render();
      this.root.querySelector(".ol-scroll").scrollTop = 0;
      const first = this.body.querySelector(".ol-row:not(.ol-title) .ol-text") || this.body.querySelector(".ol-row .ol-text");
      if (first) setCaret(first, first.textContent.length);
    }

    setLens(lens) {
      this.lens = lens;
      write(LENS_KEY, lens);
      this.sticky.clear();
      this.render();
    }

    editContext(id) {
      this.ctxEdit = id;
      this.ctxOwn = this.serverOwn(id);
      this.ctxOpen.delete(id);
      this.render();
      const ta = this.body.querySelector(".ol-ctxedit");
      if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
    }

    finishContext(ta) {
      if (this.ctxEdit === null || this.ctxEdit === undefined) return;
      const id = this.ctxEdit;
      this.ctxEdit = null;
      const e = this.idx.get(id);
      if (!e) return;
      const context = ta.value.replace(/\s+$/, "").split("\n").filter((l, i, a) => l.trim() || (i > 0 && i < a.length - 1));
      const was = e.node.context;
      if (context.join("\n") !== was.join("\n")) {
        if (context.length) this.ctxOpen.add(id);
        write(CTX_OPEN_KEY, [...this.ctxOpen]);
        const op = this.ctxOwn ? { op: "context", id, context, expect: this.ctxOwn } : { op: "context", id, context };
        this.act([op], [{ op: "context", id, context: was }], { id, offset: this.rawText(id).length });
      } else {
        this.focus = { id, offset: this.rawText(id).length };
        this.render();
      }
    }

    neighbourFocus(id) {
      const ids = this.rows().filter((r) => !r.head).map((r) => r.node.id);
      const i = ids.indexOf(id);
      let j = i - 1;
      while (j >= 0 && this.isUnder(ids[j], id)) j--;
      const prev = j >= 0 ? ids[j] : null;
      let k = i + 1;
      while (k < ids.length && this.isUnder(ids[k], id)) k++;
      const next = prev ? null : k < ids.length ? ids[k] : null;
      const to = prev || next;
      return to ? { id: to, offset: prev ? this.rawText(to).length : 0 } : null;
    }

    visibleIds() { return this.rows().filter((r) => !r.head).map((r) => r.node.id); }

    focusRow(id, where) {
      const el = this.textEl(id);
      if (!el) return;
      setCaret(el, where === "end" ? this.rawText(id).length : where === "start" ? 0 : where);
    }

    onKey(e) {
      if (this.snapshot) return;
      if (e.target.classList.contains("ol-ctxedit")) {
        if (e.key === "Escape" || (e.key === "Enter" && (e.metaKey || e.ctrlKey))) { e.preventDefault(); e.target.blur(); }
        return;
      }
      if (e.target.classList.contains("ol-htitle")) {
        if (e.key === "Enter" || e.key === "Escape") { e.preventDefault(); e.target.blur(); }
        return;
      }
      if (this.sel && !e.target.classList.contains("ol-text")) return this.onSelKey(e);
      if (!e.target.classList.contains("ol-text")) return;
      if (e.isComposing) return;
      const el = e.target;
      const id = this.rowOf(el);
      const ent = this.idx.get(id);
      if (!ent) return;
      const node = ent.node;
      const mod = e.metaKey || e.ctrlKey;
      const text = el.textContent;
      const caret = caretOf(el) ?? 0;
      const range = selectionIn(el) || { start: caret, end: caret };
      this.focus = { id, offset: caret };

      if (e.key === "Enter" && e.shiftKey && !mod) { e.preventDefault(); return this.editContext(id); }
      if (e.key === "Enter" && mod) { e.preventDefault(); return this.toggleCheck([id]); }
      if (e.key === "Enter") {
        e.preventDefault();
        this.flushDrafts();
        const kind = this.kindOf(node);
        if (!text.trim() && this.depthOf(id) > 0 && !node.children.length) return this.outdent([id]);
        if (range.start === 0 && range.end === 0 && text.length) {
          // At the very start: a new empty item above, the caret stays in this one.
          const nid = newId(this.taken());
          const place = this.placeOf(id);
          this.act([{ op: "insert", place, item: { id: nid, text: "", check: kind, context: [] } }], [{ op: "delete", id: nid }], { id, offset: 0 });
          return;
        }
        const before = text.slice(0, range.start);
        const after = text.slice(range.end);
        const nid = newId(this.taken());
        const ops = [];
        const inverse = [{ op: "delete", id: nid }];
        if (after || range.end !== range.start) {
          ops.push({ op: "text", id, text: before });
          inverse.push({ op: "text", id, text });
        }
        // The title of a focused branch, or an open parent: the new item is its first child.
        const target = this.hoistTarget();
        const isTitle = !!(target && target.item && target.item.id === id);
        const intoKids = isTitle || (node.children.length && !this.folded.has(id) && !after);
        const place = intoKids ? { parent: id, index: 0 } : { after: id };
        ops.push({ op: "insert", place, item: { id: nid, text: after, check: kind, context: [] } });
        this.act(ops, inverse, { id: nid, offset: 0 });
        return;
      }
      if (e.key === "Tab") {
        e.preventDefault();
        this.flushDrafts();
        if (e.shiftKey) this.outdent([id]); else this.indent([id]);
        return;
      }
      if ((e.altKey && !mod && (e.key === "ArrowUp" || e.key === "ArrowDown")) || (mod && e.shiftKey && (e.key === "ArrowUp" || e.key === "ArrowDown"))) {
        e.preventDefault();
        this.flushDrafts();
        return this.shift([id], e.key === "ArrowUp" ? -1 : 1);
      }
      if (mod && e.key === ".") { e.preventDefault(); return this.toggleFold(id); }
      if (mod && !e.shiftKey && e.code === "KeyG") { e.preventDefault(); return this.group([id]); }
      // ⌘A on a line already selected whole: select every item instead.
      if (mod && e.key.toLowerCase() === "a" && text.length && range.start === 0 && range.end === text.length) {
        e.preventDefault();
        const ids = this.visibleIds();
        return this.selectRows(ids[0], ids[ids.length - 1]);
      }
      if (mod && !e.shiftKey && (e.key === "ArrowUp" || e.key === "ArrowDown") && node.children.length) {
        e.preventDefault();
        const fold = e.key === "ArrowUp";
        if (fold !== this.folded.has(id)) this.toggleFold(id);
        return;
      }
      if (mod && e.key === "]") { e.preventDefault(); return this.hoistTo(id); }
      if (mod && e.key === "[") {
        e.preventDefault();
        const target = this.hoistTarget();
        if (!target) return;
        if (target.item) { const p = this.idx.get(target.item.id).parent; return this.hoistTo(p ? p.id : "s:" + target.sec.ref); }
        return this.hoistTo(null);
      }
      if (mod && e.key.toLowerCase() === "z") { e.preventDefault(); return e.shiftKey ? this.redo() : this.undo(); }
      if (e.key === "Escape") {
        e.preventDefault();
        this.flushDrafts();
        el.blur();
        this.sel = { anchor: id, head: id };
        this.body.focus();
        return this.paintSelection();
      }
      if (e.key === "Backspace" && range.start === 0 && range.end === 0) {
        const ids = this.visibleIds();
        const i = ids.indexOf(id);
        if (!text.length && !node.children.length) {
          e.preventDefault();
          return this.remove([id], this.neighbourFocus(id));
        }
        if (i > 0 && !node.children.length && !node.context.length) {
          const prevId = ids[i - 1];
          if (this.isUnder(id, prevId)) return;
          e.preventDefault();
          this.flushDrafts();
          const prevText = this.rawText(prevId);
          this.act(
            [{ op: "text", id: prevId, text: prevText + text }, { op: "delete", id }],
            [{ op: "insert", place: this.placeOf(id), item: this.snapshotOf(node) }, { op: "text", id: prevId, text: prevText }],
            { id: prevId, offset: prevText.length },
          );
        }
        return;
      }
      if (e.key === "Delete" && range.start === text.length && range.end === text.length) {
        const ids = this.visibleIds();
        const nextId = ids[ids.indexOf(id) + 1];
        const next = nextId && this.idx.get(nextId).node;
        if (next && !next.children.length && !next.context.length && !this.isUnder(nextId, id)) {
          e.preventDefault();
          this.flushDrafts();
          this.act(
            [{ op: "text", id, text: text + next.text }, { op: "delete", id: nextId }],
            [{ op: "insert", place: this.placeOf(nextId), item: this.snapshotOf(next) }, { op: "text", id, text }],
            { id, offset: text.length },
          );
        }
        return;
      }
      if ((e.key === "ArrowUp" || e.key === "ArrowDown") && !e.altKey && !mod) {
        const up = e.key === "ArrowUp";
        if (!caretOnEdgeLine(el, up ? "up" : "down")) return;
        const ids = this.visibleIds();
        const i = ids.indexOf(id);
        const j = up ? i - 1 : i + 1;
        if (e.shiftKey) {
          e.preventDefault();
          this.flushDrafts();
          el.blur();
          this.sel = { anchor: id, head: ids[Math.max(0, Math.min(ids.length - 1, j))] || id };
          this.body.focus();
          return this.paintSelection();
        }
        if (j < 0 || j >= ids.length) return;
        e.preventDefault();
        this.focusRow(ids[j], Math.min(caret, this.rawText(ids[j]).length));
        return;
      }
      // "[] " or "[ ] " at the start of a note makes it a task; "- " on an empty task makes it a note.
      if (e.key === " " && node.check === null && /^\[ ?\]$/.test(text.slice(0, range.start)) && range.start === range.end) {
        e.preventDefault();
        el.textContent = text.slice(range.start);
        this.drafts.set(id, el.textContent);
        this.typedFrom.set(id, this.typedFrom.get(id) ?? node.text);
        node.text = el.textContent;
        return this.setKind(id, " ");
      }
      if (e.key === " " && node.check !== null && text === "-" && range.start === 1) {
        e.preventDefault();
        el.textContent = "";
        this.drafts.set(id, "");
        this.typedFrom.set(id, this.typedFrom.get(id) ?? node.text);
        node.text = "";
        return this.setKind(id, null);
      }
    }

    // ---------- row selection ----------

    selectedIds() {
      if (!this.sel) return [];
      const ids = this.visibleIds();
      let a = ids.indexOf(this.sel.anchor);
      let b = ids.indexOf(this.sel.head);
      if (a < 0 || b < 0) return [];
      if (a > b) [a, b] = [b, a];
      const picked = ids.slice(a, b + 1);
      // Only the top-most of the picked rows: their children come along.
      return picked.filter((id) => !picked.some((o) => o !== id && this.isUnder(id, o)));
    }

    paintSelection() {
      this.body.querySelectorAll(".ol-row.sel").forEach((r) => { r.classList.remove("sel"); r.removeAttribute("draggable"); });
      if (!this.sel) return this.paintTools();
      const ids = this.visibleIds();
      let a = ids.indexOf(this.sel.anchor);
      let b = ids.indexOf(this.sel.head);
      if (a < 0 || b < 0) { this.sel = null; return this.paintTools(); }
      if (a > b) [a, b] = [b, a];
      for (const id of ids.slice(a, b + 1)) {
        const r = this.body.querySelector(`.ol-row[data-id="${CSS.escape(id)}"]`);
        // Selected rows can be dragged by any point, not only by the grip.
        if (r) { r.classList.add("sel"); r.setAttribute("draggable", "true"); }
      }
      const head = this.body.querySelector(`.ol-row[data-id="${CSS.escape(this.sel.head)}"]`);
      if (head) head.scrollIntoView({ block: "nearest" });
      this.paintTools();
    }

    /** The bar over a selection: what can be done to the selected items, with their keys. */
    paintTools() {
      const el = this.root.querySelector(".ol-seltools");
      if (!el) return;
      const first = this.sel && this.body.querySelector(".ol-row.sel");
      if (!first || this.snapshot) { el.hidden = true; return; }
      const n = this.selectedIds().length;
      const all = this.body.querySelectorAll(".ol-row.sel").length;
      el.innerHTML = `<span class="ol-stn">${all} selected</span>` +
        `<button data-st="out" title="Move one level out (Shift+Tab)">← Out</button>` +
        `<button data-st="in" title="Make ${n === 1 ? "it a sub-item" : "them sub-items"} of the item above (Tab)">In →</button>` +
        `<button data-st="up" title="Move up (⌥↑)">↑</button><button data-st="down" title="Move down (⌥↓)">↓</button>` +
        `<button data-st="check" title="Check / uncheck (⌘↵)">✓</button>` +
        `<button data-st="fold" title="Fold what is inside; items with nothing inside go under a new folded item (⌘.)">Collapse</button>` +
        `<button data-st="group" title="Put under a new item (⌘G)">Group</button>` +
        `<button data-st="del" class="del" title="Delete with what is under (⌫)">Delete</button>`;
      el.hidden = false;
      // Above the first selected row; below the last one when there is no room above.
      const page = this.root.querySelector(".ol-page").getBoundingClientRect();
      const scroll = this.root.querySelector(".ol-scroll").getBoundingClientRect();
      const rows = this.body.querySelectorAll(".ol-row.sel");
      const above = first.getBoundingClientRect().top - el.offsetHeight - 6;
      const top = above >= scroll.top + 4 ? above : rows[rows.length - 1].getBoundingClientRect().bottom + 6;
      el.style.top = `${top - page.top}px`;
      el.style.right = `${Math.max(12, page.right - this.body.getBoundingClientRect().right + 24)}px`;
    }

    selTool(what) {
      const sel = this.selectedIds();
      if (!sel.length) return;
      if (what === "out") this.outdent(sel);
      else if (what === "in") this.indent(sel);
      else if (what === "up") this.shift(sel, -1);
      else if (what === "down") this.shift(sel, 1);
      else if (what === "check") this.toggleCheck(sel);
      else if (what === "fold") return this.collapse(sel);
      else if (what === "group") return this.group(sel);
      else if (what === "del") return this.remove(sel, this.neighbourFocus(sel[0]));
      this.body.focus({ preventScroll: true });
      this.paintSelection();
    }

    /** Folds the selected items; items with nothing inside go under a new item, folded ("under a cut"). */
    collapse(ids) {
      const withKids = ids.filter((id) => this.idx.get(id).node.children.length);
      if (!withKids.length) return this.group(ids, { fold: true });
      const fold = withKids.some((id) => !this.folded.has(id));
      for (const id of withKids) if (fold) this.folded.add(id); else this.folded.delete(id);
      write(FOLDED_KEY, [...this.folded]);
      this.sel = { anchor: ids[0], head: ids[ids.length - 1] };
      this.render();
      this.body.focus({ preventScroll: true });
    }

    /** Puts the items under a new item at the place of the first one; the caret goes to its text. */
    group(ids, opts = {}) {
      this.flushDrafts();
      const order = this.visibleIds();
      ids = [...ids].sort((a, b) => order.indexOf(a) - order.indexOf(b));
      const gid = newId(this.taken());
      const first = this.idx.get(ids[0]).node;
      const ops = [{ op: "insert", place: this.placeOf(ids[0]), item: { id: gid, text: "", check: first.check === null ? null : " ", context: [] } }];
      const inverse = [{ op: "delete", id: gid }];
      this.localApply([ops[0]]);
      ids.forEach((id, i) => {
        const back = { op: "move", id, place: this.placeOf(id) };
        const op = { op: "move", id, place: { parent: gid, index: i } };
        ops.push(op);
        inverse.unshift(back);
        this.localApply([op]);
      });
      if (opts.fold) { this.folded.add(gid); write(FOLDED_KEY, [...this.folded]); }
      this.undoStack.push({ ops, inverse });
      this.redoStack = [];
      this.sticky.add(gid);
      for (const id of ids) this.sticky.add(id);
      this.sel = null;
      this.render({ id: gid, offset: 0 });
      this.send(ops);
      this.say("Type a title for the group");
    }

    // ---------- selecting with the mouse ----------

    onPress(e) {
      if (e.button !== 0 || this.snapshot) return;
      const row = e.target.closest(".ol-row");
      if (!row || row.classList.contains("ol-title")) return;
      if (e.target.closest(".ol-grip, button, .ol-chips, .ol-menu, textarea, a, .ol-ctxt")) return;
      const id = row.dataset.id;
      // Shift-click: whole items from the one being edited (or the selection's start) to this one.
      if (e.shiftKey) {
        const from = this.sel ? this.sel.anchor : this.focus ? this.focus.id : null;
        if (from && from !== id && this.visibleIds().includes(from)) { e.preventDefault(); this.selectRows(from, id); return; }
      }
      if (this.sel && row.classList.contains("sel")) return; // dragging the selected items
      this.press = { id };
    }

    onPressMove(e) {
      if (!this.press) return;
      if (!(e.buttons & 1)) { this.onPressEnd(); return; }
      const id = this.rowAtY(e.clientY);
      if (!id || (!this.sel && id === this.press.id)) return; // inside one item the browser selects its text
      e.preventDefault();
      this.body.classList.add("selecting");
      this.selectRows(this.press.id, id);
      const sc = this.root.querySelector(".ol-scroll");
      const box = sc.getBoundingClientRect();
      if (e.clientY < box.top + 30) sc.scrollTop -= 14;
      else if (e.clientY > box.bottom - 30) sc.scrollTop += 14;
    }

    onPressEnd() {
      this.press = null;
      this.body.classList.remove("selecting");
    }

    selectRows(from, to) {
      if (!this.sel) {
        this.flushDrafts();
        const a = document.activeElement;
        if (a && this.body.contains(a) && a !== this.body && a.blur) a.blur();
        this.body.focus({ preventScroll: true });
      }
      const s = window.getSelection();
      if (s) s.removeAllRanges();
      this.sel = { anchor: from, head: to };
      this.paintSelection();
    }

    /** The row under a height on the screen (the nearest one above or below the gaps). */
    rowAtY(y) {
      const rows = this.body.querySelectorAll(".ol-row:not(.ol-title)");
      for (const r of rows) if (y < r.getBoundingClientRect().bottom) return r.dataset.id;
      return rows.length ? rows[rows.length - 1].dataset.id : null;
    }

    onSelKey(e) {
      const mod = e.metaKey || e.ctrlKey;
      const ids = this.visibleIds();
      const sel = this.selectedIds();
      const h = ids.indexOf(this.sel.head);
      if (e.key === "Escape") { e.preventDefault(); this.sel = null; return this.paintSelection(); }
      if (e.key === "Enter" && !mod) { e.preventDefault(); const id = this.sel.head; this.sel = null; this.paintSelection(); return this.focusRow(id, "end"); }
      if (e.key === "Enter" && mod) { e.preventDefault(); return this.toggleCheck(sel); }
      if (e.key === "Tab") { e.preventDefault(); return e.shiftKey ? this.outdent(sel) : this.indent(sel); }
      if ((e.altKey || (mod && e.shiftKey)) && (e.key === "ArrowUp" || e.key === "ArrowDown")) { e.preventDefault(); return this.shift(sel, e.key === "ArrowUp" ? -1 : 1); }
      if (e.key === "ArrowUp" || e.key === "ArrowDown") {
        e.preventDefault();
        const j = Math.max(0, Math.min(ids.length - 1, h + (e.key === "ArrowUp" ? -1 : 1)));
        if (e.shiftKey) this.sel.head = ids[j]; else this.sel = { anchor: ids[j], head: ids[j] };
        return this.paintSelection();
      }
      if (e.key === "Backspace" || e.key === "Delete") { e.preventDefault(); return this.remove(sel, this.neighbourFocus(sel[0])); }
      if (mod && e.key === "a") { e.preventDefault(); this.sel = { anchor: ids[0], head: ids[ids.length - 1] }; return this.paintSelection(); }
      if (mod && e.key === ".") { e.preventDefault(); return this.collapse(sel); }
      if (mod && !e.shiftKey && e.code === "KeyG") { e.preventDefault(); return this.group(sel); }
      if (mod && e.key.toLowerCase() === "z") { e.preventDefault(); return e.shiftKey ? this.redo() : this.undo(); }
    }

    // ---------- clipboard ----------

    asMarkdown(ids) {
      const out = [];
      const walk = (n, depth) => {
        const box = n.check === null ? "" : `[${n.check}] `;
        out.push(`${"  ".repeat(depth)}- ${box}${n.text}`);
        for (const c of n.context) out.push(`${"  ".repeat(depth + 1)}> ${c}`);
        for (const c of n.children) walk(c, depth + 1);
      };
      for (const id of ids) walk(this.idx.get(id).node, 0);
      return out.join("\n");
    }

    onCopy(e) {
      if (!this.sel) return;
      e.preventDefault();
      e.clipboardData.setData("text/plain", this.asMarkdown(this.selectedIds()));
      this.say("Copied");
    }

    onPaste(e) {
      const t = e.target;
      const text = (e.clipboardData && e.clipboardData.getData("text/plain")) || "";
      const inText = t.classList && t.classList.contains("ol-text");
      if (!inText && !this.sel) return;
      if (!text.includes("\n") && inText) return; // one line: the browser inserts it as plain text
      e.preventDefault();
      const id = inText ? this.rowOf(t) : this.sel.head;
      const items = parsePasted(text, this.taken());
      if (!items.length) return;
      this.flushDrafts();
      const ops = [];
      const inverse = [];
      let after = id;
      // An empty row takes the first pasted line.
      const cur = this.idx.get(id).node;
      if (inText && !this.rawText(id).trim() && !cur.children.length) {
        ops.push({ op: "delete", id });
        inverse.push({ op: "insert", place: this.placeOf(id), item: this.snapshotOf(cur) });
        const prevPlace = this.placeOf(id);
        ops.unshift({ op: "insert", place: prevPlace, item: items[0] });
        inverse.unshift({ op: "delete", id: items[0].id });
        after = items[0].id;
        items.shift();
      }
      for (const it of items) {
        ops.push({ op: "insert", place: { after }, item: it });
        inverse.unshift({ op: "delete", id: it.id });
        after = it.id;
      }
      this.sel = null;
      this.act(ops, inverse, { id: after, offset: this.rawTextOf(ops, after).length });
    }

    rawTextOf(ops, id) {
      for (const op of ops) if (op.item && op.item.id === id) return op.item.text;
      return this.rawText(id);
    }

    // ---------- drag and drop ----------

    onDragStart(e) {
      const grip = e.target.closest && (e.target.closest(".ol-grip") || e.target.closest(".ol-row.sel"));
      if (!grip) return;
      const id = this.rowOf(grip);
      const ids = this.sel && this.selectedIds().includes(id) ? this.selectedIds() : [id];
      this.flushDrafts();
      this.drag = { ids, target: null };
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", this.asMarkdown(ids));
      const row = grip.closest(".ol-row");
      e.dataTransfer.setDragImage(row, 12, 12);
      requestAnimationFrame(() => this.drag && ids.forEach((x) => { const r = this.body.querySelector(`.ol-row[data-id="${CSS.escape(x)}"]`); if (r) r.classList.add("dragging"); }));
    }

    onDragOver(e) {
      if (!this.drag) return;
      const row = e.target.closest(".ol-row");
      const head = e.target.closest(".ol-head");
      const line = this.root.querySelector(".ol-drop");
      if (!row && !head) return;
      e.preventDefault();
      const host = this.root.querySelector(".ol-page").getBoundingClientRect();
      if (head) {
        const box = head.getBoundingClientRect();
        this.drag.target = { section: head.dataset.sec };
        line.hidden = false;
        Object.assign(line.style, { top: `${box.bottom - host.top}px`, left: `${box.left - host.left + 28}px`, width: `${box.width - 40}px` });
        return;
      }
      const id = row.dataset.id;
      if (this.drag.ids.some((d) => d === id || this.isUnder(id, d))) { line.hidden = true; this.drag.target = null; return; }
      const box = row.getBoundingClientRect();
      const text = row.querySelector(".ol-text").getBoundingClientRect();
      const below = e.clientY > box.top + box.height / 2;
      const child = below && e.clientX > text.left + 36;
      this.drag.target = { id, mode: child ? "child" : below ? "after" : "before" };
      line.hidden = false;
      const left = (child ? text.left + 24 : text.left - 26) - host.left;
      Object.assign(line.style, { top: `${(below ? box.bottom : box.top) - host.top}px`, left: `${left}px`, width: `${box.right - host.left - left - 12}px` });
    }

    onDrop(e) {
      if (!this.drag || !this.drag.target) return this.endDrag();
      e.preventDefault();
      const { ids, target } = this.drag;
      this.endDrag();
      let prev = null;
      this.moveTo(ids, (id) => {
        let place;
        if (prev) place = { after: prev };
        else if (target.section) place = { parent: null, section: target.section, index: 0 };
        else if (target.mode === "child") { this.folded.delete(target.id); place = { parent: target.id, index: 0 }; }
        else if (target.mode === "after") place = { after: target.id };
        else {
          // Before the target: its index among the siblings that stay once the item is taken out.
          const te = this.idx.get(target.id);
          const i = this.siblingsOf(target.id).filter((n) => n.id !== id).indexOf(te.node);
          place = te.parent ? { parent: te.parent.id, index: i } : { parent: null, section: te.sec.ref, index: i };
        }
        prev = id;
        return place;
      });
    }

    endDrag() {
      this.drag = null;
      this.root.querySelector(".ol-drop").hidden = true;
      this.body.querySelectorAll(".dragging").forEach((r) => r.classList.remove("dragging"));
    }

    // ---------- migration ----------

    async migrate() {
      try {
        const r = await this.api("POST", "/api/outline/migrate", {});
        this.toast(r.message, true);
        await this.load();
      } catch (err) { this.toast(err.message); }
    }

    // ---------- history ----------

    toggleHistory() {
      if (this.history) return this.closeHistory();
      const id = this.focus ? this.focus.id : this.sel ? this.sel.head : null;
      this.openHistory(id ? { mode: "item", id } : { mode: "days" });
    }

    openHistory(h) {
      this.history = h;
      this.loadHistory();
    }

    closeHistory() {
      this.history = null;
      this.snapshot = null;
      const aside = this.root.querySelector(".ol-hist");
      aside.hidden = true;
      this.root.querySelector(".ol-page").classList.remove("viewing");
      this.render();
    }

    async loadHistory() {
      const aside = this.root.querySelector(".ol-hist");
      aside.hidden = false;
      const h = this.history;
      const tabs = `<div class="oh-tabs"><button data-ht="days" class="${h.mode === "days" || h.mode === "day" ? "on" : ""}">Days</button>` +
        (h.id ? `<button data-ht="item" class="${h.mode === "item" ? "on" : ""}">Item</button>` : "") +
        (h.key ? `<button data-ht="key" class="${h.mode === "key" ? "on" : ""}">${esc(h.key)}</button>` : "") +
        `<button class="oh-x" data-hclose title="Close">×</button></div>`;
      aside.innerHTML = tabs + `<div class="oh-body"><div class="oh-wait">Reading the history…</div></div>`;
      this.wireHistoryTabs(aside);
      let html = "";
      try {
        if (h.mode === "item") {
          const r = await this.api("GET", `/api/outline/history?id=${encodeURIComponent(h.id)}`);
          const node = this.idx.get(h.id);
          html = `<h4>${esc(node ? this.display(node.node).text : r.title)}</h4>` + timeline(r.events, h.id);
        } else if (h.mode === "key") {
          const r = await this.api("GET", `/api/outline/history?key=${encodeURIComponent(h.key)}`);
          html = `<h4>${esc(h.key)} — how it went</h4>` + timeline(r.events, null);
        } else {
          const r = await this.api("GET", "/api/outline/days");
          html = `<h4>Day by day</h4>` + (r.days.length ? `<div class="oh-days">` + r.days.map((d) =>
            `<button data-day="${esc(d.day)}" class="${this.snapshot && this.snapshot.day === d.day ? "on" : ""}"><b>${esc(dayLabel(d.day))}</b>` +
            `<span>${d.changes} change${d.changes === 1 ? "" : "s"}${d.checked ? ` · ✓ ${d.checked}` : ""}${d.added ? ` · + ${d.added}` : ""}</span></button>`).join("") + `</div>` :
            `<div class="oh-wait">No history yet: it starts with the first save.</div>`);
          if (this.snapshot) html += `<h4>${esc(dayLabel(this.snapshot.day))}</h4>` + timeline(this.snapshot.events, null);
        }
      } catch (err) { html = `<div class="oh-wait">${esc(err.message)}</div>`; }
      if (this.history !== h) return;
      aside.querySelector(".oh-body").innerHTML = html;
      aside.querySelectorAll("[data-day]").forEach((b) => b.addEventListener("click", () => this.showDay(b.dataset.day)));
      aside.querySelectorAll("[data-jump]").forEach((b) => b.addEventListener("click", () => this.jumpTo(b.dataset.jump)));
    }

    wireHistoryTabs(aside) {
      aside.querySelectorAll("[data-ht]").forEach((b) => b.addEventListener("click", () => {
        const mode = b.dataset.ht;
        if (mode !== "days") { this.snapshot = null; this.root.querySelector(".ol-page").classList.remove("viewing"); this.render(); }
        this.history = { ...this.history, mode: mode === "days" && this.snapshot ? "day" : mode };
        this.loadHistory();
      }));
      aside.querySelector("[data-hclose]").addEventListener("click", () => this.closeHistory());
    }

    async showDay(day) {
      try {
        const r = await this.api("GET", `/api/outline/day?day=${encodeURIComponent(day)}`);
        this.snapshot = r;
        this.history = { ...this.history, mode: "day" };
        this.root.querySelector(".ol-page").classList.add("viewing");
        this.render();
        this.loadHistory();
      } catch (err) { this.toast(err.message); }
    }

    jumpTo(id) {
      if (this.snapshot) { this.snapshot = null; this.root.querySelector(".ol-page").classList.remove("viewing"); }
      const e = this.idx.get(id);
      if (!e) { this.toast("That item is no longer in the outline."); return; }
      this.lens = "all"; this.query = ""; this.hoist = null;
      for (let x = e; x && x.parent; x = this.idx.get(x.parent.id)) this.folded.delete(x.parent.id);
      this.folded.delete("s:" + e.sec.ref);
      this.flash.set(id, "changed");
      this.render();
      const row = this.body.querySelector(`.ol-row[data-id="${CSS.escape(id)}"]`);
      if (row) row.scrollIntoView({ block: "center" });
    }

    renderSnapshot() {
      const s = this.snapshot;
      const marks = new Map();
      for (const e of s.events) if (!marks.has(e.ref) || e.kind === "added") marks.set(e.ref, e.kind);
      const now = new Date();
      let h = `<div class="ol-banner">The outline at the end of <b>${esc(dayLabel(s.day))}</b> — read only. ` +
        `<button class="btn" data-back>Back to now</button></div>`;
      const walk = (items, depth, sec) => {
        for (const n of items) {
          const m = marks.get(n.id);
          let row = this.rowHtml({ node: n, depth, sec }, now);
          if (m) row = row.replace(`class="ol-row`, `class="ol-row mark-${m}`);
          h += row.replace(/contenteditable="plaintext-only"/g, "").replace(/draggable="true"/g, "");
          walk(n.children, depth + 1, sec);
        }
      };
      for (const sec of s.sections) {
        h += this.headHtml(sec).replace(/contenteditable="plaintext-only"/g, "").replace(/<span class="ol-hacts">[\s\S]*?<\/span><\/div>$/, "</div>");
        walk(sec.items, 0, sec);
      }
      this.body.innerHTML = `<div class="ol-snap">${h}</div>`;
      this.root.querySelector(".ol-crumbs").hidden = true;
      this.root.querySelector(".ol-foot").innerHTML = "";
      this.body.querySelector("[data-back]").addEventListener("click", () => {
        this.snapshot = null;
        this.history = { ...this.history, mode: "days" };
        this.root.querySelector(".ol-page").classList.remove("viewing");
        this.render();
        this.loadHistory();
      });
    }

    toggleKeys() {
      const el = this.root.querySelector(".ol-keys");
      if (!el.hidden) { el.hidden = true; return; }
      const groups = [
        ["Writing", [
          ["Enter", "a new item below. At the start of a line: a new one above; in the middle: splits the line"],
          ["Shift + Enter", "a note under the item (context, links, quotes)"],
          ["⌘ + Enter", "check / uncheck"],
          ["[ ] then space", "at the start of a bullet: makes it a task; “- ” then space makes a task a bullet"],
          ["· by tomorrow", "“wait for review · from Jim · by tomorrow” turns the item into a loop"],
        ]],
        ["Moving items", [
          ["Tab", "shifts the item right: it becomes a sub-item of the one above. Its own sub-items come along"],
          ["Shift + Tab", "shifts it back left, one level out"],
          ["⌥ Option + ↑ / ↓", "moves the item, with everything under it, up or down"],
          ["drag ⋮⋮", "the handle left of an item: drag to put it anywhere; drop to the right to nest it"],
          ["right-click ⋮⋮", "the same as buttons: in / out, up / down, focus, history, delete"],
        ]],
        ["Several items", [
          ["drag across", "press on an item and move the mouse over others: whole items get selected"],
          ["Shift + click", "selects from the item being edited to the clicked one"],
          ["Esc, Shift + ↑ / ↓", "select from the keyboard"],
          ["then", "Tab / Shift + Tab, ⌥↑ / ⌥↓, ⌘ + Enter, Delete work on all of them, or use the bar above them"],
          ["⌘ + .", "collapse: folds what is inside; items with nothing inside go under a new folded item"],
          ["⌘ + G", "group: puts them under a new item and lets you type its title"],
        ]],
        ["Looking around", [
          ["⌘ + .", "on one item: fold / unfold what is under it (or click the ▾ arrow)"],
          ["⌘ + ] / ⌘ + [", "open the item as its own page / go back out (or click the bullet)"],
          ["⌥ Option + H", "history: the item’s life, the ticket’s, the outline day by day"],
          ["⌘ + Z / ⇧⌘ + Z", "undo / redo"],
        ]],
      ];
      el.innerHTML = `<div class="ol-keysbox"><h4>How to use the outline</h4>` +
        groups.map(([title, rows]) => `<h5>${esc(title)}</h5>` + rows.map(([k, v]) => `<div><kbd>${esc(k)}</kbd><span>${esc(v)}</span></div>`).join("")).join("") +
        `<button class="btn ghost" data-kclose>Close</button></div>`;
      el.hidden = false;
      el.querySelector("[data-kclose]").addEventListener("click", () => { el.hidden = true; });
      el.addEventListener("click", (e) => { if (e.target === el) el.hidden = true; });
    }
  }

  // ---------- helpers ----------

  function countAll(n) {
    let c = 0;
    for (const k of n.children) c += 1 + countAll(k);
    return c;
  }

  function linkify(s) {
    return esc(s).replace(/https?:\/\/[^\s<]+/g, (u) => `<a href="${u}" target="_blank" rel="noopener noreferrer">${u}</a>`);
  }

  function dayLabel(day) {
    const [y, m, d] = day.split("-").map(Number);
    const date = new Date(y, m - 1, d);
    const today = new Date();
    const diff = Math.round((new Date(today.getFullYear(), today.getMonth(), today.getDate()) - date) / 86400000);
    const name = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][date.getDay()];
    if (diff === 0) return `Today, ${name} ${d} ${MONTHS[m - 1]}`;
    if (diff === 1) return `Yesterday, ${name} ${d} ${MONTHS[m - 1]}`;
    return `${name} ${d} ${MONTHS[m - 1]}${y !== today.getFullYear() ? ` ${y}` : ""}`;
  }

  const KIND = {
    added: ["+", "added"], removed: ["−", "removed"], checked: ["✓", "done"], unchecked: ["↺", "reopened"], edited: ["✎", "reworded"],
    moved: ["→", "moved"], note: ["¶", "note"], task: ["○", "kind"], "section-added": ["#", "section"], "section-closed": ["✓", "closed"],
    "section-reopened": ["↺", "reopened"], "section-removed": ["−", "removed"], "section-renamed": ["✎", "renamed"],
  };

  function timeline(events, self) {
    if (!events.length) return `<div class="oh-wait">No changes recorded yet.</div>`;
    let h = `<ol class="oh-tl">`;
    let day = "";
    for (const e of events) {
      const d = e.date.slice(0, 10);
      if (d !== day) { h += `<li class="oh-day">${esc(dayLabel(d))}</li>`; day = d; }
      const [mark, label] = KIND[e.kind] || ["·", e.kind];
      const own = self && e.ref === self;
      const under = !own && e.path.length ? `<div class="oh-under">under ${esc(e.path[e.path.length - 1])}</div>` : "";
      const was = e.was && (e.kind === "edited" || e.kind === "moved" || e.kind === "section-renamed")
        ? `<div class="oh-was">${e.kind === "moved" ? "from " : "was: "}${esc(e.was)}</div>` : "";
      h += `<li class="oh-ev k-${esc(e.kind)}"><span class="oh-m" title="${esc(label)}">${mark}</span>` +
        `<span class="oh-t">${e.sha ? esc(e.date.slice(11, 16)) : "now"}</span>` +
        `<div class="oh-x2"><button class="oh-txt" data-jump="${esc(e.ref)}" title="Show it">${esc(stripFields(e.text))}</button>${was}${under}</div></li>`;
    }
    return h + `</ol>`;
  }

  function stripFields(text) {
    return text.replace(/ · opened \d{4}-\d{2}-\d{2}( \d{1,2}:\d{2})?/, "").replace(DONE_RE, "");
  }

  /** Lines pasted as items: "- [ ] x", "* x", "1. x" or plain lines; indentation makes children; "> " lines are notes. */
  function parsePasted(text, taken) {
    const lines = text.replace(/\r\n?/g, "\n").split("\n").filter((l) => l.trim());
    const roots = [];
    const stack = [];
    for (const raw of lines) {
      const ws = /^[ \t]*/.exec(raw)[0].replace(/\t/g, "  ").length;
      const body = raw.trim();
      const ctx = /^>\s?(.*)$/.exec(body);
      if (ctx && stack.length) { stack[stack.length - 1].node.context.push(ctx[1]); continue; }
      const m = /^(?:[-*+]|\d+[.)])\s+(?:\[([ xX])\]\s*)?(.*)$/.exec(body);
      const check = m ? (m[1] === undefined ? null : m[1] === " " ? " " : "x") : " ";
      let t = m ? m[2] : body;
      t = t.replace(/\s\^[A-Za-z0-9]{2,16}$/, "");
      const id = newId(taken);
      taken.add(id);
      const node = { id, text: t, check: m && m[1] === undefined && /^[-*+]/.test(body) ? null : check, context: [], children: [] };
      while (stack.length && stack[stack.length - 1].ws >= ws) stack.pop();
      if (stack.length) stack[stack.length - 1].node.children.push(node); else roots.push(node);
      stack.push({ ws, node });
    }
    return roots;
  }

  window.LFOutline = {
    mount(root, deps) { return new Outline(root, deps); },
  };
})();
