// Local Flow web UI. Vanilla JS, talks to the JSON API in ../server.ts. Four panes:
// nav (groups, status filters, notes) · ticket list (a tree) · ticket folder · content (Jira mirror,
// history, or the editor).
// The editor is a Notion-style live preview: blocks render as HTML, the block being edited
// shows its raw Markdown in a textarea.

(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  // Only http(s) links are allowed into href attributes.
  const safeUrl = (s) => (/^https?:\/\//i.test(String(s ?? "").trim()) ? esc(String(s).trim()) : "");

  const STATUS_LABELS = { inbox: "Inbox", inprogress: "In progress", inreview: "In review", done: "Done", archived: "Archived" };
  const NAV_STATUSES = ["inbox", "inprogress", "inreview", "done"];
  const OPEN_STATUSES = ["inbox", "inprogress", "inreview"];
  // "open" = inbox + inprogress + inreview, "all" = everything but archived, "status:X" = one status.
  const FILTER_KEY = "lf.status";
  // The selected group is the master context: "" means All, otherwise a group name.
  const GROUP_KEY = "lf.group";
  // Keys of tickets whose children are folded away in the list.
  const COLLAPSED_KEY = "lf.collapsed";
  // Linked folders (absolute paths) whose file lists are folded away in the folder pane.
  const LINKED_COLLAPSED_KEY = "lf.linkedCollapsed";
  const TICKET_DRAG = "application/x-localflow-ticket";
  // Pane widths set by dragging the handles between columns: { nav, list, folder } in px.
  const WIDTHS_KEY = "lf.widths";
  const PANES = [
    { id: "nav", prop: "--w-nav", min: 150 },
    { id: "list", prop: "--w-list", min: 220 },
    { id: "folder", prop: "--w-folder", min: 170 },
  ];
  // The content pane never gets narrower than this by dragging.
  const CONTENT_MIN = 360;

  const ICON = {
    logo: '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M2 3.5h7M2 8h12M2 12.5h9" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/></svg>',
    spark: '<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><circle cx="7" cy="7" r="6" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M7 3.8v3.5l2.2 1.4" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round"/></svg>',
    mag: '<svg width="13" height="13" viewBox="0 0 13 13" aria-hidden="true"><circle cx="5.5" cy="5.5" r="4.2" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M8.6 8.6l3 3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
    folder: '<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M1.5 3.5a1 1 0 0 1 1-1h3l1.3 1.4h4.7a1 1 0 0 1 1 1v5.6a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1z" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>',
    task: '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 1.8h5.5L12.5 5v9.2H4z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><path d="M9.3 1.8V5.2h3.2" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><path d="M6 9.2l1.4 1.4 2.6-2.8" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    hist: '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.6 8a5.4 5.4 0 1 0 1.6-3.8" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><path d="M2.2 2.4v2.4h2.4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/><path d="M8 5v3.2l2.1 1.3" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
    md: '<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M3 1.5h5l3 3v8H3z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><path d="M5 7.5h4M5 9.8h3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>',
    img: '<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><rect x="1.5" y="2.5" width="11" height="9" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M2.5 10.5l3-3 2 2 1.5-1.5 2.5 2.5" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><circle cx="9.5" cy="5.3" r="1" fill="currentColor"/></svg>',
  };

  // ---------- API ----------

  async function api(method, path, body) {
    const opts = { method, headers: {} };
    if (method !== "GET") {
      opts.headers["x-localflow"] = "1";
      opts.headers["content-type"] = "application/json";
      opts.body = JSON.stringify(body ?? {});
    }
    const res = await fetch(path, opts);
    const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  let toastTimer = 0;
  function toast(message, ok, ms) {
    const el = $("toast");
    el.textContent = message;
    el.className = "toast" + (ok ? " ok" : "");
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, ms || (ok ? 1800 : 5000));
  }

  function store(key) {
    try { return localStorage.getItem(key); } catch { return null; }
  }
  function readList(key) {
    try {
      const v = JSON.parse(store(key) || "[]");
      return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
    } catch { return []; }
  }
  function save(key, value) {
    try { localStorage.setItem(key, value); } catch { /* private mode: the choice just does not persist */ }
  }

  // ---------- state ----------

  const state = {
    overview: null,
    filter: /^(open|all|status:[a-z]+)$/.test(store(FILTER_KEY) || "") ? store(FILTER_KEY) : "open",
    group: store(GROUP_KEY) || "",
    collapsed: new Set(readList(COLLAPSED_KEY)),
    linkedCollapsed: new Set(readList(LINKED_COLLAPSED_KEY)),
    confirmGroup: null, // group whose "Delete? Yes/No" is showing
    dragKey: null,      // ticket being dragged
    dropEl: null,       // element currently highlighted as a drop target
    pending: false,     // a live refresh was skipped because a drag or an inline input is active
    syncKey: null,      // ticket whose sync is running
    pendingEdit: null,  // file to open straight in edit mode
    query: "",
    route: { kind: "none" },
    ticket: null,   // TicketView of the selected ticket
    editor: null,   // active Editor instance
  };

  function parseHash() {
    const h = decodeURIComponent(location.hash.replace(/^#/, ""));
    let m;
    if ((m = /^\/t\/([A-Z][A-Z0-9_]*-\d+)(?:\/(history)|\/f\/(.+)|\/x\/(\/.+))?$/.exec(h))) {
      const item = m[2] ? "history" : m[3] ? "file" : m[4] ? "linked" : "task";
      return { kind: "ticket", key: m[1], item, file: m[3] || m[4] || null };
    }
    if ((m = /^\/n\/(.+)$/.exec(h))) return { kind: "note", rel: m[1] };
    return { kind: "none" };
  }

  function go(hash) {
    if (location.hash === hash) onRoute();
    else location.hash = hash;
  }

  // ---------- helpers ----------

  function jiraChip(row) {
    if (row.source !== "jira") return '<span class="local">local</span>';
    const cls = row.jiraCategory === "Done" ? "done" : row.jiraCategory === "In Progress" ? "prog" : "todo";
    const warn = row.ahead ? " warn" : "";
    const title = row.ahead ? "Jira is ahead of your status" : "Jira status";
    return `<span class="jl">Jira</span><span class="js ${cls}${warn}" title="${title}">${esc(row.jiraStatus)}${row.ahead ? " ⚠" : ""}</span>`;
  }

  function prioChip(p) {
    if (!p) return "";
    const cls = /^p[123]$/i.test(p) ? p.toLowerCase() : "p3";
    return `<span class="chip ${cls}">${esc(p)}</span>`;
  }

  function fmtTime(iso) {
    const d = new Date(iso);
    return isNaN(d) ? "" : d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  }

  function dayLabel(iso) {
    const d = new Date(iso);
    if (isNaN(d)) return iso;
    const today = new Date();
    const sameDay = (a, b) => a.toDateString() === b.toDateString();
    const yesterday = new Date(today);
    yesterday.setDate(today.getDate() - 1);
    const label = d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: d.getFullYear() === today.getFullYear() ? undefined : "numeric" });
    if (sameDay(d, today)) return `Today, ${label}`;
    if (sameDay(d, yesterday)) return `Yesterday, ${label}`;
    return label;
  }

  const isOpen = (t) => OPEN_STATUSES.includes(t.status);

  /** Tickets of the current group (all of them when the group is All). */
  function groupTickets() {
    const all = state.overview.tickets;
    return state.group ? all.filter((t) => t.group === state.group) : all;
  }

  function byFilter(rows, f) {
    if (f.startsWith("status:")) return rows.filter((t) => t.status === f.slice(7));
    if (f === "all") return rows.filter((t) => t.status !== "archived");
    return rows.filter(isOpen);
  }

  function visibleTickets() {
    let rows = byFilter(groupTickets(), state.filter);
    const q = state.query.trim().toLowerCase();
    if (q) rows = rows.filter((t) => `${t.key} ${t.title} ${t.assignee}`.toLowerCase().includes(q));
    return rows;
  }

  function filterTitle() {
    const f = state.filter;
    const what = f.startsWith("status:") ? STATUS_LABELS[f.slice(7)] || f.slice(7) : f === "open" ? "Open" : "";
    return (state.group || "All") + (what ? ` · ${what}` : "");
  }

  /** A group that no longer exists (deleted, or its last ticket moved away) falls back to All. */
  function normalizeGroup() {
    if (state.group && !state.overview.groups.some((g) => g.name === state.group)) {
      state.group = "";
      save(GROUP_KEY, "");
    }
  }

  /**
   * Rows as a flat list of tree nodes. A child whose parent is not among the rows (missing from the
   * vault, other group, filtered out) is a root, so no ticket is ever hidden by its parent.
   */
  function buildTree(rows) {
    const keys = new Set(rows.map((r) => r.key));
    const kids = new Map();
    const roots = [];
    for (const r of rows) {
      if (r.parent && r.parent !== r.key && keys.has(r.parent)) {
        if (!kids.has(r.parent)) kids.set(r.parent, []);
        kids.get(r.parent).push(r);
      } else roots.push(r);
    }
    const out = [];
    const seen = new Set();
    const walk = (r, depth, hidden) => {
      if (seen.has(r.key)) return;
      seen.add(r.key);
      const ch = kids.get(r.key) || [];
      const folded = state.collapsed.has(r.key);
      if (!hidden) out.push({ row: r, depth, kids: ch.length, folded });
      for (const c of ch) walk(c, depth + 1, hidden || folded);
    };
    for (const r of roots) walk(r, 0, false);
    // Rows left over sit in a hand-made parent cycle: show them at the root.
    for (const r of rows) walk(r, 0, false);
    return out;
  }

  // ---------- pane 1: nav ----------

  function renderNav() {
    const o = state.overview;
    const all = o.tickets;
    const scoped = groupTickets();
    const unreadOf = (rows) => rows.reduce((n, t) => n + (t.unread ? 1 : 0), 0);
    const badges = (open, unread) =>
      `<span class="n">${open}</span>` + (unread ? `<span class="u" title="${unread} unread">${unread}</span>` : "");
    const item = (key, ico, label, rows) =>
      `<button class="nl${state.filter === key ? " on" : ""}" data-filter="${esc(key)}"><span class="ico">${ico}</span>${esc(label)}${badges(rows.length, unreadOf(rows))}</button>`;
    const groupRow = (name, label, open, unread, removable) => {
      const on = state.group === name;
      if (name && state.confirmGroup === name) {
        return `<div class="nl grp on" data-group="${esc(name)}"><span class="gn">Delete “${esc(name)}”?</span>` +
          `<span class="yn"><button class="btn" data-gdel="yes">Yes</button><button class="btn ghost" data-gdel="no">No</button></span></div>`;
      }
      return `<div class="nl grp${on ? " on" : ""}" role="button" tabindex="0" data-group="${esc(name)}"${name ? " data-drop" : ""}>` +
        `<span class="ico">${name ? "▦" : "◧"}</span><span class="gn">${esc(label)}</span>${badges(open, unread)}` +
        (removable ? `<button class="gx" data-gx="${esc(name)}" title="Delete group (tickets stay)" aria-label="Delete group ${esc(name)}">×</button>` : "") + "</div>";
    };
    let h = `<div class="brand">${ICON.logo}Local Flow<span class="sync" title="Last sync">${o.lastSync ? "Synced " + fmtTime(o.lastSync) : ""}</span></div>`;
    h += `<h5>Groups<button class="plus" id="addgroup" title="New group" aria-label="New group">+</button></h5><div id="newgroup"></div>`;
    h += groupRow("", "All", all.filter(isOpen).length, unreadOf(all), false);
    for (const g of o.groups) h += groupRow(g.name, g.name, g.open, g.unread, g.removable);
    h += "<h5>Status</h5>";
    h += item("all", "◧", "All", scoped.filter((t) => t.status !== "archived"));
    h += item("open", "◨", "All open", scoped.filter(isOpen));
    const marks = { inbox: "○", inprogress: "◐", inreview: "◑", done: "●" };
    for (const s of NAV_STATUSES) h += item(`status:${s}`, marks[s], STATUS_LABELS[s], scoped.filter((t) => t.status === s));
    if (state.filter === "status:archived" || scoped.some((t) => t.status === "archived")) {
      h += item("status:archived", "◌", "Archived", scoped.filter((t) => t.status === "archived"));
    }
    h += `<h5>Notes</h5><div class="tree">${renderTree(o.notes, 0)}</div>`;
    h += `<div class="newnote" id="newnote"><button class="btn ghost" id="addnote">+ Note</button></div>`;
    $("nav").innerHTML = h;

    $("nav").querySelectorAll("[data-filter]").forEach((b) => {
      b.addEventListener("click", () => {
        state.filter = b.dataset.filter;
        save(FILTER_KEY, state.filter);
        renderNav();
        renderList();
      });
    });
    $("nav").querySelectorAll(".grp[data-group]").forEach((row) => {
      const pick = () => {
        state.group = row.dataset.group;
        state.confirmGroup = null;
        save(GROUP_KEY, state.group);
        renderNav();
        renderList();
      };
      row.addEventListener("click", (e) => {
        if (e.target.closest(".gx, [data-gdel]")) return;
        pick();
      });
      row.addEventListener("keydown", (e) => {
        if (e.target === row && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); pick(); }
      });
    });
    $("nav").querySelectorAll(".gx").forEach((b) => b.addEventListener("click", () => {
      state.confirmGroup = b.dataset.gx;
      renderNav();
    }));
    $("nav").querySelectorAll("[data-gdel]").forEach((b) => b.addEventListener("click", async () => {
      const name = state.confirmGroup;
      state.confirmGroup = null;
      if (b.dataset.gdel === "yes" && name) {
        try {
          await api("POST", "/api/group/delete", { name });
          if (state.group === name) { state.group = ""; save(GROUP_KEY, ""); }
          await loadOverview();
          return;
        } catch (err) { toast(err.message); }
      }
      renderNav();
    }));
    $("addgroup").addEventListener("click", () => inlineInput($("newgroup"), {
      placeholder: "group name",
      restore: renderNav,
      onSubmit: async (name) => {
        await api("POST", "/api/group", { name });
        await loadOverview();
      },
    }));
    $("nav").querySelectorAll("[data-note]").forEach((b) => {
      b.addEventListener("click", () => go(`#/n/${b.dataset.note}`));
    });
    $("addnote").addEventListener("click", () => inlineInput($("newnote"), {
      placeholder: "note name",
      restore: renderNav,
      onSubmit: async (name) => {
        const r = await api("POST", "/api/note", { folder: "", name });
        await loadOverview();
        go(`#/n/${r.path}`);
      },
    }));
  }

  function renderTree(nodes, depth) {
    const pad = `padding-left:${8 + depth * 14}px`;
    let h = "";
    for (const n of nodes) {
      if (n.dir) {
        h += `<div class="nl" style="${pad}"><span class="ico">▾</span><span class="d">${esc(n.name)}</span></div>`;
        h += renderTree(n.children || [], depth + 1);
      } else {
        const on = state.route.kind === "note" && state.route.rel === n.rel;
        h += `<button class="nl${on ? " on" : ""}" style="${pad}" data-note="${esc(n.rel)}" title="${esc(n.rel)}">${esc(n.name)}</button>`;
      }
    }
    return h;
  }

  /** True while a drag or an inline input is active: live refresh must not redraw under it. */
  function busy() {
    return !!state.dragKey || !!document.querySelector("input.inl");
  }

  /** Runs the redraw that was postponed while busy(). */
  function flushPending() {
    if (state.pending && !busy()) { state.pending = false; refresh(); }
  }

  /**
   * Replaces a container's content with a text input. Enter submits (a failure shows a toast and
   * keeps the input open), Escape or leaving it empty calls opts.restore to redraw the container.
   */
  function inlineInput(container, opts) {
    container.innerHTML = `<input type="text" class="inl" placeholder="${esc(opts.placeholder)}" value="${esc(opts.value || "")}">`;
    const input = container.querySelector("input");
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      opts.restore();
      flushPending();
    };
    input.addEventListener("keydown", async (e) => {
      if (e.key === "Escape") { e.preventDefault(); close(); return; }
      if (e.key !== "Enter" || !input.value.trim() || input.disabled) return;
      input.disabled = true;
      try {
        await opts.onSubmit(input.value.trim());
        closed = true;
        flushPending();
      } catch (err) {
        toast(err.message);
        input.disabled = false;
        input.focus();
      }
    });
    input.addEventListener("blur", () => { if (!input.value.trim() && !input.disabled) close(); });
    input.focus();
    if (opts.select) input.setSelectionRange(0, opts.select);
  }

  // ---------- pane 2: list ----------

  function renderList() {
    const rows = visibleTickets();
    const selected = state.route.kind === "ticket" ? state.route.key : null;
    // Search results stay flat; otherwise the list is a tree under the manual `parent:` links.
    const flat = !!state.query.trim();
    const nodes = flat ? rows.map((row) => ({ row, depth: 0, kids: 0, folded: false })) : buildTree(rows);
    const treeMode = !flat && rows.some((t) => t.parent);
    let h = `<div class="lh"><div class="t">${esc(filterTitle())}<span>${rows.length} ticket${rows.length === 1 ? "" : "s"}</span></div>` +
      `<div class="search">${ICON.mag}<input id="q" type="search" placeholder="Search key, title, person" value="${esc(state.query)}"><kbd>⌘K</kbd></div></div><div class="scroll" id="listscroll">`;
    if (!rows.length) h += `<div class="empty">Nothing here.</div>`;
    for (const { row: t, depth, kids, folded } of nodes) {
      const chev = !treeMode ? "" : kids
        ? `<span class="chev" data-toggle="${esc(t.key)}" title="${folded ? "Expand" : "Collapse"}">${folded ? "▸" : "▾"}</span>`
        : `<span class="chev sp"></span>`;
      h += `<div class="li${t.key === selected ? " on" : ""}" role="button" tabindex="0" draggable="true" data-key="${esc(t.key)}" style="padding-left:${14 + depth * 16}px">` +
        `<div class="r1">${chev}<span class="key">${esc(t.key)}</span>${prioChip(t.priority)}${folded ? `<span class="kids" title="${kids} nested">${kids}</span>` : ""}</div>` +
        (t.unread ? `<span class="dot" title="${t.unread} unread change${t.unread === 1 ? "" : "s"}"></span>` : "<span></span>") +
        `<div class="ti">${esc(t.title)}</div>` +
        `<div class="r3">${jiraChip(t)}${!t.mine && t.assignee ? `<span>${esc(t.assignee)}</span>` : ""}</div></div>`;
    }
    h += `<div class="unnest">Drop here to un-nest</div>`;
    $("list").innerHTML = h + "</div>";
    const q = $("q");
    q.addEventListener("input", () => {
      state.query = q.value;
      const pos = q.selectionStart;
      renderList();
      const nq = $("q");
      nq.focus();
      nq.setSelectionRange(pos, pos);
    });
    $("list").querySelectorAll("[data-key]").forEach((b) => {
      b.addEventListener("click", (e) => {
        const toggle = e.target.closest("[data-toggle]");
        if (toggle) {
          const k = toggle.dataset.toggle;
          if (state.collapsed.has(k)) state.collapsed.delete(k); else state.collapsed.add(k);
          save(COLLAPSED_KEY, JSON.stringify([...state.collapsed]));
          keepScroll($("listscroll"), renderList);
          return;
        }
        go(`#/t/${b.dataset.key}`);
      });
      b.addEventListener("keydown", (e) => {
        if (e.target === b && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); go(`#/t/${b.dataset.key}`); }
      });
    });
  }

  // ---------- drag & drop ----------
  // A ticket row can be dropped on another row (nest it), on the empty part of the list or the
  // "un-nest" strip (clear its parent), or on a group in the nav (move it there). One set of
  // delegated listeners on the panes, so redrawing the lists never loses them.

  function setDrop(el) {
    if (state.dropEl === el) return;
    if (state.dropEl) state.dropEl.classList.remove("drop");
    state.dropEl = el;
    if (el) el.classList.add("drop");
  }

  function endDrag() {
    state.dragKey = null;
    setDrop(null);
    $("list").classList.remove("dragging");
    document.querySelectorAll(".li.dragging").forEach((el) => el.classList.remove("dragging"));
    flushPending();
  }

  /** The element a drop would land on, or null when the drop is not allowed. */
  function dropTarget(e) {
    if (!state.dragKey) return null;
    const row = e.target.closest(".li");
    if (row) return row.dataset.key !== state.dragKey ? row : null;
    const group = e.target.closest("[data-drop]");
    if (group) return group;
    const scroll = e.target.closest("#listscroll");
    return scroll || null;
  }

  async function dropTicket(key, el) {
    try {
      const me = state.overview.tickets.find((t) => t.key === key);
      if (el.matches(".li")) {
        if (me && me.parent !== el.dataset.key) await api("POST", "/api/ticket-parent", { key, parent: el.dataset.key });
      } else if (el.matches("[data-drop]")) {
        if (me && me.group !== el.dataset.group) await api("POST", "/api/ticket-group", { key, group: el.dataset.group });
      } else if (me && me.parent) {
        await api("POST", "/api/ticket-parent", { key, parent: null });
      }
      await loadOverview();
    } catch (err) { toast(err.message); }
  }

  function initDragAndDrop() {
    const list = $("list");
    list.addEventListener("dragstart", (e) => {
      const row = e.target.closest ? e.target.closest(".li") : null;
      if (!row) return;
      state.dragKey = row.dataset.key;
      e.dataTransfer.setData(TICKET_DRAG, state.dragKey);
      e.dataTransfer.setData("text/plain", state.dragKey);
      e.dataTransfer.effectAllowed = "move";
      // Class changes right in dragstart can cancel the drag in some browsers: defer them.
      const key = state.dragKey;
      setTimeout(() => {
        if (state.dragKey !== key) return; // the drag already ended
        row.classList.add("dragging");
        list.classList.add("dragging");
      }, 0);
    });
    for (const pane of [list, $("nav")]) {
      pane.addEventListener("dragover", (e) => {
        const el = dropTarget(e);
        if (!el) { setDrop(null); return; }
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        setDrop(el);
      });
      pane.addEventListener("dragleave", (e) => {
        if (!pane.contains(e.relatedTarget)) setDrop(null);
      });
      pane.addEventListener("drop", (e) => {
        const el = dropTarget(e);
        if (!el) return;
        e.preventDefault();
        const key = state.dragKey;
        endDrag();
        if (key) dropTicket(key, el);
      });
    }
    document.addEventListener("dragend", endDrag);
  }

  // ---------- pane 3: folder ----------

  function renderFolder() {
    const t = state.ticket;
    const r = state.route;
    const unread = t.unread.length;
    let h = `<div class="fh">${ICON.folder}<b title="${esc(t.rel)}">${esc(t.rel.split("/").pop())}</b></div><div class="body">` +
      `<button class="pin${r.item === "task" ? " on" : ""}" data-item="task"><span class="pi">${ICON.task}</span><span class="pn">Original Task</span><span class="ps">${esc(t.row.key)} · ${t.row.source === "jira" ? "from Jira" : "local"}</span></button>` +
      `<button class="pin${r.item === "history" ? " on" : ""}" data-item="history"><span class="pi">${ICON.hist}</span><span class="pn">History</span><span class="ps" id="histcount">events</span>${unread ? `<span class="bd" title="${unread} unread">${unread}</span>` : ""}</button><hr>`;
    for (const f of t.files) {
      const isImg = /\.(png|jpe?g|gif|webp|svg)$/i.test(f);
      h += `<button class="fi${r.item === "file" && r.file === f ? " on" : ""}" data-file="${esc(f)}"><span class="ft">${isImg ? ICON.img : ICON.md}</span><span class="nm">${esc(f)}</span></button>`;
    }
    h += renderLinked(t);
    h += `</div><div class="foot" id="newfile"><button class="fi add" id="addfile"><span class="ft">+</span><span class="nm">File</span></button>` +
      `<button class="fi add" id="addlink" title="Link a folder outside the vault"><span class="ft">+</span><span class="nm">Link folder</span></button></div>`;
    $("folder").innerHTML = h;
    $("folder").querySelector('[data-item="task"]').addEventListener("click", () => go(`#/t/${t.row.key}`));
    $("folder").querySelector('[data-item="history"]').addEventListener("click", () => go(`#/t/${t.row.key}/history`));
    $("folder").querySelectorAll("[data-file]").forEach((b) => b.addEventListener("click", () => go(`#/t/${t.row.key}/f/${b.dataset.file}`)));
    wireLinked(t);
    $("addlink").addEventListener("click", () => inlineInput($("newfile"), {
      placeholder: "/absolute/path/to/folder",
      restore: renderFolder,
      onSubmit: async (folder) => {
        const res = await api("POST", "/api/link", { key: t.row.key, path: folder });
        if (!res.added) toast(`${res.path} is already linked`, true);
        state.ticket = await api("GET", `/api/ticket/${t.row.key}`);
        renderFolder();
      },
    }));
    $("addfile").addEventListener("click", () => {
      const stem = `note-${new Date().toLocaleDateString("sv-SE")}`;
      inlineInput($("newfile"), {
        placeholder: "file name (.md)",
        value: `${stem}.md`,
        select: stem.length,
        restore: renderFolder,
        onSubmit: async (name) => {
          const res = await api("POST", "/api/ticket-file", { key: t.row.key, name });
          state.ticket = await api("GET", `/api/ticket/${t.row.key}`);
          state.pendingEdit = res.path;
          go(`#/t/${t.row.key}/f/${res.path.split("/").pop()}`);
        },
      });
    });
  }

  /** Linked folders below the ticket's own files: external content, labelled and foldable. */
  function renderLinked(t) {
    const r = state.route;
    let h = "";
    for (const f of t.linked || []) {
      const folded = state.linkedCollapsed.has(f.path);
      h += `<div class="lk"><div class="lkh" role="button" tabindex="0" data-lktoggle="${esc(f.path)}" title="${esc(f.path)}">` +
        `<span class="chev">${folded ? "▸" : "▾"}</span><span class="ft">${ICON.folder}</span><span class="nm">${esc(f.name)}</span>` +
        `<span class="lktag">linked</span><button class="gx" data-unlink="${esc(f.path)}" title="Unlink (the folder stays on disk)" aria-label="Unlink ${esc(f.name)}">×</button></div>`;
      if (!folded) {
        if (f.error) h += `<div class="lkerr">${esc(f.error)}</div>`;
        else if (!f.files.length) h += `<div class="lkerr">no files</div>`;
        for (const x of f.files) {
          h += `<button class="fi lkf${r.item === "linked" && r.file === x.path ? " on" : ""}" data-lfile="${esc(x.path)}" title="${esc(x.path)}">` +
            `<span class="ft">${ICON.md}</span><span class="nm">${esc(x.name)}</span></button>`;
        }
      }
      h += `</div>`;
    }
    return h;
  }

  function wireLinked(t) {
    const folder = $("folder");
    folder.querySelectorAll("[data-lktoggle]").forEach((row) => {
      const toggle = () => {
        const p = row.dataset.lktoggle;
        if (state.linkedCollapsed.has(p)) state.linkedCollapsed.delete(p); else state.linkedCollapsed.add(p);
        save(LINKED_COLLAPSED_KEY, JSON.stringify([...state.linkedCollapsed]));
        keepScroll(folder.querySelector(".body"), renderFolder);
      };
      row.addEventListener("click", (e) => { if (!e.target.closest("[data-unlink]")) toggle(); });
      row.addEventListener("keydown", (e) => {
        if (e.target === row && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); toggle(); }
      });
    });
    folder.querySelectorAll("[data-unlink]").forEach((b) => b.addEventListener("click", async () => {
      try {
        await api("POST", "/api/unlink", { key: t.row.key, path: b.dataset.unlink });
        state.ticket = await api("GET", `/api/ticket/${t.row.key}`);
        if (state.route.item === "linked" && state.route.file.startsWith(b.dataset.unlink + "/")) go(`#/t/${t.row.key}`);
        else renderFolder();
      } catch (err) { toast(err.message); }
    }));
    folder.querySelectorAll("[data-lfile]").forEach((b) => b.addEventListener("click", () => go(`#/t/${t.row.key}/x/${encodeURIComponent(b.dataset.lfile)}`)));
  }

  // ---------- pane 4: ticket mirror ----------

  function sinceStrip(t) {
    if (!t.unread.length) return "";
    const since = t.seenDate ? ` since ${new Date(t.seenDate).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}` : "";
    const summary = t.unread.map((e) => e.text).join(", ");
    return `<div class="since">${ICON.spark}<span class="t"><b>${t.unread.length} new${since}:</b> ${esc(summary)}</span><button class="btn" id="seen">Mark seen</button></div>`;
  }

  const syncLabel = (busy) => (busy ? '<span class="spin"></span>Syncing…' : "Sync");

  /** Fetches one ticket from Jira (the server runs the sync in process); the change feed redraws the page. */
  async function syncNow(key) {
    if (state.syncKey) return;
    state.syncKey = key;
    const paint = () => {
      const b = $("syncbtn");
      if (!b) return;
      b.disabled = !!state.syncKey;
      b.classList.toggle("busy", state.syncKey === key);
      b.innerHTML = syncLabel(state.syncKey === key);
    };
    paint();
    try {
      const r = await api("POST", "/api/sync", { key });
      const warn = r.warnings.length ? ` (${r.warnings.join("; ")})` : "";
      toast(r.result === "updated" ? `${key} updated: ${r.events.join(", ") || "re-rendered"}${warn}` : `${key} unchanged${warn}`, true, 4000);
    } catch (err) {
      toast(err.message, false, 9000);
    } finally {
      state.syncKey = null;
      paint();
    }
  }

  function ticketHeader(t) {
    const r = t.row;
    const statusOpts = state.overview.statuses.map((s) => `<option value="${s}"${s === r.status ? " selected" : ""}>${STATUS_LABELS[s] || s}</option>`).join("");
    return `<div class="th"><div class="k"><span class="key">${esc(r.key)}</span>${r.type ? `<span class="chip type">${esc(r.type)}</span>` : ""}` +
      `<span class="ro">${r.source === "jira" ? "ticket.md, read-only" : "local ticket"}</span></div>` +
      `<h1>${esc(r.title)}</h1><div class="meta">` +
      `<span class="f">Status <select class="sel" id="mystatus" aria-label="Your status">${statusOpts}</select></span>` +
      `<span class="f">${jiraChip(r)}${r.ahead ? `<span class="jira-hint">Jira is ahead of you</span>` : ""}</span>` +
      (r.priority ? `<span class="f">${prioChip(r.priority)}</span>` : "") +
      (r.assignee ? `<span class="f">${esc(r.mine ? "You" : r.assignee)}</span>` : "") +
      (r.source === "jira" && state.overview.canSync ? `<button class="btn sync${state.syncKey === r.key ? " busy" : ""}" id="syncbtn" title="Fetch this ticket from Jira now (read-only)"${state.syncKey ? " disabled" : ""}>${syncLabel(state.syncKey === r.key)}</button>` : "") +
      (safeUrl(t.fm.jira_url) ? `<a class="ext" href="${safeUrl(t.fm.jira_url)}" target="_blank" rel="noopener">Open in Jira ↗</a>` : "") +
      `</div></div>`;
  }

  function wireHeader(t) {
    const sel = $("mystatus");
    if (sel) sel.addEventListener("change", async () => {
      try {
        await api("POST", "/api/status", { key: t.row.key, status: sel.value });
        await reloadTicket();
      } catch (err) { toast(err.message); }
    });
    const syncBtn = $("syncbtn");
    if (syncBtn) syncBtn.addEventListener("click", () => syncNow(t.row.key));
    const seen = $("seen");
    if (seen) seen.addEventListener("click", async () => {
      try {
        await api("POST", "/api/seen", { key: t.row.key });
        await reloadTicket();
      } catch (err) { toast(err.message); }
    });
  }

  async function reloadTicket() {
    state.ticket = await api("GET", `/api/ticket/${state.route.key}`);
    await loadOverview();
    renderFolder();
    renderContent();
  }

  function renderMirror(t) {
    let h = sinceStrip(t) + ticketHeader(t) + `<div class="scroll"><div class="mirror">`;
    for (const b of t.blocks) {
      h += `<div class="blk ${b.state}"><div class="md">${b.html}</div>` +
        (b.was ? `<div class="was">was: <div class="md">${b.was}</div></div>` : "") + `</div>`;
    }
    $("content").innerHTML = h + `</div></div>`;
    wireHeader(t);
  }

  async function renderHistory(t) {
    let events;
    try { events = (await api("GET", `/api/ticket/${t.row.key}/history`)).events; } catch (err) { toast(err.message); return; }
    let h = sinceStrip(t) + `<div class="scroll"><div class="hist"><div class="hh"><h2>History</h2><span>${esc(t.row.key)}, newest first</span></div>`;
    if (!events.length) h += `<div class="empty">No sync events recorded for this ticket.</div>`;
    let day = "";
    for (const e of events) {
      const d = e.date.slice(0, 10);
      if (d !== day) { day = d; h += `<div class="day">${esc(dayLabel(e.date))}</div>`; }
      h += `<div class="ev${e.unread ? " unread" : ""}"><span class="ud"></span><div class="tx">${esc(e.text)}<span class="via">${esc(e.via)}</span></div><time>${fmtTime(e.date)}</time></div>`;
    }
    h += `<p class="src">Built from sync commits in the vault history.</p></div></div>`;
    $("content").innerHTML = h;
    const c = $("histcount");
    if (c) c.textContent = `${events.length} event${events.length === 1 ? "" : "s"}`;
    wireHeader(t);
  }

  // ---------- pane 4: editor ----------

  class Editor {
    constructor(view, opts) {
      this.rel = view.rel;
      this.head = view.head;
      this.editable = view.editable;
      this.blocks = view.blocks.map((b) => ({ src: b.src, html: b.html }));
      if (!this.blocks.length) this.blocks.push({ src: "", html: "" });
      this.active = -1;
      this.dirty = false;
      this.saveTimer = 0;
      this.savedAt = opts.savedAt || "";
      this.title = opts.title;
      this.props = opts.props || "";
      this.viewUrl = opts.viewUrl || `/api/file?path=${encodeURIComponent(this.rel)}`;
      this.render();
    }

    render() {
      // Files open read-only so text can be selected and copied; "Edit" (or a double-click on a
      // block) switches to editing, "Done" switches back and saves.
      const hint = this.editable
        ? `<span class="hint" id="savehint"></span><button class="btn" id="editmode">Edit</button>`
        : `<span class="hint">read-only</span>`;
      let h = `<div class="eh"><span class="path">${this.title}</span>${hint}</div>${this.props}` +
        `<div class="scroll"><div class="doc" id="doc">`;
      this.blocks.forEach((b, i) => { h += `<div class="blk" data-i="${i}">${this.paintHtml(b)}</div>`; });
      $("content").innerHTML = h + `</div></div>`;
      this.doc = $("doc");
      this.editing = false;
      this.updateHint();
      if (this.editable) {
        $("editmode").addEventListener("click", () => this.setEditing(!this.editing));
        const blockAt = (e) => {
          if (e.target.closest("a, input, button")) return null;
          const blk = e.target.closest(".blk");
          return blk && !blk.classList.contains("editing") ? Number(blk.dataset.i) : null;
        };
        this.doc.addEventListener("click", (e) => {
          if (!this.editing) return;
          const sel = window.getSelection();
          if (sel && !sel.isCollapsed && sel.toString().length > 0) return;
          const i = blockAt(e);
          if (i !== null) this.edit(i, "end");
        });
        this.doc.addEventListener("dblclick", (e) => {
          if (this.editing) return;
          const i = blockAt(e);
          if (i === null) return;
          window.getSelection()?.removeAllRanges();
          this.setEditing(true);
          this.edit(i, "end");
        });
      }
    }

    setEditing(on) {
      this.editing = on;
      this.doc.classList.toggle("rw", on);
      const b = $("editmode");
      if (b) { b.textContent = on ? "Done" : "Edit"; b.classList.toggle("primary", on); }
      if (!on) {
        if (this.active >= 0) this.leave();
        if (this.dirty) this.save();
      }
      this.updateHint();
    }

    paintHtml(b) {
      return b.src.trim() ? `<div class="md">${b.html}</div>` : `<p class="ph">Type here…</p>`;
    }

    blockEl(i) { return this.doc.querySelector(`.blk[data-i="${i}"]`); }

    /** Rebuilds the block elements from this.blocks (no block is being edited when called). */
    repaint() {
      this.doc.innerHTML = this.blocks.map((b, i) => `<div class="blk" data-i="${i}">${this.paintHtml(b)}</div>`).join("");
    }

    edit(i, caret) {
      if (i < 0 || i >= this.blocks.length) return;
      if (this.active >= 0) this.leave();
      const el = this.blockEl(i);
      const ta = document.createElement("textarea");
      ta.value = this.blocks[i].src;
      ta.spellcheck = false;
      el.classList.add("editing");
      el.innerHTML = "";
      el.appendChild(ta);
      this.active = i;
      const grow = () => { ta.style.height = "0"; ta.style.height = `${ta.scrollHeight}px`; };
      grow();
      ta.addEventListener("input", () => { grow(); this.markDirty(); });
      ta.addEventListener("keydown", (e) => this.onKey(e, i, ta));
      ta.addEventListener("blur", () => { if (this.active === i) this.leave(); });
      ta.focus();
      const pos = caret === "start" ? 0 : ta.value.length;
      ta.setSelectionRange(pos, pos);
    }

    /** Commits the active textarea back into this.blocks and re-renders that block. */
    leave() {
      const i = this.active;
      if (i < 0) return;
      this.active = -1;
      const el = this.blockEl(i);
      const ta = el && el.querySelector("textarea");
      if (!ta) return;
      const src = ta.value.replace(/\s+$/, "");
      const b = this.blocks[i];
      const changed = src !== b.src;
      b.src = src;
      el.classList.remove("editing");
      if (!src.trim() && this.blocks.length > 1) {
        this.blocks.splice(i, 1);
        this.repaint();
        if (changed) this.markDirty();
        return;
      }
      el.innerHTML = this.paintHtml(b);
      if (changed) {
        this.markDirty();
        api("POST", "/api/render", { src, path: this.rel }).then((r) => {
          b.html = r.html;
          const cur = this.blockEl(i);
          if (cur && !cur.classList.contains("editing") && this.blocks[i] === b) cur.innerHTML = this.paintHtml(b);
        }).catch((err) => toast(err.message));
      }
    }

    onKey(e, i, ta) {
      const v = ta.value;
      const s = ta.selectionStart;
      const lineStart = v.lastIndexOf("\n", s - 1) + 1;
      const lineEnd = v.indexOf("\n", s);
      const line = v.slice(lineStart, lineEnd < 0 ? v.length : lineEnd);
      if (e.key === "Escape") { e.preventDefault(); ta.blur(); return; }
      if (e.key === "Enter" && !e.shiftKey && !line.trim()) {
        // Enter on an empty line closes this block and opens a new one after it.
        e.preventDefault();
        const before = v.slice(0, lineStart).replace(/\s+$/, "");
        const after = v.slice(lineEnd < 0 ? v.length : lineEnd + 1).replace(/^\s+/, "");
        ta.value = before;
        this.leave();
        const at = before.trim() ? i + 1 : i;
        this.blocks.splice(at, 0, { src: after, html: "" });
        this.repaint();
        this.markDirty();
        this.edit(at, "start");
        return;
      }
      if (e.key === "Backspace" && v === "" && this.blocks.length > 1) {
        e.preventDefault();
        this.leave();
        this.edit(Math.max(0, i - 1), "end");
        return;
      }
      if (e.key === "ArrowUp" && lineStart === 0 && i > 0) { e.preventDefault(); this.leave(); this.edit(i - 1, "end"); return; }
      if (e.key === "ArrowDown" && lineEnd < 0 && i < this.blocks.length - 1) { e.preventDefault(); this.leave(); this.edit(i + 1, "start"); }
    }

    markDirty() {
      this.dirty = true;
      this.updateHint();
      clearTimeout(this.saveTimer);
      this.saveTimer = setTimeout(() => this.save(), 1000);
    }

    text() {
      const blocks = this.blocks.map((b, i) => {
        const el = this.blockEl(i);
        const ta = el && el.querySelector("textarea");
        return ta ? ta.value.replace(/\s+$/, "") : b.src;
      });
      return blocks.filter((s) => s.trim()).join("\n\n");
    }

    async save() {
      if (!this.editable || !this.dirty) return;
      clearTimeout(this.saveTimer);
      try {
        // Keep the blank line between the frontmatter and the body, as `lf` writes it.
        await api("PUT", "/api/file", { path: this.rel, body: this.text(), head: this.head ? `${this.head}\n` : "" });
        this.dirty = false;
        this.savedAt = fmtTime(new Date().toISOString());
        this.updateHint();
      } catch (err) { toast(err.message); }
    }

    /** True when the file on disk no longer matches what this editor was built from. */
    async changedOnDisk() {
      try {
        const view = await api("GET", this.viewUrl);
        return view.head !== this.head || view.blocks.map((b) => b.src).join("\n\n") !== this.text();
      } catch { return false; }
    }

    updateHint() {
      const el = $("savehint");
      if (!el) return;
      el.className = "hint" + (this.dirty ? " dirty" : "");
      const saved = this.savedAt ? "Saved " + esc(this.savedAt) : "Saved";
      el.innerHTML = this.dirty ? "Unsaved · <kbd>⌘S</kbd>" : this.editing ? `${saved} · <kbd>⌘S</kbd> to save` : `${saved} · double-click a block to edit`;
    }

    destroy() {
      clearTimeout(this.saveTimer);
      if (this.dirty) this.save();
    }
  }

  function propsStrip(view) {
    if (!/\/notes\.md$/.test(view.rel) || !view.editable) return "";
    const fm = view.fm;
    const statusOpts = state.overview.statuses.map((s) => `<option value="${s}"${s === fm.status ? " selected" : ""}>${esc(s)}</option>`).join("");
    const prio = String(fm.priority || "");
    const prioOpts = ["", "P1", "P2", "P3"].map((p) => `<option value="${p}"${p === prio ? " selected" : ""}>${p || "—"}</option>`).join("");
    return `<div class="props"><label>status <select class="sel" data-fm="status">${statusOpts}</select></label>` +
      `<label>priority <select class="sel" data-fm="priority">${prioOpts}</select></label>` +
      `<label>taken <input class="sel" type="date" data-fm="taken" value="${esc(fm.taken || "")}"></label>` +
      `<span class="fm">frontmatter of notes.md</span></div>`;
  }

  function wireProps(view) {
    $("content").querySelectorAll("[data-fm]").forEach((el) => {
      el.addEventListener("change", async () => {
        try {
          await api("POST", "/api/frontmatter", { path: view.rel, updates: { [el.dataset.fm]: el.value } });
          await loadOverview();
          if (state.route.kind === "ticket") {
            state.ticket = await api("GET", `/api/ticket/${state.route.key}`);
            renderFolder();
          }
        } catch (err) { toast(err.message); }
      });
    });
  }

  /** Opens a file in the viewer/editor. viewUrl replaces /api/file for files outside the vault. */
  async function openFile(rel, title, viewUrl) {
    if (!viewUrl && /\.(png|jpe?g|gif|webp|svg)$/i.test(rel)) {
      const url = "/raw/" + rel.split("/").map(encodeURIComponent).join("/");
      $("content").innerHTML = `<div class="eh"><span class="path">${title}</span></div><div class="imgview"><img src="${url}" alt="${esc(rel.split("/").pop())}"></div>`;
      return;
    }
    let view;
    try { view = await api("GET", viewUrl || `/api/file?path=${encodeURIComponent(rel)}`); } catch (err) { toast(err.message); return; }
    if (!/\.md$/i.test(rel)) {
      $("content").innerHTML = `<div class="eh"><span class="path">${title}</span><span class="hint">read-only</span></div><pre class="plain">${esc(view.blocks.map((b) => b.src).join("\n\n"))}</pre>`;
      return;
    }
    state.editor = new Editor(view, { title, props: propsStrip(view), viewUrl });
    wireProps(view);
    // A file just made with "+ File" opens ready to type under its heading.
    if (state.pendingEdit === rel && state.editor.editable) {
      state.pendingEdit = null;
      const ed = state.editor;
      ed.setEditing(true);
      if (ed.blocks[ed.blocks.length - 1].src.trim()) { ed.blocks.push({ src: "", html: "" }); ed.repaint(); }
      ed.edit(ed.blocks.length - 1, "end");
    }
  }

  // ---------- table of contents ----------
  // Built from the headings of whatever document the content pane shows (Jira mirror or a file),
  // and rebuilt when its blocks change (editing, live refresh).

  let tocObserver = null;

  function attachToc() {
    if (tocObserver) { tocObserver.disconnect(); tocObserver = null; }
    const scroll = $("content").querySelector(".scroll");
    const root = scroll && scroll.querySelector(":scope > .mirror, :scope > .doc");
    if (!root) return;
    let timer = 0;
    const build = () => {
      const old = scroll.querySelector(":scope > .toc");
      if (old) old.remove();
      const heads = [...root.querySelectorAll(".md h1, .md h2, .md h3, .md h4")].filter((h) => h.textContent.trim());
      scroll.classList.toggle("hastoc", heads.length >= 2);
      if (heads.length < 2) return;
      const base = Math.min(...heads.map((h) => Number(h.tagName[1])));
      const nav = document.createElement("nav");
      nav.className = "toc";
      nav.setAttribute("aria-label", "Contents");
      nav.innerHTML = "<h6>Contents</h6>" + heads.map((h, i) =>
        `<button data-h="${i}" style="padding-left:${8 + (Number(h.tagName[1]) - base) * 12}px" title="${esc(h.textContent.trim())}">${esc(h.textContent.trim())}</button>`).join("");
      nav.querySelectorAll("[data-h]").forEach((b) => b.addEventListener("click", () => {
        const h = heads[Number(b.dataset.h)];
        scroll.scrollTo({ top: scroll.scrollTop + h.getBoundingClientRect().top - scroll.getBoundingClientRect().top - 12, behavior: "smooth" });
      }));
      scroll.appendChild(nav);
      const mark = () => {
        const top = scroll.getBoundingClientRect().top + 24;
        let cur = 0;
        heads.forEach((h, i) => { if (h.getBoundingClientRect().top <= top) cur = i; });
        nav.querySelectorAll("[data-h]").forEach((b) => b.classList.toggle("on", Number(b.dataset.h) === cur));
      };
      scroll.onscroll = mark;
      mark();
    };
    build();
    tocObserver = new MutationObserver(() => { clearTimeout(timer); timer = setTimeout(build, 150); });
    tocObserver.observe(root, { childList: true, subtree: true });
  }

  // ---------- resizable columns ----------
  // A handle sits on the right edge of each of the first three panes. Dragging sets the pane's
  // --w-* width (never below its minimum, and never squeezing the content pane below CONTENT_MIN);
  // a double-click returns it to the default. Widths are remembered per browser.

  function readWidths() {
    try {
      const v = JSON.parse(store(WIDTHS_KEY) || "{}");
      return v && typeof v === "object" ? v : {};
    } catch { return {}; }
  }

  function applyWidths() {
    const w = readWidths();
    for (const p of PANES) {
      if (Number.isFinite(w[p.id]) && w[p.id] >= p.min) $("app").style.setProperty(p.prop, `${Math.round(w[p.id])}px`);
      else $("app").style.removeProperty(p.prop);
    }
  }

  function placeHandles() {
    const left = $("app").getBoundingClientRect().left;
    for (const p of PANES) {
      const h = $("app").querySelector(`.rz[data-pane="${p.id}"]`);
      if (!h) continue;
      const pane = $(p.id);
      h.hidden = pane.hidden;
      if (!pane.hidden) h.style.left = `${pane.getBoundingClientRect().right - left}px`;
    }
  }

  function initResize() {
    applyWidths();
    for (const p of PANES) {
      const h = document.createElement("div");
      h.className = "rz";
      h.dataset.pane = p.id;
      h.title = "Drag to resize · double-click to reset";
      $("app").appendChild(h);
      h.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        h.setPointerCapture(e.pointerId);
        const startX = e.clientX;
        const startW = $(p.id).getBoundingClientRect().width;
        const max = Math.max(startW, startW + $("content").getBoundingClientRect().width - CONTENT_MIN);
        let w = startW;
        h.classList.add("on");
        document.body.classList.add("resizing");
        const move = (ev) => {
          w = Math.min(max, Math.max(p.min, startW + ev.clientX - startX));
          $("app").style.setProperty(p.prop, `${Math.round(w)}px`);
          placeHandles();
        };
        const up = () => {
          h.removeEventListener("pointermove", move);
          h.removeEventListener("pointerup", up);
          h.removeEventListener("pointercancel", up);
          h.classList.remove("on");
          document.body.classList.remove("resizing");
          save(WIDTHS_KEY, JSON.stringify({ ...readWidths(), [p.id]: Math.round(w) }));
        };
        h.addEventListener("pointermove", move);
        h.addEventListener("pointerup", up);
        h.addEventListener("pointercancel", up);
      });
      h.addEventListener("dblclick", () => {
        const w = readWidths();
        delete w[p.id];
        save(WIDTHS_KEY, JSON.stringify(w));
        applyWidths();
        placeHandles();
      });
    }
    placeHandles();
    window.addEventListener("resize", placeHandles);
  }

  // ---------- routing ----------

  function closeEditor() {
    if (state.editor) { state.editor.destroy(); state.editor = null; }
  }

  async function renderContent() {
    await renderContentPane();
    attachToc();
  }

  async function renderContentPane() {
    closeEditor();
    const r = state.route;
    if (r.kind === "ticket") {
      const t = state.ticket;
      if (r.item === "history") return renderHistory(t);
      if (r.item === "file") {
        return openFile(`${t.rel}/${r.file}`, `<span class="key">${esc(t.row.key)}</span> / <b>${esc(r.file)}</b>`);
      }
      if (r.item === "linked") {
        const name = r.file.split("/").pop();
        const viewUrl = `/api/linked-file?key=${encodeURIComponent(t.row.key)}&path=${encodeURIComponent(r.file)}`;
        return openFile(r.file, `<span class="key">${esc(t.row.key)}</span> / <span class="lktag">linked</span> <b title="${esc(r.file)}">${esc(name)}</b>`, viewUrl);
      }
      // A local ticket's ticket.md belongs to the user, so it opens in the editor.
      if (t.row.source === "local") return openFile(`${t.rel}/ticket.md`, `<span class="key">${esc(t.row.key)}</span> / <b>ticket.md</b>`);
      return renderMirror(t);
    }
    if (r.kind === "note") {
      const parts = r.rel.split("/");
      return openFile(r.rel, `${esc(parts.slice(0, -1).join(" / "))} / <b>${esc(parts[parts.length - 1])}</b>`);
    }
    $("content").innerHTML = `<div class="empty">Pick a ticket on the left, or a note below the groups.</div>`;
  }

  async function onRoute() {
    const prev = state.route;
    state.route = parseHash();
    const r = state.route;
    if (r.kind === "ticket") {
      if (!state.ticket || state.ticket.row.key !== r.key || prev.kind !== "ticket") {
        try { state.ticket = await api("GET", `/api/ticket/${r.key}`); } catch (err) { toast(err.message); state.route = { kind: "none" }; }
      }
    }
    const showFolder = state.route.kind === "ticket";
    $("folder").hidden = !showFolder;
    $("app").classList.toggle("nofolder", !showFolder);
    placeHandles();
    renderNav();
    renderList();
    if (showFolder) renderFolder();
    await renderContent();
  }

  async function loadOverview() {
    state.overview = await api("GET", "/api/overview");
    normalizeGroup();
    renderNav();
    renderList();
  }

  document.addEventListener("keydown", (e) => {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === "s") {
      e.preventDefault();
      if (state.editor) state.editor.save().then(() => { if (state.editor && !state.editor.dirty) toast("Saved", true); });
    }
    if (mod && e.key.toLowerCase() === "k") {
      e.preventDefault();
      const q = $("q");
      if (q) { q.focus(); q.select(); }
    }
  });
  window.addEventListener("hashchange", () => { onRoute().catch((err) => toast(err.message)); });
  window.addEventListener("beforeunload", () => closeEditor());

  // ---------- live updates ----------
  // The server long-polls /api/changes against a file watcher. On a change the panes are
  // redrawn in place: the search box keeps its text and focus, the lists keep their scroll
  // position, and a file being edited (or with unsaved text) is left alone.

  function keepScroll(el, fn) {
    const top = el ? el.scrollTop : 0;
    fn();
    if (el) el.scrollTop = top;
  }

  async function refresh() {
    // A drag or an inline input in progress must not be redrawn away: catch up when it ends.
    if (busy()) { state.pending = true; return; }
    const q = $("q");
    const search = q && document.activeElement === q ? { pos: q.selectionStart } : null;
    try { state.overview = await api("GET", "/api/overview"); } catch (err) { toast(err.message); return; }
    if (busy()) { state.pending = true; return; }
    normalizeGroup();
    renderNav();
    keepScroll($("list").querySelector(".scroll"), renderList);
    if (search) { const nq = $("q"); nq.focus(); nq.setSelectionRange(search.pos, search.pos); }

    const r = state.route;
    const ed = state.editor;
    const redraw = async () => {
      const content = $("content").querySelector(".scroll");
      const top = content ? content.scrollTop : 0;
      await renderContent();
      const again = $("content").querySelector(".scroll");
      if (again) again.scrollTop = top;
    };
    // The content pane is redrawn only when what it shows actually changed, so a text selection
    // or an open editor survives unrelated changes elsewhere in the vault.
    if (r.kind === "ticket") {
      let fresh;
      try { fresh = await api("GET", `/api/ticket/${r.key}`); } catch { return; }
      const changed = JSON.stringify(fresh) !== JSON.stringify(state.ticket);
      if (busy()) { state.pending = true; return; }
      state.ticket = fresh;
      if (changed) keepScroll($("folder").querySelector(".body"), renderFolder);
      if (ed) { if (!ed.editing && !ed.dirty && await ed.changedOnDisk()) await redraw(); }
      else if (changed) await redraw();
    } else if (r.kind === "note" && ed && !ed.editing && !ed.dirty && await ed.changedOnDisk()) {
      await redraw();
    }
  }

  async function watchChanges() {
    let since = 0;
    for (;;) {
      try {
        const { version } = await api("GET", `/api/changes?since=${since}`);
        if (since && version > since) await refresh();
        since = version;
      } catch {
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  }

  initDragAndDrop();
  initResize();
  loadOverview()
    .then(onRoute)
    .then(() => { watchChanges(); })
    .catch((err) => {
      $("content").innerHTML = `<div class="empty">Cannot load the vault: ${esc(err.message)}</div>`;
      toast(err.message);
    });
})();
