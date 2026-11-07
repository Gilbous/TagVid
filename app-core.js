"use strict";

/* Logique pure de TagVid — sans DOM ni IndexedDB (testable avec Node) */

const VIDEO_EXT = ["mp4","webm","mov","mkv","avi","m4v","ogv","ogg","mpg","mpeg","3gp","wmv","flv"];

const NB_GROUPS = 4;

const state = {
  root: null,
  files: [],        // {handle, path, name, dir, size, ext}
  tags: new Map(),  // path -> [Set × NB_GROUPS]
  selected: Array.from({length: NB_GROUPS}, () => new Set()),
  letterSel: Array(NB_GROUPS).fill(null),
  groupSearch: Array(NB_GROUPS).fill(""),
  groupsOpen: new Set([0]),
  groupMode: Array(NB_GROUPS).fill("or"),
  noTag: new Set(),
  ratings: new Map(),
  minRating: 0,
  sortByRating: false,
  mosaicPending: false,
  mosaicSig: null,
  filterSig: null,
  view: "table",
  visible: [],
  viewerIndex: -1,
  collapsed: new Set(),
  dirs: new Map(),
  rootName: "",
  autoBackup: false,
};

const dbKey = p => state.rootName + "\u0000" + p;

const emptyGroups = () => Array.from({length: NB_GROUPS}, () => new Set());

function tagsOf(path) { return state.tags.get(path) || emptyGroups(); }

function normalizeKey(s) { return s.trim().toLocaleUpperCase("fr").normalize("NFD")[0] || "#"; }

function normalizeStored(v) {
  // Ancien format : liste de chaînes -> groupe 1. Nouveau : tableau de 4 tableaux.
  const groups = emptyGroups();
  if (Array.isArray(v)) {
    if (v.length > 0 && typeof v[0] === "string") {
      for (const t of v) groups[0].add(t);
    } else {
      for (let g = 0; g < NB_GROUPS; g++) {
        const arr = v[g];
        if (Array.isArray(arr)) for (const t of arr) groups[g].add(String(t));
      }
    }
  }
  return groups;
}

function allTags(g) {
  const s = new Set();
  for (const groups of state.tags.values()) for (const t of groups[g]) s.add(t);
  return [...s].sort((a, b) => a.localeCompare(b, "fr"));
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
}
function fmtSize(n) {
  if (!n) return "—";
  const u = ["o","Ko","Mo","Go"]; let i = 0;
  while (n >= 1024 && i < 3) { n /= 1024; i++; }
  return n.toFixed(i === 0 ? 0 : 1) + " " + u[i];
}

function fmtBytes(b) {
  if (!b) return "0 o";
  const u = ["o", "Ko", "Mo", "Go", "To"]; let i = 0;
  while (b >= 1024 && i < 4) { b /= 1024; i++; }
  return b.toFixed(i === 0 ? 0 : 1) + " " + u[i];
}

function fmtTimeRange(bytes) {
  const f = s => s < 60 ? `${Math.max(1, Math.round(s))} s` : `${Math.round(s / 60)} min`;
  return `${f(bytes / 400e6)} à ${f(bytes / 50e6)}`;
}

function fmtDuration(s) {
  if (!s || !isFinite(s)) return "";
  s = Math.round(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const mm = String(m).padStart(2, "0"), ss = String(sec).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}

function starsHTML(n, max) {
  let s = "";
  for (let i = 1; i <= max; i++) s += `<span class="${i <= n ? "on" : ""}">★</span>`;
  return `<span class="stars-inline">${s}</span>`;
}

function buildTree(files) {
  const root = { name: "", path: "", dirs: new Map(), files: [] };
  for (const f of files) {
    const parts = f.path.split("/");
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const p = parts.slice(0, i + 1).join("/") + "/";
      if (!node.dirs.has(parts[i])) node.dirs.set(parts[i], { name: parts[i], path: p, dirs: new Map(), files: [] });
      node = node.dirs.get(parts[i]);
    }
    node.files.push(f);
  }
  return root;
}

function countFiles(node) {
  let n = node.files.length;
  for (const d of node.dirs.values()) n += countFiles(d);
  return n;
}

function allDirPaths() {
  const s = new Set();
  for (const f of state.files) {
    const parts = f.path.split("/");
    for (let i = 1; i < parts.length; i++) s.add(parts.slice(0, i).join("/") + "/");
  }
  return s;
}

function applyFilter() {
  const active = [];
  for (let g = 0; g < NB_GROUPS; g++) if (state.selected[g].size > 0 || state.noTag.has(g)) active.push(g);
  state.filterSig = JSON.stringify([
    state.selected.map(s => [...s]),
    [...state.noTag],
    state.minRating,
    state.sortByRating,
    state.files.length,
  ]);
  if (active.length === 0 && state.minRating === 0) { state.visible = state.files.slice(); sortVisible(); return; }
  state.visible = state.files.filter(f => {
    if (state.minRating > 0 && (state.ratings.get(f.path) || 0) < state.minRating) return false;
    if (active.length === 0) return true;
    const groups = tagsOf(f.path);
    return active.every(g => {
      const sel = [...state.selected[g]];
      if (state.groupMode[g] === "and") return sel.every(t => groups[g].has(t));
      return sel.some(t => groups[g].has(t)) || (state.noTag.has(g) && groups[g].size === 0);
    });
  });
  sortVisible();
}

function sortVisible() {
  if (!state.sortByRating) return;
  state.visible.sort((a, b) => {
    const ra = state.ratings.get(a.path) || 0;
    const rb = state.ratings.get(b.path) || 0;
    if (rb !== ra) return rb - ra;
    return a.path.localeCompare(b.path, "fr", { numeric: true });
  });
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { VIDEO_EXT, NB_GROUPS, state, dbKey, emptyGroups, normalizeStored, tagsOf, allTags, normalizeKey, escapeHtml, fmtSize, fmtBytes, fmtTimeRange, fmtDuration, starsHTML, buildTree, countFiles, allDirPaths, applyFilter, sortVisible };
}
