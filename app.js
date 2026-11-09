"use strict";
const APP_JS_VERSION = "1.51";

/* Secours intégré : si libs/webm-mini.js n'a pas pu être chargé (chemin, corruption),
   le mini-multiplexeur est embarqué ici pour garantir l'export accéléré. */
if (typeof window.WebMMini === "undefined") {
/* Mini-multiplexeur WebM (vidéo seule : VP8 ou VP9) — spécifique TagVid, sans dépendance.
   Produit un conteneur WebM valide : en-tête EBML, Segment (taille inconnue), Info, Tracks,
   Clusters de SimpleBlocks. Durée backpatchée à la finalisation. */
window.WebMMini = (() => {

  function idBytes(hex) {
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
    return out;
  }
  function strBytes(s) {
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xFF;
    return out;
  }
  function vintLen(v) {
    let n = 1;
    while (v > 2 ** (7 * n) - 2) n++;
    return n;
  }
  function vint(v, len) {
    const n = len || vintLen(v);
    const b = new Uint8Array(n);
    if (n === 1) { b[0] = 0x80 | v; return b; }
    b[0] = (1 << (8 - n)) | ((v / 2 ** (8 * (n - 1))) & (2 ** (8 - n) - 1));
    for (let i = 1; i < n; i++) b[i] = (v / 2 ** (8 * (n - 1 - i))) & 0xFF;
    return b;
  }
  function el(idHex, payload) {
    if (payload instanceof Uint8Array) payload = [payload];
    let len = 0;
    for (const p of payload) len += p.length;
    return [idBytes(idHex), vint(len), ...payload];
  }

  class Muxer {
    constructor({ width, height, codec }) {
      this.parts = [];
      this.cur = null; this.curLen = 0;
      this.clusterTs = 0;
      this.lastTs = -1;
      this.durationSec = 0;
      this._push(...el("1A45DFA3", [
        ...el("4286", vint(1, 1)),
        ...el("42F7", vint(1, 1)),
        ...el("42F2", vint(4, 1)),
        ...el("42F3", vint(8, 1)),
        ...el("4282", strBytes("webm")),
        ...el("4287", vint(2, 1)),
        ...el("4285", vint(2, 1)),
      ]));
      this._push(idBytes("18538067"), new Uint8Array([0x01, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF]));
      this.durPart = new Uint8Array(8);
      this._push(...el("1549A966", [
        ...el("2AD7B1", vint(1000000)),
        ...el("4489", this.durPart),
        ...el("4D80", strBytes("TagVid")),
        ...el("5741", strBytes("TagVid")),
      ]));
      this._push(...el("1654AE6B", [
        ...el("AE", [
          ...el("D7", vint(1, 1)),
          ...el("73C5", vint(1, 1)),
          ...el("83", vint(1, 1)),
          ...el("86", strBytes(codec)),
          ...el("E0", [
            ...el("B0", vint(width)),
            ...el("BA", vint(height)),
          ]),
        ]),
      ]));
    }
    _push(...arrs) { for (const a of arrs) this.parts.push(a); }
    addFrame(data, keyFrame, tsMs) {
      tsMs = Math.round(tsMs);
      if (tsMs <= this.lastTs) return;
      let rel = this.cur ? tsMs - this.clusterTs : -1;
      if (!this.cur || rel > 8000 || (keyFrame && rel > 5000)) {
        this._closeCluster();
        this.clusterTs = tsMs;
        this.cur = []; this.curLen = 0;
        const tc = vint(tsMs);
        this.cur.push(idBytes("E7"), tc);
        this.curLen += 1 + tc.length;
      }
      rel = tsMs - this.clusterTs;
      const block = new Uint8Array(4 + data.length);
      block[0] = 0x81;
      block[1] = 0x40 | ((rel >> 8) & 0x3F);
      block[2] = rel & 0xFF;
      block[3] = keyFrame ? 0x80 : 0x00;
      block.set(data, 4);
      this.cur.push(idBytes("A3"), vint(block.length), block);
      this.curLen += 1 + vintLen(block.length) + block.length;
      this.lastTs = tsMs;
      this.durationSec = tsMs / 1000;
    }
    _closeCluster() {
      if (!this.cur) return;
      this.parts.push(idBytes("1F43B675"), vint(this.curLen), ...this.cur);
      this.cur = null;
    }
    finalize() {
      this._closeCluster();
      new DataView(this.durPart.buffer).setFloat64(0, this.durationSec, false);
      let total = 0;
      for (const p of this.parts) total += p.length;
      const out = new Uint8Array(total);
      let pos = 0;
      for (const p of this.parts) { out.set(p, pos); pos += p.length; }
      return out;
    }
  }

  return { Muxer };
})();

}

/* Interface, persistance et interactions — dépend de app-core.js (chargé avant) */


const $ = id => document.getElementById(id);
const status = msg => { $("status").textContent = msg; };

/* ---------- IndexedDB (tags + dossier racine + vignettes) ---------- */
let db = null;
function openDB() {
  return new Promise((res, rej) => {
    const rq = indexedDB.open("tagvid", 2);
    rq.onupgradeneeded = () => {
      const d = rq.result;
      if (!d.objectStoreNames.contains("tags")) d.createObjectStore("tags");
      if (!d.objectStoreNames.contains("meta")) d.createObjectStore("meta");
      if (!d.objectStoreNames.contains("thumbs")) d.createObjectStore("thumbs");
      if (!d.objectStoreNames.contains("ratings")) d.createObjectStore("ratings");
    };
    rq.onsuccess = () => { db = rq.result; res(db); };
    rq.onerror = () => rej(rq.error);
  });
}
function dbGetAll(store) {
  return new Promise((res, rej) => {
    const rq = db.transaction(store).objectStore(store).getAllKeys();
    rq.onsuccess = () => res(rq.result);
    rq.onerror = () => rej(rq.error);
  });
}
function dbGet(store, key) {
  return new Promise((res, rej) => {
    const rq = db.transaction(store).objectStore(store).get(key);
    rq.onsuccess = () => res(rq.result);
    rq.onerror = () => rej(rq.error);
  });
}
function dbPut(store, key, val) {
  return new Promise((res, rej) => {
    const tx = db.transaction(store, "readwrite");
    tx.objectStore(store).put(val, key);
    tx.oncomplete = res; tx.onerror = () => rej(tx.error);
  });
}
function dbDelete(store, key) {
  return new Promise((res, rej) => {
    const tx = db.transaction(store, "readwrite");
    tx.objectStore(store).delete(key);
    tx.oncomplete = res; tx.onerror = () => rej(tx.error);
  });
}
async function dbClear(store) {
  const keys = await dbGetAll(store);
  await Promise.all(keys.map(k => dbDelete(store, k)));
}

/* ---------- Choix du dossier racine ---------- */
async function pickRoot() {
  try {
    state.root = await window.showDirectoryPicker({ mode: "read" });
    state.rootName = state.root.name;
    await loadTags();
    await loadRatings();
    await loadFavorites();
    await dbPut("meta", "root", state.root);
    await scanRoot();
  } catch (e) {
    if (e.name !== "AbortError") status("Erreur : " + e.message);
  }
}

async function restoreRoot() {
  const saved = await dbGet("meta", "root");
  if (!saved) return false;
  let perm = "prompt";
  try { perm = await saved.queryPermission({ mode: "read" }); } catch (e) {}
  if (perm !== "granted") {
    const btn = document.createElement("button");
    btn.textContent = "Réouvrir le dernier dossier : " + saved.name;
    btn.onclick = async () => {
      try {
        if (await saved.requestPermission({ mode: "read" }) === "granted") {
          btn.remove();
          state.root = saved;
          await scanRoot();
        }
      } catch (e) {}
    };
    $("empty").classList.add("hidden");
    $("btnPick").after(btn);
    return false;
  }
  state.root = saved;
  state.rootName = saved.name;
  await loadTags();
  await loadRatings();
  await loadFavorites();
  await scanRoot();
  return true;
}

/* ---------- Scan récursif ---------- */
async function scanRoot() {
  status("Scan en cours…");
  state.files = [];
  state.dirs = new Map([["", { handle: state.root, parent: null }]]);
  await walk(state.root, "");
  state.files.sort((a, b) => a.path.localeCompare(b.path, "fr", { numeric: true }));
  const vids = state.files.filter(f => VIDEO_EXT.includes(f.ext)).length;
  status("");
  $("empty").classList.add("hidden");
  $("btnRescan").classList.remove("hidden");
  $("btnTagsMgr").classList.remove("hidden");
  $("btnThumbs").classList.toggle("hidden", state.view !== "mosaic");
  $("filterBar").classList.remove("hidden");
  $("rootInfo").innerHTML = `Racine : <b>${escapeHtml(state.root.name)}</b> — ${state.files.length} fichiers (${vids} vidéos)`;
  render();
  $("btnView").classList.remove("hidden");
  if ($("treeDlg").open) renderTreeDlg();
}

async function walk(dir, prefix) {
  for await (const [name, handle] of dir.entries()) {
    if (name.startsWith(".")) continue;
    if (handle.kind === "directory") {
      state.dirs.set(prefix + name + "/", { handle, parent: dir });
      await walk(handle, prefix + name + "/");
    } else {
      let size = 0;
      try { size = (await handle.getFile()).size; } catch (e) {}
      const dot = name.lastIndexOf(".");
      state.files.push({
        handle, name,
        path: prefix + name,
        dir: prefix,
        size,
        ext: dot > 0 ? name.slice(dot + 1).toLowerCase() : "",
        parent: dir,
      });
    }
  }
}

/* ---------- Tags (4 groupes) ---------- */
async function migrateLegacyTags(rootName) {
  for (const store of ["tags", "ratings", "thumbs"]) {
    for (const k of await dbGetAll(store)) {
      if (k.includes("\u0000")) continue;
      const v = await dbGet(store, k);
      await dbPut(store, rootName + "\u0000" + k, v);
      await dbDelete(store, k);
    }
  }
}
async function loadTags() {
  state.tags = new Map();
  const pref = state.rootName + "\u0000";
  for (const k of await dbGetAll("tags")) {
    if (!k.startsWith(pref)) continue;
    state.tags.set(k.slice(pref.length), normalizeStored(await dbGet("tags", k)));
  }
}
async function loadRatings() {
  state.ratings = new Map();
  const pref = state.rootName + "\u0000";
  for (const k of await dbGetAll("ratings")) {
    if (!k.startsWith(pref)) continue;
    const v = await dbGet("ratings", k);
    if (v >= 1 && v <= 5) state.ratings.set(k.slice(pref.length), v);
  }
}
async function setRating(path, n) {
  if (n === null) { state.ratings.delete(path); await dbDelete("ratings", dbKey(path)); }
  else { state.ratings.set(path, n); await dbPut("ratings", dbKey(path), n); }
  updateStars();
  scheduleAutoBackup();
}
async function saveTags(path) {
  const groups = state.tags.get(path);
  const empty = !groups || groups.every(s => s.size === 0);
  if (empty) await dbDelete("tags", dbKey(path));
  else await dbPut("tags", dbKey(path), groups.map(s => [...s]));
}

/* ---------- Filtrage ---------- */

/* ---------- Rendu ---------- */


function render() {
  applyFilter();
  renderGroups();
  renderVoteChips();
  $("resultCount").textContent = `${state.visible.length} fichier(s) affiché(s)`;
  if (state.view === "table") { renderTable(); return; }
  const nb = state.visible.filter(f => VIDEO_EXT.includes(f.ext)).length;
  if (nb <= 100 || state.mosaicSig === state.filterSig) { renderMosaic(); return; }
  if (state.mosaicPending) {
    $("mosaic").classList.remove("hidden");
    $("mosaic").innerHTML = '<p class="hint">⏳ Confirmation en attente…</p>';
    return;
  }
  state.mosaicPending = true;
  askConfirm(`Votre sélection concerne ${nb} fichiers. Confirmez-vous l'affichage en mode mosaïque ?`).then(ok => {
    state.mosaicPending = false;
    if (ok) {
      state.mosaicSig = state.filterSig;
    } else {
      state.view = "table";
      $("btnView").textContent = "🖼 Vue mosaïque";
      $("btnThumbs").classList.add("hidden");
    }
    render();
  });
  $("mosaic").classList.remove("hidden");
  $("mosaic").innerHTML = '<p class="hint">⏳ Confirmation en attente…</p>';
}

function renderVoteChips() {
  const cont = $("voteChips");
  cont.innerHTML = "";
  const opts = [0, 1, 2, 3, 4, 5];
  for (const n of opts) {
    const el = document.createElement("span");
    el.className = "chip" + (state.minRating === n ? " on" : "");
    el.textContent = n === 0 ? "toutes" : "★".repeat(n) + "+";
    el.title = n === 0 ? "Toutes les vidéos" : n + " étoiles et plus";
    el.onclick = () => { state.minRating = n; render(); };
    cont.appendChild(el);
  }
}

function renderGroups() {
  const cont = $("groups");
  cont.innerHTML = "";
  for (let g = 0; g < NB_GROUPS; g++) cont.appendChild(makeGroupPanel(g));
}

async function saveFavorites() {
  await dbPut("meta", "favorites_" + state.rootName, [...state.favorites]);
}
async function loadFavorites() {
  state.favorites = new Set((await dbGet("meta", "favorites_" + state.rootName)) || []);
}
async function toggleFavorite(t) {
  const was = state.favorites.has(t);
  was ? state.favorites.delete(t) : state.favorites.add(t);
  await saveFavorites();
  status(was ? `« ${t} » retiré des favoris` : `❤️ « ${t} » ajouté aux favoris`);
  renderGroups();
}

function makeGroupPanel(g) {
  const tags = allTags(g);
  const panel = document.createElement("div");
  panel.className = "group" + (state.groupsOpen.has(g) ? " open" : "");

  const head = document.createElement("div");
  head.className = "ghead";
  const nSel = state.selected[g].size;
  head.innerHTML = `<span class="arrow">${state.groupsOpen.has(g) ? "▾" : "▸"}</span>` +
    `Tags ${g + 1} <span class="cnt">${tags.length} tag(s)${nSel ? " — " + nSel + " sélectionné(s)" : ""}</span>`;
  head.onclick = () => {
    state.groupsOpen.has(g) ? state.groupsOpen.delete(g) : state.groupsOpen.add(g);
    renderGroups();
  };
  panel.appendChild(head);

  const body = document.createElement("div");
  body.className = "gbody";

  const tools = document.createElement("div");
  tools.className = "tools";
  if (g === 0) {
    const search = document.createElement("input");
    search.type = "search";
    search.placeholder = "Rechercher un tag…";
    search.value = state.groupSearch[g];
    search.oninput = () => { state.groupSearch[g] = search.value; renderChips(); };
    tools.appendChild(search);
  } else {
    const modeBtn = document.createElement("button");
    modeBtn.className = "small";
    const updateModeBtn = () => {
      const isAnd = state.groupMode[g] === "and";
      modeBtn.textContent = isAnd ? "Mode : ET" : "Mode : OU";
      modeBtn.title = isAnd
        ? "Mode ET : le fichier doit avoir tous les tags sélectionnés. Cliquez pour passer en OU."
        : "Mode OU : le fichier doit avoir au moins un des tags sélectionnés. Cliquez pour passer en ET.";
      modeBtn.style.borderColor = isAnd ? "var(--accent)" : "";
      modeBtn.style.color = isAnd ? "var(--accent)" : "";
    };
    modeBtn.onclick = () => {
      state.groupMode[g] = state.groupMode[g] === "and" ? "or" : "and";
      updateModeBtn();
      render();
    };
    updateModeBtn();
    tools.appendChild(modeBtn);
  }
  const allBtn = document.createElement("button");
  allBtn.className = "small";
  allBtn.textContent = "Tout sélectionner";
  allBtn.title = "Sélectionner tous les tags visibles de ce groupe";
  allBtn.onclick = () => {
    for (const t of visibleTags()) state.selected[g].add(t);
    render();
  };
  tools.appendChild(allBtn);
  const clearBtn = document.createElement("button");
  clearBtn.className = "small";
  clearBtn.textContent = "Effacer la sélection";
  clearBtn.style.display = state.selected[g].size > 0 ? "" : "none";
  clearBtn.onclick = () => { state.selected[g].clear(); state.noTag.delete(g); render(); };
  tools.appendChild(clearBtn);

  if (g === 0) {
    const letters = document.createElement("div");
    letters.className = "letters";
    const present = new Set(tags.map(normalizeKey));
    const letterList = ["Tous", "❤️", ...[...present].sort((a, b) => a.localeCompare(b, "fr"))];
    for (const L of letterList) {
      const s = document.createElement("span");
      s.textContent = L;
      const isOn = L === "Tous" ? state.letterSel[g] === null : state.letterSel[g] === L;
      if (isOn) s.classList.add("on");
      s.title = L === "❤️" ? "Afficher uniquement les tags favoris" : (L === "Tous" ? "Tous les tags" : L);
      s.onclick = () => {
        state.letterSel[g] = L === "Tous" ? null : L;
        renderGroups();
      };
      letters.appendChild(s);
    }
    tools.appendChild(letters);
  }
  body.appendChild(tools);

  const chips = document.createElement("div");
  chips.className = "chips";
  body.appendChild(chips);

  function visibleTags() {
    if (g !== 0) return tags;
    const q = state.groupSearch[g].trim().toLocaleLowerCase("fr");
    return tags.filter(t => {
      const okLetter = state.letterSel[g] === null ||
        (state.letterSel[g] === "❤️" ? state.favorites.has(t) : normalizeKey(t) === state.letterSel[g]);
      const okSearch = !q || t.toLocaleLowerCase("fr").includes(q);
      return okLetter && okSearch;
    });
  }
  function makeChip(t) {
    const el = document.createElement("span");
    el.className = "chip" + (state.selected[g].has(t) ? " on" : "");
    const isFav = g === 0 && state.favorites.has(t);
    if (isFav) {
      const mark = document.createElement("span");
      mark.className = "heartmark";
      mark.textContent = "❤";
      el.appendChild(mark);
    }
    const label = document.createElement("span");
    label.textContent = t;
    el.appendChild(label);
    if (g === 0) {
      const heart = document.createElement("span");
      heart.className = "heartbtn";
      heart.textContent = isFav ? "💔" : "🤍";
      heart.title = isFav ? "Retirer des favoris" : "Ajouter aux favoris";
      heart.onclick = e => { e.stopPropagation(); toggleFavorite(t); };
      el.appendChild(heart);
      el.oncontextmenu = e => { e.preventDefault(); toggleFavorite(t); };
    }
    el.onclick = () => {
      state.selected[g].has(t) ? state.selected[g].delete(t) : state.selected[g].add(t);
      render();
    };
    return el;
  }
  function renderChips() {
    chips.innerHTML = "";
    if (g === 0) {
      const noTagChip = document.createElement("span");
      noTagChip.className = "chip" + (state.noTag.has(0) ? " on" : "");
      noTagChip.textContent = "(sans tag)";
      noTagChip.title = "Fichiers sans aucun tag dans Tags 1";
      noTagChip.onclick = () => {
        state.noTag.has(0) ? state.noTag.delete(0) : state.noTag.add(0);
        render();
      };
      chips.appendChild(noTagChip);
      const favs = tags.filter(t => state.favorites.has(t));
      if (favs.length > 0 && state.letterSel[g] !== "❤️") {
        const fz = document.createElement("div");
        fz.className = "favzone";
        const lbl = document.createElement("span");
        lbl.className = "hintline";
        lbl.textContent = "❤ Favoris";
        fz.appendChild(lbl);
        for (const t of favs) fz.appendChild(makeChip(t));
        chips.appendChild(fz);
      }
    }
    const shown = visibleTags();
    if (shown.length === 0) {
      chips.innerHTML = `<span class="hintline">${tags.length === 0 ? "Aucun tag dans ce groupe." : "Aucun tag ne correspond."}</span>`;
      return;
    }
    for (const t of shown) chips.appendChild(makeChip(t));
  }
  renderChips();
  panel.appendChild(body);
  return panel;
}

/* ---------- Vue liste (arborescence dépliable) ---------- */
async function persistCollapsed() {
  try { await dbPut("meta", "collapsed", [...state.collapsed]); } catch (e) {}
}

function dbAll(store) {
  return new Promise((res, rej) => {
    const out = [];
    const rq = db.transaction(store).objectStore(store).openCursor();
    rq.onsuccess = e => {
      const c = e.target.result;
      if (c) { out.push([c.key, c.value]); c.continue(); } else res(out);
    };
    rq.onerror = () => rej(rq.error);
  });
}
async function renderTable() {
  $("mosaic").classList.add("hidden");
  $("tableView").classList.remove("hidden");
  const pref = state.rootName + "\u0000";
  const durMap = new Map();
  try {
    for (const [k, v] of await dbAll("thumbs")) {
      if (!k.startsWith(pref)) continue;
      const dur = v && typeof v === "object" ? v.dur : 0;
      if (dur) durMap.set(k.slice(pref.length), dur);
    }
  } catch (e) {}
  const tb = $("fileList").tBodies[0];
  tb.innerHTML = "";
  renderDir(buildTree(state.visible), 0, tb, durMap);
}

function renderDir(node, depth, tb, durMap) {
  const dirs = [...node.dirs.values()].sort((a, b) => a.name.localeCompare(b.name, "fr"));
  for (const d of dirs) {
    const collapsed = state.collapsed.has(d.path);
    const tr = document.createElement("tr");
    tr.className = "dirrow";
    const td = document.createElement("td");
    td.colSpan = 5 + NB_GROUPS;
    td.style.paddingLeft = (10 + depth * 18) + "px";
    const arrow = document.createElement("span");
    arrow.className = "darrow";
    arrow.textContent = collapsed ? "▸" : "▾";
    const nm = document.createElement("span");
    nm.textContent = "📁 " + d.name;
    const cnt = document.createElement("span");
    cnt.className = "fpath";
    cnt.textContent = " (" + countFiles(d) + ")";
    td.append(arrow, nm, cnt);
    tr.appendChild(td);
    tb.appendChild(tr);
    tr.onclick = () => {
      collapsed ? state.collapsed.delete(d.path) : state.collapsed.add(d.path);
      persistCollapsed();
      render();
    };
    if (!collapsed) renderDir(d, depth + 1, tb, durMap);
  }
  for (const f of node.files) {
    const tr = document.createElement("tr");

    const tdName = document.createElement("td");
    tdName.style.paddingLeft = (28 + depth * 18) + "px";
    const a = document.createElement("span");
    a.className = "fname"; a.textContent = f.name;
    a.onclick = () => openViewer(f);
    tdName.appendChild(a);

    const tdDur = document.createElement("td");
    tdDur.textContent = fmtDuration(durMap.get(f.path)) || "—";

    const tdSize = document.createElement("td");
    tdSize.textContent = fmtSize(f.size);

    const tdVote = document.createElement("td");
    tdVote.innerHTML = starsHTML(state.ratings.get(f.path) || 0, 5);

    const tdAction = document.createElement("td");
    const btn = document.createElement("span");
    btn.className = "addtag";
    btn.textContent = "🏷";
    btn.title = "Modifier les tags de ce fichier";
    btn.onclick = e => { e.stopPropagation(); openTagDialog(f); };
    tdAction.appendChild(btn);
    tr.append(tdName, tdDur, tdSize, tdVote, tdAction);
    const groups = tagsOf(f.path);
    for (let g = 0; g < NB_GROUPS; g++) tr.appendChild(makeTagCell(f, groups[g]));
    tb.appendChild(tr);
  }
}

function makeTagCell(f, groupSet) {
  const td = document.createElement("td");
  const cell = document.createElement("div");
  cell.className = "tagcell";
  for (const t of groupSet) {
    const pill = document.createElement("span");
    pill.className = "tagpill";
    pill.textContent = t;
    const x = document.createElement("span");
    x.className = "x"; x.textContent = "✕"; x.title = "Retirer ce tag";
    x.onclick = async e => {
      e.stopPropagation();
      const groups = tagsOf(f.path);
      for (const s of groups) s.delete(t);
      await saveTags(f.path);
      render();
      scheduleAutoBackup();
    };
    pill.appendChild(x);
    cell.appendChild(pill);
  }
  const add = document.createElement("span");
  add.className = "addtag"; add.textContent = "+ tag";
  add.onclick = e => { e.stopPropagation(); openTagDialog(f); };
  td.appendChild(cell);
  return td;
}

/* ---------- Mosaïque ---------- */
function renderMosaic() {
  $("tableView").classList.add("hidden");
  const mosaic = $("mosaic");
  mosaic.classList.remove("hidden");
  mosaic.innerHTML = "";
  const vids = state.visible.filter(f => VIDEO_EXT.includes(f.ext));
  if (vids.length === 0) {
    mosaic.innerHTML = '<p class="hint">Aucune vidéo ne correspond au filtre courant.</p>';
    return;
  }
  for (const f of vids) mosaic.appendChild(makeTile(f));
}

/* File de génération de vignettes : limite le nombre de vidéos décodées simultanément */
const thumbQueue = [];
let thumbActive = 0;
const THUMB_CONCURRENCY = 2;
function enqueueThumb(job) {
  thumbQueue.push(job);
  pumpThumbs();
}
function pumpThumbs() {
  while (thumbActive < THUMB_CONCURRENCY && thumbQueue.length > 0) {
    const job = thumbQueue.shift();
    thumbActive++;
    Promise.resolve(job()).finally(() => { thumbActive--; pumpThumbs(); });
  }
}

function makeTile(f) {
  const tile = document.createElement("div");
  tile.className = "tile";
  const thumb = document.createElement("div");
  thumb.className = "thumb";
  thumb.textContent = "…";
  tile.appendChild(thumb);
  const cap = document.createElement("div");
  cap.className = "cap";
  const all = tagsOf(f.path).flatMap(s => [...s]);
  cap.innerHTML = `<div class="trow"><span class="t">${escapeHtml(f.name)}</span><span class="dur"></span></div>` +
    `<div style="margin-top:3px">${starsHTML(state.ratings.get(f.path) || 0, 5)}</div>` +
    `<div class="tags">${escapeHtml(all.join(", "))}</div>`;
  tile.appendChild(cap);
  tile.onclick = () => openViewer(f);
  const durEl = cap.querySelector(".dur");
  let entry = null, anim = null, hovering = false;
  enqueueThumb(async () => {
    const e = await ensureThumb(f);
    entry = e;
    if (e.img) thumb.innerHTML = `<img src="${e.img}" alt="">`;
    else thumb.textContent = "🎬";
    if (e.dur) durEl.textContent = fmtDuration(e.dur);
  });
  tile.onmouseenter = async () => {
    hovering = true;
    if (!entry || !entry.img) return;
    const e = await ensureFrames(f, entry);
    if (!hovering || !e.frames || e.frames.length === 0) return;
    if (e.dur && !durEl.textContent) durEl.textContent = fmtDuration(e.dur);
    let i = 0;
    const img = thumb.querySelector("img");
    anim = setInterval(() => {
      if (img) img.src = e.frames[i % e.frames.length];
      i++;
    }, 500);
  };
  tile.onmouseleave = () => {
    hovering = false;
    clearInterval(anim);
    if (entry && entry.img) {
      const img = thumb.querySelector("img");
      if (img) img.src = entry.img;
    }
  };
  return tile;
}


/* ---------- Vignettes vidéo (intelligentes : frame la plus lumineuse parmi 1/3/5/7/9 s) ---------- */
function seekTo(video, t) {
  return new Promise((res, rej) => {
    const to = setTimeout(rej, 5000);
    video.onseeked = () => { clearTimeout(to); video.onseeked = null; res(); };
    video.onerror = () => { clearTimeout(to); rej(new Error("video")); };
    video.currentTime = t;
  });
}
function frameLuminance(video) {
  const c = document.createElement("canvas");
  c.width = 48; c.height = 27;
  const ctx = c.getContext("2d");
  ctx.drawImage(video, 0, 0, c.width, c.height);
  const d = ctx.getImageData(0, 0, c.width, c.height).data;
  let sum = 0;
  for (let i = 0; i < d.length; i += 4) sum += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
  return sum / (d.length / 4);
}
async function loadVideoEl(f) {
  const url = URL.createObjectURL(await f.handle.getFile());
  const video = document.createElement("video");
  video.muted = true; video.preload = "metadata"; video.src = url;
  await new Promise((res, rej) => {
    video.onloadeddata = res;
    video.onerror = rej;
    setTimeout(rej, 10000);
  });
  return [video, () => URL.revokeObjectURL(url)];
}
async function ensureThumb(f) {
  let e = await dbGet("thumbs", dbKey(f.path));
  if (typeof e === "string") {
    e = { img: e, dur: 0 };
    try { await dbPut("thumbs", dbKey(f.path), e); } catch (err) {}
  }
  if (e && e.img) return e;
  try {
    const [video, done] = await loadVideoEl(f);
    const candidates = [1, 3, 5, 7, 9].filter(t => t < (video.duration || Infinity) - 0.1);
    let bestT = candidates[0] ?? 0, bestLum = -1;
    for (const t of candidates) {
      try {
        await seekTo(video, t);
        const lum = frameLuminance(video);
        if (lum > bestLum) { bestLum = lum; bestT = t; }
      } catch (err) { break; }
    }
    if (bestLum >= 0) await seekTo(video, bestT);
    const canvas = document.createElement("canvas");
    const w = 320;
    canvas.width = w;
    canvas.height = Math.round(w * (video.videoHeight || 9) / (video.videoWidth || 16));
    canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
    const dur = video.duration || 0;
    done();
    e = { img: canvas.toDataURL("image/jpeg", 0.7), dur };
    try { await dbPut("thumbs", dbKey(f.path), e); } catch (err) {}
    return e;
  } catch (err) {
    return { img: null, dur: 0 };
  }
}
const FRAMES_VERSION = 2;
async function ensureFrames(f, e) {
  if (e.frames && e.fv === FRAMES_VERSION) return e;
  if (!e.img || !e.dur) return e;
  try {
    const [video, done] = await loadVideoEl(f);
    const frames = [];
    const dur = video.duration || 0;
    for (let i = 1; i <= 10 && dur > 0; i++) {
      const t = (dur / 11) * i;
      try { await seekTo(video, t); } catch (err) { break; }
      const canvas = document.createElement("canvas");
      const w = 240;
      canvas.width = w;
      canvas.height = Math.round(w * (video.videoHeight || 9) / (video.videoWidth || 16));
      canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
      frames.push(canvas.toDataURL("image/jpeg", 0.6));
    }
    done();
    if (frames.length > 0) {
      e.frames = frames;
      e.fv = FRAMES_VERSION;
      e.dur = e.dur || dur;
      try { await dbPut("thumbs", dbKey(f.path), e); } catch (err) {}
    }
    return e;
  } catch (err) {
    return e;
  }
}

/* ---------- Modifier : découpe, fondus, export ---------- */
let editFile = null;
let exportCancel = false;
let previewTimer = null;

let editActive = false;
let cutStart = 0, cutEnd = 0;
function editBounds() {
  const v = $("vVideo");
  const dur = v.duration || 0;
  let start = isFinite(cutStart) ? cutStart : 0;
  let end = isFinite(cutEnd) ? cutEnd : dur;
  if (start < 0) start = 0;
  if (end > dur) end = dur;
  if (end - start < 0.5) end = Math.min(dur, start + 0.5);
  return { start, end, dur };
}
function loadEditTags(f) {
  const groups = tagsOf(f.path);
  for (let g = 0; g < NB_GROUPS; g++) $("editTags" + g).value = [...groups[g]].join(", ");
}
async function saveEditTags() {
  if (!editFile) return;
  const groups = emptyGroups();
  for (let g = 0; g < NB_GROUPS; g++) {
    for (const t of $("editTags" + g).value.split(",").map(x => x.trim()).filter(Boolean)) groups[g].add(t);
  }
  state.tags.set(editFile.path, groups);
  await saveTags(editFile.path);
  render();
  scheduleAutoBackup();
}
function imageAdjusted() {
  return (parseFloat($("editBright").value) || 1) !== 1 || (parseFloat($("editContrast").value) || 1) !== 1;
}
function openEditPanel() {
  const f = currentVideoFile();
  if (!f) return;
  editFile = f;
  const v = $("vVideo");
  $("editDlgName").textContent = f.path;
  cutStart = 0;
  cutEnd = v.duration || 0;
  loadEditTags(f);
  $("editBright").value = 1; $("editBrightVal").textContent = "100 %";
  $("editContrast").value = 1; $("editContrastVal").textContent = "100 %";
  $("editProg").style.display = "none";
  $("viewer").classList.add("editing");
  $("editPanel").classList.remove("hidden");
  $("cutBar").classList.remove("hidden");
  editActive = true;
  updateCutUI();
}
function closeEditPanel() {
  editActive = false;
  clearInterval(previewTimer);
  $("viewer").classList.remove("editing");
  $("editPanel").classList.add("hidden");
  $("cutBar").classList.add("hidden");
}
function updateCutUI() {
  const v = $("vVideo");
  const dur = v.duration || 1;
  const { start, end } = editBounds();
  const L = Math.max(0, Math.min(100, start / dur * 100));
  const R = Math.max(0, Math.min(100, end / dur * 100));
  $("cutSel").style.left = L + "%";
  $("cutSel").style.width = Math.max(0, R - L) + "%";
  $("cutHandleL").style.left = "calc(" + L + "% - 5px)";
  $("cutHandleR").style.left = "calc(" + R + "% - 5px)";
  $("cutPlay").style.left = Math.max(0, Math.min(100, v.currentTime / dur * 100)) + "%";
  $("cutSelInfo").textContent = `Sélection : ${fmtDuration(start)} → ${fmtDuration(end)} (${fmtDuration(end - start)}) — curseur : ${fmtDuration(v.currentTime)} / ${fmtDuration(dur)}`;
}
(function setupCutBar() {
  const track = $("cutTrack");
  let drag = null;
  const timeAt = e => {
    const r = track.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    return ratio * ($("vVideo").duration || 0);
  };
  track.addEventListener("pointerdown", e => {
    if (!editActive) return;
    const v = $("vVideo");
    const t = timeAt(e);
    const { start, end } = editBounds();
    const r = track.getBoundingClientRect();
    const pxL = (t - start) / (v.duration || 1) * r.width;
    const pxR = (t - end) / (v.duration || 1) * r.width;
    if (Math.abs(pxL) < 10) drag = { type: "start" };
    else if (Math.abs(pxR) < 10) drag = { type: "end" };
    else { drag = { type: "play" }; v.currentTime = t; }
    try { track.setPointerCapture(e.pointerId); } catch (err) {}
    updateCutUI();
  });
  track.addEventListener("pointermove", e => {
    if (!drag || !editActive) return;
    const v = $("vVideo");
    const t = timeAt(e);
    v.pause();
    if (drag.type === "start") { cutStart = t; v.currentTime = t; }
    else if (drag.type === "end") { cutEnd = t; v.currentTime = t; }
    else v.currentTime = t;
    updateCutUI();
  });
  track.addEventListener("pointerup", () => { drag = null; });
})();
$("vVideo").addEventListener("timeupdate", () => { if (editActive) updateCutUI(); });

function setEditProgress(p) {
  $("editProgBar").style.width = Math.round(p * 100) + "%";
  $("editProgTxt").textContent = `Export en cours… ${Math.round(p * 100)} %`;
}
function fadeAlpha(rel, dur, fi, fo) {
  let a = 1;
  if (fi > 0 && rel < fi) a *= rel / fi;
  if (fo > 0 && dur - rel < fo) a *= (dur - rel) / fo;
  return Math.max(0, Math.min(1, a));
}
function bitrateFor(w, h, factor) {
  const f = factor || parseFloat($("editQuality")?.value) || 0.5;
  return Math.min(24e6, Math.max(2e6, Math.round(w * h * f)));
}
function targetDims(w, h) {
  const res = parseInt($("editRes")?.value || "0", 10);
  if (!res || h <= res) return { w: w - (w % 2), h: h - (h % 2) };
  const scale = res / h;
  return { w: Math.max(2, Math.round(w * scale / 2) * 2), h: Math.max(2, Math.round(h * scale / 2) * 2) };
}
async function uniqueName(parent, origName, suffix) {
  const base = origName.replace(/\.[^.]+$/, "");
  let name = base + suffix;
  let n = 2;
  while (await fileExists(parent, name)) {
    name = base + "-" + n + suffix;
    n++;
  }
  return name;
}

async function loadExportVideo(f) {
  const url = URL.createObjectURL(await f.handle.getFile());
  const video = document.createElement("video");
  video.preload = "auto";
  video.src = url;
  await new Promise((res, rej) => {
    video.onloadedmetadata = res;
    video.onerror = () => rej(new Error("vidéo illisible"));
    setTimeout(rej, 15000);
  });
  return [video, () => URL.revokeObjectURL(url)];
}

async function exportRealTime(f, start, end, fi, fo) {
  const [video, done] = await loadExportVideo(f);
  const sw = video.videoWidth, sh = video.videoHeight;
  const { w, h } = targetDims(sw, sh);
  const canvas = document.createElement("canvas");
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext("2d");
  const stream = canvas.captureStream(30);
  const ac = new AudioContext();
  const src = ac.createMediaElementSource(video);
  const gain = ac.createGain();
  const dest = ac.createMediaStreamDestination();
  src.connect(gain); gain.connect(dest);
  stream.addTrack(dest.stream.getAudioTracks()[0]);
  let mime = "";
  for (const m of [
    "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm",
  ]) {
    if (MediaRecorder.isTypeSupported(m)) { mime = m; break; }
  }
  if (!mime) throw new Error("MediaRecorder non disponible");
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: bitrateFor(w, h) });
  const chunks = [];
  rec.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
  const finished = new Promise(res => { rec.onstop = () => res(new Blob(chunks, { type: "video/webm" })); });
  const dur = end - start;
  let stopped = false, raf = 0;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    cancelAnimationFrame(raf);
    try { video.pause(); } catch (e) {}
    try { rec.stop(); } catch (e) {}
    try { ac.close(); } catch (e) {}
    done();
  };
  video.onended = stop;
  rec.start(1000);
  video.currentTime = start;
  await video.play();
  const draw = () => {
    if (stopped) return;
    const t = video.currentTime;
    if (t >= end) { stop(); return; }
    const rel = t - start;
    ctx.globalAlpha = 1; ctx.fillStyle = "#000"; ctx.fillRect(0, 0, w, h);
    ctx.globalAlpha = fadeAlpha(rel, dur, fi, fo);
    const filter = editFile && imageAdjusted()
      ? `brightness(${$("editBright").value}) contrast(${$("editContrast").value})`
      : "none";
    try { ctx.filter = filter; ctx.drawImage(video, 0, 0, w, h); ctx.filter = "none"; } catch (e) {}
    ctx.globalAlpha = 1;
    gain.gain.value = fadeAlpha(rel, dur, fi, fo);
    setEditProgress(rel / dur);
    if (exportCancel) { stop(); return; }
    raf = requestAnimationFrame(draw);
  };
  draw();
  const blob = await finished;
  return exportCancel ? null : blob;
}

/* Export instantané : remux sans réencodage via mp4box (qualité identique, son conservé) */
async function exportRemux(f, start, end, fi, fo) {
  if (typeof window.MP4Box === "undefined")
    throw new Error("mp4box.all.js n'est pas chargé — vérifiez le dossier libs/.");
  if (typeof window.Mp4Muxer === "undefined")
    throw new Error("mp4-muxer.js n'est pas chargé — vérifiez le dossier libs/.");
  const file = await f.handle.getFile();
  const buf = await file.arrayBuffer();
  buf.fileStart = 0;
  const box = MP4Box.createFile();
  const info = await new Promise((resolve, reject) => {
    box.onReady = resolve;
    box.onError = e => reject(new Error("MP4 illisible : " + e));
    box.appendBuffer(buf);
  });
  const vt = (info.videoTracks || [])[0];
  if (!vt) throw new Error("Aucune piste vidéo — le mode instantané ne s'applique qu'aux fichiers MP4.");
  const at = (info.audioTracks || [])[0];
  const trak = box.getTrackById(vt.id);
  const entry = trak.mdia.minf.stbl.stsd.entries[0];
  if (!entry.avcC) throw new Error("La vidéo n'est pas en H.264 — utilisez le mode temps réel.");
  let desc = null;
  if (entry.avcC.start !== undefined && entry.avcC.size && entry.avcC.hdr_size) {
    desc = new Uint8Array(buf.slice(entry.avcC.start + entry.avcC.hdr_size, entry.avcC.start + entry.avcC.size));
  } else if (entry.avcC.data) {
    desc = new Uint8Array(entry.avcC.data);
  }
  if (!desc || desc.length < 4) throw new Error("Configuration H.264 illisible (avcC introuvable).");
  const codec = "avc1." + [1, 2, 3].map(i => (desc[i] || 0).toString(16).padStart(2, "0")).join("");
  const decoderConfig = { codec, description: desc };
  const audioOk = !!(at && at.codec && at.codec.startsWith("mp4a") && at.audio && at.audio.sample_rate);
  const muxer = new Mp4Muxer.Muxer({
    target: new Mp4Muxer.ArrayBufferTarget(),
    video: { codec: "avc", width: vt.video.width, height: vt.video.height },
    ...(audioOk ? { audio: { codec: "aac", numberOfChannels: at.audio.channel_count || 2, sampleRate: at.audio.sample_rate } } : {}),
    fastStart: "in-memory",
    firstTimestampBehavior: "cross-track-offset",
  });
  let vStarted = false, vStartSec = null, vDone = false, aDone = !audioOk;
  let vCount = 0, aCount = 0, muxError = null;
  const vTotal = vt.nb_samples || 1, aTotal = at ? (at.nb_samples || 1) : 0;
  await new Promise((resolve, reject) => {
    box.onSamples = (id, user, samps) => {
      try {
        if (id === vt.id) {
          for (const s of samps) {
            if (vDone || exportCancel) break;
            const sec = s.dts / vt.timescale;
            if (!vStarted) {
              if ((s.is_sync || s.is_rap) && sec >= start) { vStarted = true; vStartSec = sec; }
              else continue;
            }
            if (sec >= end) { vDone = true; break; }
            const ts = s.dts / vt.timescale * 1e6;
            const dur = (s.duration || 0) / vt.timescale * 1e6;
            const cto = ((s.cts || s.dts) - s.dts) / vt.timescale * 1e6;
            muxer.addVideoChunkRaw(new Uint8Array(s.data), (s.is_sync || s.is_rap) ? "key" : "delta", ts, dur, { decoderConfig }, cto);
            vCount++;
          }
          if (vCount > 0) {
            const lastSec = s.dts / vt.timescale;
            setEditProgress(Math.min(0.99, Math.max(0, (lastSec - start) / Math.max(0.1, end - start))));
          }
          if (vCount >= vTotal) vDone = true;
        } else if (at && id === at.id) {
          for (const s of samps) {
            if (aDone || exportCancel) break;
            const sec = s.dts / at.timescale;
            if (vStartSec === null || sec < vStartSec - 0.05) continue;
            if (sec >= end) { aDone = true; break; }
            const ts = s.dts / at.timescale * 1e6;
            const dur = (s.duration || 0) / at.timescale * 1e6;
            muxer.addAudioChunkRaw(new Uint8Array(s.data), "key", ts, dur);
            aCount++;
          }
          if (aCount >= aTotal) aDone = true;
        }
        if (exportCancel || (vDone && aDone)) resolve();
      } catch (e) { muxError = e; resolve(); }
    };
    box.setExtractionOptions(vt.id, null, { nbSamples: 50 });
    if (at) box.setExtractionOptions(at.id, null, { nbSamples: 500 });
    box.start();
  });
  if (muxError) throw new Error("Remux : " + muxError.message);
  if (exportCancel) return null;
  if (vCount === 0) throw new Error("Aucune frame dans la sélection (début après la dernière image-clé ?).");
  if (audioOk && aCount === 0) status("Note : la piste audio n'a pas pu être incluse.");
  muxer.finalize();
  return { blob: new Blob([muxer.target.buffer], { type: "video/mp4" }), ext: "mp4" };
}

async function exportFast(f, start, end, fi, fo) {
  if (typeof VideoEncoder === "undefined")
    throw new Error("L'encodeur WebCodecs (VideoEncoder) n'est pas disponible dans ce navigateur — choisissez « Avec son » (temps réel).");
  const useMp4 = typeof window.Mp4Muxer !== "undefined";
  if (!useMp4 && typeof window.WebMMini === "undefined")
    throw new Error("Ni mp4-muxer ni webm-mini.js ne sont chargés — choisissez « Avec son » (temps réel).");
  const [video, done] = await loadExportVideo(f);
  video.muted = true;
  const { w, h } = targetDims(video.videoWidth, video.videoHeight);
  const scaled = w !== video.videoWidth || h !== video.videoHeight;
  let config, ok;
  if (useMp4) {
    config = { codec: "avc1.640028", width: w, height: h, bitrate: bitrateFor(w, h), framerate: 25, avc: { format: "avc" } };
    ok = (await VideoEncoder.isConfigSupported(config)).supported;
    if (!ok) {
      config.codec = "avc1.42001f";
      ok = (await VideoEncoder.isConfigSupported(config)).supported;
    }
    if (!ok) throw new Error("Aucun encodeur H.264 disponible — choisissez « Avec son » (temps réel).");
  } else {
    config = { codec: "vp8", width: w, height: h, bitrate: bitrateFor(w, h), framerate: 25 };
    ok = (await VideoEncoder.isConfigSupported(config)).supported;
    if (!ok) {
      config.codec = "vp09.00.10.08";
      ok = (await VideoEncoder.isConfigSupported(config)).supported;
    }
    if (!ok) throw new Error("Aucun encodeur vidéo disponible — choisissez « Avec son » (temps réel).");
  }
  let muxer;
  if (useMp4) {
    muxer = new Mp4Muxer.Muxer({
      target: new Mp4Muxer.ArrayBufferTarget(),
      video: { codec: "avc", width: w, height: h },
      fastStart: "in-memory",
      firstTimestampBehavior: "offset",
    });
  } else {
    const codecId = config.codec === "vp8" ? "V_VP8" : "V_VP9";
    muxer = new WebMMini.Muxer({ width: w, height: h, codec: codecId });
  }
  let encoderError = null, muxError = null, chunksMuxed = 0;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => {
      try {
        if (useMp4) {
          muxer.addVideoChunk(chunk, meta);
        } else {
          const data = new Uint8Array(chunk.byteLength);
          chunk.copyTo(data);
          muxer.addFrame(data, chunk.type === "key", chunk.timestamp / 1000);
        }
        chunksMuxed++;
      } catch (e) { muxError = e; }
    },
    error: e => { encoderError = e; }
  });
  encoder.configure(config);
  const dur = end - start;
  const needFade = fi > 0 || fo > 0;
  const needCanvas = needFade || scaled;
  const canvas = document.createElement("canvas");
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext("2d");
  let count = 0;
  const KEY_EVERY = 50;
  await new Promise((resolve, reject) => {
    let lastT = -1;
    const onFrame = (now, metadata) => {
      if (exportCancel) { video.pause(); resolve(); return; }
      const t = metadata && isFinite(metadata.mediaTime) ? metadata.mediaTime : video.currentTime;
      if (t >= end) { video.pause(); resolve(); return; }
      if (t <= lastT) { rVFC(); return; }
      lastT = t;
      const rel = count === 0 ? 0 : t - start;
      let frame;
      if (needCanvas) {
        ctx.globalAlpha = 1; ctx.fillStyle = "#000"; ctx.fillRect(0, 0, w, h);
        ctx.globalAlpha = needFade ? fadeAlpha(rel, dur, fi, fo) : 1;
        ctx.drawImage(video, 0, 0, w, h);
        ctx.globalAlpha = 1;
        frame = new VideoFrame(canvas, { timestamp: Math.round(rel * 1e6), duration: 40000 });
      } else {
        try { frame = new VideoFrame(video, { timestamp: Math.round(rel * 1e6), duration: 40000 }); } catch (e) { rVFC(); return; }
      }
      try {
        encoder.encode(frame, { keyFrame: count % KEY_EVERY === 0 });
      } catch (e) {}
      frame.close();
      count++;
      setEditProgress(rel / dur);
      if (encoder.encodeQueueSize > 15) {
        video.pause();
        const wait = () => {
          if (exportCancel) { resolve(); return; }
          if (encoder.encodeQueueSize < 5) {
            video.requestVideoFrameCallback(onFrame);
            video.play().catch(() => {});
          } else setTimeout(wait, 50);
        };
        wait();
        return;
      }
      rVFC();
    };
    const rVFC = () => { if (!video.paused && !video.ended) video.requestVideoFrameCallback(onFrame); };
    video.onended = () => resolve();
    video.onerror = () => reject(new Error("vidéo illisible"));
    video.currentTime = start;
    video.requestVideoFrameCallback(onFrame);
    video.playbackRate = 4;
    video.play().catch(reject);
  });
  await encoder.flush();
  encoder.close();
  done();
  if (encoderError) throw new Error("Encodeur : " + encoderError.message);
  if (muxError) throw new Error("Multiplexeur : " + muxError.message);
  if (exportCancel) return null;
  if (chunksMuxed === 0) throw new Error("Aucune frame n'a pu être encodée (0 chunk) — frames capturées : " + count + ".");
  try {
    if (useMp4) {
      muxer.finalize();
      return { blob: new Blob([muxer.target.buffer], { type: "video/mp4" }), ext: "mp4" };
    }
    return { blob: new Blob([muxer.finalize()], { type: "video/webm" }), ext: "webm" };
  } catch (e) {
    throw new Error(`${e.message} (frames capturées : ${count}, chunks multiplexés : ${chunksMuxed})`);
  }
}

async function exportEdited() {
  if (!editFile) return;
  const v = $("vVideo");
  const { start, end } = editBounds();
  if (end - start < 1) { alert("Sélection trop courte (1 seconde minimum)."); return; }
  if (!(await ensureWrite())) return;
  exportCancel = false;
  $("editProg").style.display = "";
  setEditProgress(0);
  try {
    status("Export en cours…");
    let result;
    if (imageAdjusted()) {
      status("Réglages d'image actifs — réencodage temps réel (avec son)…");
      const blob = await exportRealTime(editFile, start, end, 0, 0);
      result = blob ? { blob, ext: blob.type.includes("mp4") ? "mp4" : "webm" } : null;
    } else if (typeof window.MP4Box !== "undefined" && typeof window.Mp4Muxer !== "undefined") {
      result = await exportRemux(editFile, start, end, 0, 0);
    } else {
      status("Librairies mp4box/mp4-muxer absentes — export temps réel (avec son).");
      const blob = await exportRealTime(editFile, start, end, 0, 0);
      result = blob ? { blob, ext: blob.type.includes("mp4") ? "mp4" : "webm" } : null;
    }
    status("");
    if (!result || !result.blob) { $("editProg").style.display = "none"; status("Export annulé."); return; }
    const blob = result.blob;
    const newName = await uniqueName(editFile.parent, editFile.name, "-modifiee." + result.ext);
    await writeBlob(editFile.parent, newName, blob);
    const newPath = editFile.dir + newName;
    if (state.tags.has(editFile.path)) { state.tags.set(newPath, state.tags.get(editFile.path)); await saveTags(newPath); }
    const r = state.ratings.get(editFile.path);
    if (r !== undefined) { state.ratings.set(newPath, r); await dbPut("ratings", dbKey(newPath), r); }
    const replace = await askConfirm(`Vidéo exportée : « ${newName} » (${fmtBytes(blob.size)}).\nRemplacer l'original ?\n(Oui = l'original est supprimé. Non = les deux fichiers existent.)`);
    if (replace) {
      await editFile.parent.removeEntry(editFile.name);
      await purgePath(editFile.path);
    }
    $("editDlg").close();
    closeViewer();
    await scanRoot();
    status("Export terminé.");
    scheduleAutoBackup();
  } catch (e) {
    status("");
    alert("Export impossible : " + e.message);
  } finally {
    $("editProg").style.display = "none";
  }
}

/* ---------- Boîte de dialogue tags ---------- */
let dlgFile = null;
function openTagDialog(f) {
  dlgFile = f;
  $("tagDlgName").textContent = f.path;
  const groups = tagsOf(f.path);
  for (let g = 0; g < NB_GROUPS; g++) $("tagDlgIn" + g).value = [...groups[g]].join(", ");
  $("tagDlg").showModal();
  $("tagDlgIn0").focus();
}
async function submitTagDialog() {
  if (!dlgFile) return;
  const groups = emptyGroups();
  for (let g = 0; g < NB_GROUPS; g++) {
    for (const t of $("tagDlgIn" + g).value.split(",").map(s => s.trim()).filter(Boolean)) groups[g].add(t);
  }
  state.tags.set(dlgFile.path, groups);
  await saveTags(dlgFile.path);
  $("tagDlg").close();
  render();
  scheduleAutoBackup();
}

/* ---------- Opérations disque (suppression, renommage, déplacement) ---------- */
async function ensureWrite() {
  let p = "prompt";
  try { p = await state.root.queryPermission({ mode: "readwrite" }); } catch (e) {}
  if (p !== "granted") {
    try { p = await state.root.requestPermission({ mode: "readwrite" }); } catch (e) { p = "denied"; }
  }
  if (p !== "granted") { alert("L'autorisation d'écriture sur le dossier racine est requise pour cette action."); return false; }
  return true;
}
async function migratePath(oldP, newP) {
  if (state.tags.has(oldP)) {
    state.tags.set(newP, state.tags.get(oldP));
    state.tags.delete(oldP);
  }
  await saveTags(oldP);
  await saveTags(newP);
  const r = state.ratings.get(oldP);
  if (r !== undefined) {
    state.ratings.set(newP, r);
    state.ratings.delete(oldP);
    await dbDelete("ratings", dbKey(oldP));
    await dbPut("ratings", dbKey(newP), r);
  }
  const th = await dbGet("thumbs", dbKey(oldP));
  if (th) {
    await dbPut("thumbs", dbKey(newP), th);
    await dbDelete("thumbs", dbKey(oldP));
  }
}
async function purgePath(p) {
  state.tags.delete(p);
  await saveTags(p);
  state.ratings.delete(p);
  await dbDelete("ratings", dbKey(p));
  await dbDelete("thumbs", dbKey(p));
  scheduleAutoBackup();
}
async function getSubDir(rootHandle, rel, create) {
  let d = rootHandle;
  for (let seg of rel.split("/")) {
    seg = seg.trim();
    if (!seg || seg === "." || seg === "..") continue;
    d = await d.getDirectoryHandle(seg, { create: !!create });
  }
  return d;
}
async function fileExists(dirHandle, name) {
  try { await dirHandle.getFileHandle(name); return true; } catch (e) { return false; }
}
async function writeBlob(dirHandle, name, blob) {
  const fh = await dirHandle.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  await w.write(blob);
  await w.close();
  return fh;
}
async function deleteCurrentFile() {
  const f = currentVideoFile();
  if (!f || !f.parent) return;
  if (!confirm(`Supprimer définitivement « ${f.name} » du disque ?\nCette action est irréversible.`)) return;
  if (!(await ensureWrite())) return;
  try {
    await f.parent.removeEntry(f.name);
    await purgePath(f.path);
    state.files = state.files.filter(x => x.path !== f.path);
    closeViewer();
    await scanRoot();
  } catch (e) {
    alert("Suppression impossible : " + e.message);
  }
}
async function renameCurrentFile() {
  const f = currentVideoFile();
  if (!f || !f.parent) return;
  if (!(await ensureWrite())) return;
  while (true) {
    const newName = prompt("Nouveau nom du fichier :", f.name);
    if (!newName || newName === f.name) return;
    if (newName.includes("/") || newName.trim() === "") { alert("Nom invalide (vide ou contenant un slash)."); continue; }
    if (await fileExists(f.parent, newName)) {
      alert(`Un fichier nommé « ${newName} » existe déjà dans ce répertoire. Choisissez un autre nom.`);
      continue;
    }
    try {
      if (typeof f.handle.move === "function") {
        try {
          await f.handle.move(f.parent, newName);
        } catch (err) {
          await writeBlob(f.parent, newName, await f.handle.getFile());
          await f.parent.removeEntry(f.name);
        }
      } else {
        const size = (await f.handle.getFile()).size;
        const ok = await askConfirm(`Renommage par copie de ${fmtBytes(size)} (durée estimée : ${fmtTimeRange(size)}).\nConfirmer ?`);
        if (!ok) return;
        status("Renommage en cours…");
        await writeBlob(f.parent, newName, await f.handle.getFile());
        await f.parent.removeEntry(f.name);
        status("");
      }
      await migratePath(f.path, f.dir + newName);
      closeViewer();
      await scanRoot();
      return;
    } catch (e) {
      status("");
      alert("Renommage impossible : " + e.message);
      return;
    }
  }
}
function existingDirs() {
  const s = new Set();
  for (const f of state.files) {
    const parts = f.path.split("/");
    for (let i = 1; i < parts.length; i++) s.add(parts.slice(0, i).join("/"));
  }
  return [...s].sort((a, b) => a.localeCompare(b, "fr", { numeric: true }));
}
function chooseMoveTarget(f) {
  return new Promise(res => {
    const dlg = $("moveDlg");
    $("moveDlgFile").textContent = f.name;
    const sel = $("moveDlgSelect");
    sel.innerHTML = "";
    const cur = (f.dir || "").replace(/\/+$/, "");
    for (const d of existingDirs()) {
      const opt = document.createElement("option");
      opt.value = d;
      opt.textContent = "📁 " + d;
      if (d === cur) opt.selected = true;
      sel.appendChild(opt);
    }
    const newOpt = document.createElement("option");
    newOpt.value = "__new__";
    newOpt.textContent = "➕ Nouveau sous-répertoire…";
    sel.appendChild(newOpt);
    const done = v => { dlg.onclose = null; dlg.close(); res(v); };
    $("moveDlgOk").onclick = () => done(sel.value);
    $("moveDlgCancel").onclick = () => done(null);
    dlg.onclose = () => res(null);
    dlg.showModal();
  });
}
async function moveCurrentFile() {
  const f = currentVideoFile();
  if (!f || !f.parent) return;
  if (!(await ensureWrite())) return;
  while (true) {
    let choice = await chooseMoveTarget(f);
    if (choice === null) return;
    if (choice === "__new__") {
      const rel = prompt(`Nouveau sous-répertoire, relatif à la racine « ${state.root.name} »\n(ex. : vacances/2024) :`);
      if (rel === null) continue;
      choice = rel;
    }
    const clean = choice.trim().replace(/^\/+/, "").replace(/\/+$/, "");
    if (clean === "") { alert("Chemin invalide."); continue; }
    if (clean === (f.dir || "").replace(/\/+$/, "")) { alert("Le fichier est déjà dans ce répertoire."); continue; }
    try {
      const targetDir = await getSubDir(state.root, clean, true);
      if (await fileExists(targetDir, f.name)) {
        alert(`Un fichier nommé « ${f.name} » existe déjà dans « ${clean} ». Déplacez-le d'abord ou renommez-le.`);
        continue;
      }
      if (typeof f.handle.move === "function") {
        try {
          await f.handle.move(targetDir);
        } catch (err) {
          await writeBlob(targetDir, f.name, await f.handle.getFile());
          await f.parent.removeEntry(f.name);
        }
      } else {
        const size = (await f.handle.getFile()).size;
        const ok = await askConfirm(`Déplacement par copie de ${fmtBytes(size)} (durée estimée : ${fmtTimeRange(size)}).\nConfirmer ?`);
        if (!ok) { status(""); return; }
        status("Déplacement en cours…");
        await writeBlob(targetDir, f.name, await f.handle.getFile());
        await f.parent.removeEntry(f.name);
        status("");
      }
      const newDir = clean + "/";
      await migratePath(f.path, newDir + f.name);
      closeViewer();
      await scanRoot();
      return;
    } catch (e) {
      alert(`Déplacement impossible vers « ${clean} » : ${e.message}`);
      return;
    }
  }
}

/* ---------- Visionneuse ---------- */
let currentUrl = null;
function visibleVideos() { return state.visible.filter(f => VIDEO_EXT.includes(f.ext)); }

async function openViewer(f) {
  const vids = visibleVideos();
  let idx = vids.indexOf(f);
  if (idx === -1) { vids.push(f); idx = vids.length - 1; }
  state.viewerIndex = idx;
  await playCurrent();
  $("viewer").classList.add("open");
}
async function playCurrent() {
  const vids = visibleVideos();
  const f = vids[state.viewerIndex];
  if (!f) return;
  if (currentUrl) URL.revokeObjectURL(currentUrl);
  currentUrl = URL.createObjectURL(await f.handle.getFile());
  $("vTitle").textContent = f.path;
  $("vVideo").src = currentUrl;
  $("vVideo").play().catch(() => {});
  updateStars();
}
function currentVideoFile() {
  return visibleVideos()[state.viewerIndex] || null;
}
function updateStars() {
  const f = currentVideoFile();
  const cont = $("vStars");
  cont.innerHTML = "";
  if (!f) return;
  const cur = state.ratings.get(f.path) || 0;
  for (let i = 1; i <= 5; i++) {
    const s = document.createElement("span");
    s.textContent = "★";
    if (i <= cur) s.classList.add("on");
    s.onclick = () => setRating(f.path, i === cur ? null : i);
    cont.appendChild(s);
  }
}
function viewerStep(d) {
  const vids = visibleVideos();
  if (vids.length === 0) return;
  state.viewerIndex = (state.viewerIndex + d + vids.length) % vids.length;
  playCurrent();
}
function seekVideo(sec) {
  const v = $("vVideo");
  if (!v.src) return;
  v.currentTime = Math.max(0, Math.min((v.duration || Infinity) - 0.01, v.currentTime + sec));
  flashSeek(sec);
}
function flashSeek(sec) {
  const v = $("vVideo");
  let f = document.getElementById("seekFlash");
  if (!f) {
    f = document.createElement("div");
    f.id = "seekFlash";
    f.style.cssText = "position:absolute;top:16px;left:50%;transform:translateX(-50%);background:rgba(0,0,0,.7);color:#fff;padding:6px 14px;border-radius:999px;font-size:14px;font-weight:600;pointer-events:none;opacity:0;transition:opacity .25s";
    v.parentElement.appendChild(f);
  }
  f.textContent = (sec > 0 ? "+" : "") + sec + " s";
  f.style.opacity = "1";
  clearTimeout(f._t);
  f._t = setTimeout(() => { f.style.opacity = "0"; }, 600);
}
function closeViewer() {
  if (typeof closeEditPanel === "function" && editActive) closeEditPanel();
  $("vVideo").pause();
  $("vVideo").src = "";
  if (currentUrl) { URL.revokeObjectURL(currentUrl); currentUrl = null; }
  $("viewer").classList.remove("open");
}

/* ---------- Sauvegarde / restauration (tags + votes) ---------- */
function updateTagsDlg() {
  if (!$("tagsDlg").open) return;
  $("tagsDlgRoot").textContent = state.rootName || "—";
  $("tagsDlgDir").textContent = state.backupDirName || "non défini";
  const rAuto = document.querySelector('input[name="backupMode"][value="auto"]');
  const rManual = document.querySelector('input[name="backupMode"][value="manual"]');
  if (rAuto) rAuto.checked = state.autoBackup;
  if (rManual) rManual.checked = !state.autoBackup;
  const last = state.lastSave ? new Date(state.lastSave).toLocaleString("fr-FR") : "";
  $("tagsDlgLast").textContent = last ? `Dernière sauvegarde : ${last}` : "Aucune sauvegarde pour cette racine.";
}
async function ensureBackupDir() {
  const dir = await dbGet("meta", "backupDir");
  if (!dir) return null;
  let p = "prompt";
  try { p = await dir.queryPermission({ mode: "readwrite" }); } catch (e) {}
  if (p !== "granted") {
    try { p = await dir.requestPermission({ mode: "readwrite" }); } catch (e) { p = "denied"; }
  }
  return p === "granted" ? dir : null;
}
async function writeBackup(silent) {
  const dir = await ensureBackupDir();
  if (!dir) {
    if (!silent) alert("Aucun dossier de sauvegarde autorisé. Choisissez-le dans la popup 💾 Tags.");
    return false;
  }
  const obj = {
    app: "TagVid", root: state.rootName, date: new Date().toISOString(),
    favorites: [...state.favorites],
    tags: Object.fromEntries([...state.tags].map(([p, g]) => [p, g.map(s => [...s])])),
    ratings: Object.fromEntries([...state.ratings]),
  };
  const fh = await dir.getFileHandle(`tagvid-${state.rootName}.json`, { create: true });
  const w = await fh.createWritable();
  await w.write(JSON.stringify(obj, null, 2));
  await w.close();
  state.lastSave = obj.date;
  await dbPut("meta", "lastSave_" + state.rootName, obj.date);
  updateTagsDlg();
  return true;
}
let autoBackupTimer = null;
function scheduleAutoBackup() {
  if (!state.autoBackup) return;
  clearTimeout(autoBackupTimer);
  autoBackupTimer = setTimeout(() => writeBackup(true).catch(() => {}), 2000);
}
async function restoreBackup(file) {
  let data;
  try { data = JSON.parse(await file.text()); }
  catch (e) { alert("Fichier illisible : " + e.message); return; }
  if (data.root !== state.rootName) {
    const ok = await askConfirm(`Cette sauvegarde provient de la racine « ${data.root} » alors que la racine courante est « ${state.rootName} ».\nLes chemins étant relatifs, l'import peut créer des tags orphelins. Importer quand même ?`);
    if (!ok) return;
  }
  const mode = document.querySelector('input[name="importMode"]:checked')?.value || "merge";
  if (mode === "replace") {
    for (const p of [...state.tags.keys()]) { state.tags.delete(p); await saveTags(p); }
    for (const p of [...state.ratings.keys()]) { state.ratings.delete(p); await dbDelete("ratings", dbKey(p)); }
  }
  const paths = new Set(state.files.map(f => f.path));
  let skipped = 0;
  for (const [p, groups] of Object.entries(data.tags || {})) {
    if (!paths.has(p)) { skipped++; continue; }
    const g = normalizeStored(groups);
    const cur = state.tags.get(p) || emptyGroups();
    for (let i = 0; i < NB_GROUPS; i++) for (const t of g[i]) cur[i].add(t);
    state.tags.set(p, cur);
    await saveTags(p);
  }
  if (Array.isArray(data.favorites)) {
    state.favorites = new Set(data.favorites.filter(t => typeof t === "string"));
    await saveFavorites();
  }
  for (const [p, n] of Object.entries(data.ratings || {})) {
    if (!paths.has(p)) { skipped++; continue; }
    if (n >= 1 && n <= 5) { state.ratings.set(p, n); await dbPut("ratings", dbKey(p), n); }
  }
  render();
  updateTagsDlg();
  scheduleAutoBackup();
  if (skipped > 0) status(`${skipped} entrée(s) ignorée(s) : fichier(s) absent(s) du disque.`);
}
async function purgeOrphans() {
  const paths = new Set(state.files.map(f => f.path));
  const pref = state.rootName + "\u0000";
  let n = 0;
  for (const p of [...state.tags.keys()]) if (!paths.has(p)) { n++; }
  for (const p of [...state.ratings.keys()]) if (!paths.has(p)) { n++; }
  for (const k of (await dbGetAll("thumbs"))) if (k.startsWith(pref) && !paths.has(k.slice(pref.length))) { n++; }
  if (n === 0) { status("Aucun orphelin à nettoyer."); return; }
  const ok = await askConfirm(`${n} tag(s)/vote(s)/vignette(s) de fichiers absents du disque seront supprimés.\nConfirmer ?`);
  if (!ok) return;
  status("Nettoyage…");
  let done = 0;
  for (const p of [...state.tags.keys()]) if (!paths.has(p)) { state.tags.delete(p); await saveTags(p); done++; }
  for (const p of [...state.ratings.keys()]) if (!paths.has(p)) { state.ratings.delete(p); await dbDelete("ratings", dbKey(p)); done++; }
  for (const k of (await dbGetAll("thumbs"))) if (k.startsWith(pref) && !paths.has(k.slice(pref.length))) { await dbDelete("thumbs", k); done++; }
  status("");
  status(`${done} orphelin(s) supprimé(s).`);
  render();
  scheduleAutoBackup();
}

/* ---------- Gestion de l'arborescence (popup) ---------- */
async function dirExists(parentHandle, name) {
  try { await parentHandle.getDirectoryHandle(name); return true; } catch (e) { return false; }
}
async function estimateDir(handle) {
  let count = 0, bytes = 0;
  for await (const [name, h] of handle.entries()) {
    if (h.kind === "file") {
      count++;
      try { bytes += (await h.getFile()).size; } catch (e) {}
    } else {
      const s = await estimateDir(h);
      count += s.count;
      bytes += s.bytes;
    }
  }
  return { count, bytes };
}
async function smartMoveDir(src, dst, stats) {
  for await (const [name, h] of src.entries()) {
    if (h.kind === "file") {
      if (typeof h.move === "function") {
        try { await h.move(dst, name); stats.moved++; }
        catch (e) { await writeBlob(dst, name, await h.getFile()); }
      } else {
        await writeBlob(dst, name, await h.getFile());
      }
      stats.done++;
      status(`Opération en cours : ${stats.done}/${stats.total} fichier(s)…`);
    } else {
      const sub = await dst.getDirectoryHandle(name, { create: true });
      await smartMoveDir(h, sub, stats);
    }
  }
}
async function migratePrefix(oldDir, newDir) {
  const pref = state.rootName + "\u0000";
  const paths = new Set([...state.tags.keys(), ...state.ratings.keys(),
    ...(await dbGetAll("thumbs")).filter(k => k.startsWith(pref)).map(k => k.slice(pref.length))]);
  for (const p of paths) {
    if (p.startsWith(oldDir)) await migratePath(p, newDir + p.slice(oldDir.length));
  }
  scheduleAutoBackup();
}
async function migrateRootPrefix(oldRoot, newRoot) {
  const oldPref = oldRoot + "\u0000", newPref = newRoot + "\u0000";
  for (const store of ["tags", "ratings", "thumbs"]) {
    for (const k of await dbGetAll(store)) {
      if (!k.startsWith(oldPref)) continue;
      const v = await dbGet(store, k);
      await dbPut(store, newPref + k.slice(oldPref.length), v);
      await dbDelete(store, k);
    }
  }
  const fav = await dbGet("meta", "favorites_" + oldRoot);
  if (fav) {
    await dbPut("meta", "favorites_" + newRoot, fav);
    await dbDelete("meta", "favorites_" + oldRoot);
  }
}
async function doRenameRoot(parent) {
  const oldName = state.root.name;
  let newName;
  while (true) {
    newName = prompt(`Renommer le dossier racine « ${oldName} » en :`, oldName);
    if (!newName || newName === oldName) return;
    if (newName.includes("/") || newName.trim() === "") { alert("Nom invalide (vide ou contenant un slash)."); continue; }
    break;
  }
  if (!(await dirExists(parent, oldName))) {
    alert(`Le dossier sélectionné ne contient pas « ${oldName} ». Opération annulée — aucun fichier n'a été modifié.`);
    return;
  }
  if (await dirExists(parent, newName)) {
    alert(`Un dossier nommé « ${newName} » existe déjà à cet endroit. Renommez-le ou choisissez un autre nom.`);
    return;
  }
  const rootHandle = await parent.getDirectoryHandle(oldName);
  const est = await estimateDir(rootHandle);
  const ok = await askConfirm(`La racine « ${oldName} » contient ${est.count} fichier(s) (${fmtBytes(est.bytes)}).\nDurée estimée : ${est.count === 0 ? "instantanée" : fmtTimeRange(est.bytes)} selon le disque (quasi instantanée si le navigateur gère le déplacement natif).\nConfirmer le renommage en « ${newName} » ?`);
  if (!ok) return;
  try {
    status(`Renommage de la racine en « ${newName} »…`);
    const newHandle = await parent.getDirectoryHandle(newName, { create: true });
    await smartMoveDir(rootHandle, newHandle, { done: 0, total: est.count, moved: 0 });
    await parent.removeEntry(oldName, { recursive: true });
    await migrateRootPrefix(oldName, newName);
    state.root = newHandle;
    state.rootName = newName;
    await dbPut("meta", "root", newHandle);
    await loadTags();
    await loadRatings();
    await loadFavorites();
    closeViewer();
    status("");
    await scanRoot();
    renderTreeDlg();
  } catch (e) {
    status("");
    alert(`Renommage de la racine impossible : ${e.message}`);
  }
}
function renderTreeDlg() {
  const cont = $("treeDlgBody");
  cont.innerHTML = "";
  const dirs = [...state.dirs.keys()].filter(p => p !== "")
    .sort((a, b) => a.localeCompare(b, "fr", { numeric: true }));
  if (dirs.length === 0) {
    cont.innerHTML = '<p class="hint" style="text-align:center">Aucun sous-répertoire scanné (seuls les répertoires contenant des fichiers apparaissent).</p>';
    return;
  }
  for (const p of dirs) {
    const depth = p.split("/").length - 2;
    const name = p.slice(0, -1).split("/").pop();
    const row = document.createElement("div");
    row.className = "treerow";
    row.style.paddingLeft = (10 + depth * 16) + "px";
    const nm = document.createElement("span");
    nm.className = "dname";
    nm.textContent = "📁 " + name;
    const btnR = document.createElement("button");
    btnR.className = "small"; btnR.textContent = "✏️ Renommer";
    btnR.onclick = () => renameDir(p);
    const btnM = document.createElement("button");
    btnM.className = "small"; btnM.textContent = "📂 Déplacer";
    btnM.onclick = () => moveDir(p);
    row.append(nm, btnR, btnM);
    cont.appendChild(row);
  }
}
async function renameDir(dirPath) {
  const entry = state.dirs.get(dirPath);
  if (!entry || !entry.parent) return;
  const name = dirPath.slice(0, -1).split("/").pop();
  if (!(await ensureWrite())) return;
  while (true) {
    const newName = prompt(`Renommer le sous-répertoire « ${name} » en :`, name);
    if (!newName || newName === name) return;
    if (newName.includes("/") || newName.trim() === "") { alert("Nom invalide (vide ou contenant un slash)."); continue; }
    if (await dirExists(entry.parent, newName)) {
      alert(`Un sous-répertoire nommé « ${newName} » existe déjà au même niveau. Choisissez un autre nom.`);
      continue;
    }
    const est = await estimateDir(entry.handle);
    const ok = await askConfirm(`Le sous-répertoire « ${name} » contient ${est.count} fichier(s) (${fmtBytes(est.bytes)}).\nDurée estimée : ${est.count === 0 ? "instantanée" : fmtTimeRange(est.bytes)} selon le disque (quasi instantanée si le navigateur gère le déplacement natif).\nConfirmer ?`);
    if (!ok) return;
    try {
      status("Renommage du répertoire…");
      const newHandle = await entry.parent.getDirectoryHandle(newName, { create: true });
      await smartMoveDir(entry.handle, newHandle, { done: 0, total: est.count, moved: 0 });
      await entry.parent.removeEntry(name, { recursive: true });
      const newDir = dirPath.slice(0, dirPath.length - name.length) + newName + "/";
      await migratePrefix(dirPath, newDir);
      closeViewer();
      status("");
      await scanRoot();
      return;
    } catch (e) {
      status("");
      alert(`Renommage impossible : ${e.message}`);
      return;
    }
  }
}
function chooseDirTarget(dirPath) {
  return new Promise(res => {
    const dlg = $("moveDlg");
    $("moveDlgFile").textContent = "Sous-répertoire : " + dirPath;
    const sel = $("moveDlgSelect");
    sel.innerHTML = "";
    const root = document.createElement("option");
    root.value = "";
    root.textContent = "📁 (racine)";
    sel.appendChild(root);
    for (const d of [...state.dirs.keys()].filter(p => p !== "" && p !== dirPath && !p.startsWith(dirPath))
      .sort((a, b) => a.localeCompare(b, "fr", { numeric: true }))) {
      const opt = document.createElement("option");
      opt.value = d;
      opt.textContent = "📁 " + d;
      sel.appendChild(opt);
    }
    const newOpt = document.createElement("option");
    newOpt.value = "__new__";
    newOpt.textContent = "➕ Nouveau sous-répertoire…";
    sel.appendChild(newOpt);
    const done = v => { dlg.onclose = null; dlg.close(); res(v); };
    $("moveDlgOk").onclick = () => done(sel.value);
    $("moveDlgCancel").onclick = () => done(null);
    dlg.onclose = () => res(null);
    dlg.showModal();
  });
}
async function moveDir(dirPath) {
  const entry = state.dirs.get(dirPath);
  if (!entry || !entry.parent) return;
  const name = dirPath.slice(0, -1).split("/").pop();
  if (!(await ensureWrite())) return;
  let choice = await chooseDirTarget(dirPath);
  if (choice === null) return;
  if (choice === "__new__") {
    const rel = prompt(`Nouveau sous-répertoire, relatif à la racine « ${state.root.name} » :`);
    if (rel === null) return;
    choice = rel;
  }
  const clean = choice.trim().replace(/^\/+/, "").replace(/\/+$/, "");
  const newDir = (clean === "" ? "" : clean + "/") + name + "/";
  if (newDir === dirPath) { alert("Le sous-répertoire est déjà à cet endroit."); return; }
  try {
    status("Déplacement du répertoire…");
    const targetDir = clean === "" ? state.root : await getSubDir(state.root, clean, true);
    if (await dirExists(targetDir, name)) {
      status("");
      alert(`Un sous-répertoire nommé « ${name} » existe déjà dans « ${clean || "racine" } ». Renommez le sous-répertoire avant de le déplacer.`);
      return;
    }
    const est = await estimateDir(entry.handle);
    const ok = await askConfirm(`Le sous-répertoire « ${name} » contient ${est.count} fichier(s) (${fmtBytes(est.bytes)}).\nDurée estimée : ${est.count === 0 ? "instantanée" : fmtTimeRange(est.bytes)} selon le disque (quasi instantanée si le navigateur gère le déplacement natif).\nConfirmer ?`);
    if (!ok) { status(""); return; }
    const newHandle = await targetDir.getDirectoryHandle(name, { create: true });
    await smartMoveDir(entry.handle, newHandle, { done: 0, total: est.count, moved: 0 });
    await entry.parent.removeEntry(name, { recursive: true });
    await migratePrefix(dirPath, newDir);
    closeViewer();
    status("");
    await scanRoot();
  } catch (e) {
    status("");
    alert(`Déplacement impossible : ${e.message}`);
  }
}

/* ---------- Confirmation avec défaut « Non » ---------- */
function askConfirm(msg) {
  return new Promise(res => {
    const dlg = $("confirmDlg");
    $("confirmMsg").textContent = msg;
    const done = v => { dlg.onclose = null; dlg.close(); res(v); };
    $("confirmYes").onclick = () => done(true);
    $("confirmNo").onclick = () => done(false);
    dlg.onclose = () => res(false);
    dlg.showModal();
    $("confirmNo").focus();
  });
}

/* ---------- Événements ---------- */
$("btnPick").onclick = pickRoot;
$("btnRescan").onclick = () => { renderTreeDlg(); $("treeDlg").showModal(); };
$("treeDlgClose").onclick = () => $("treeDlg").close();
$("treeDlgReload").onclick = () => scanRoot();
$("treeDlgRenameRoot").onclick = () => { $("treeDlg").close(); $("rootParentDlg").showModal(); };
$("rootParentDlgCancel").onclick = () => $("rootParentDlg").close();
$("rootParentDlgPick").onclick = async () => {
  let parent;
  try {
    parent = await window.showDirectoryPicker({ mode: "readwrite" });
  } catch (e) {
    if (e.name !== "AbortError") alert("Sélection impossible : " + e.message);
    return;
  }
  $("rootParentDlg").close();
  await doRenameRoot(parent);
};
$("btnTagsMgr").onclick = async () => {
  state.backupDirName = (await dbGet("meta", "backupDir"))?.name || null;
  state.lastSave = await dbGet("meta", "lastSave_" + state.rootName) || null;
  $("tagsDlg").showModal();
  updateTagsDlg();
};
$("tagsDlgClose").onclick = () => $("tagsDlg").close();
$("tagsDlgPickDir").onclick = async () => {
  let dir;
  try {
    dir = await window.showDirectoryPicker({ mode: "readwrite" });
  } catch (e) {
    if (e.name !== "AbortError") alert("Sélection impossible : " + e.message);
    return;
  }
  await dbPut("meta", "backupDir", dir);
  state.backupDirName = dir.name;
  updateTagsDlg();
};
$("tagsDlgSave").onclick = async () => {
  status("Sauvegarde…");
  const ok = await writeBackup(false).catch(e => { alert("Sauvegarde impossible : " + e.message); return false; });
  status("");
  if (ok) status("Sauvegarde effectuée.");
};
$("tagsDlgRestore").onclick = () => $("importFile").click();
$("tagsDlgPurge").onclick = purgeOrphans;
$("importFile").onchange = e => { if (e.target.files[0]) restoreBackup(e.target.files[0]).catch(err => alert("Restauration impossible : " + err.message)); e.target.value = ""; };
document.querySelectorAll('input[name="backupMode"]').forEach(r => {
  r.onchange = async () => {
    state.autoBackup = r.value === "auto";
    await dbPut("meta", "autoBackup", state.autoBackup);
    if (state.autoBackup) scheduleAutoBackup();
  };
});
window.addEventListener("beforeunload", () => {
  if (state.autoBackup) { try { writeBackup(true); } catch (e) {} }
});
$("btnThumbs").onclick = async () => {
  const full = await askConfirm("Recalculer TOUTES les vignettes de la racine ?\nNon = régénérer uniquement les vignettes manquantes ou en échec.");
  if (full) {
    status("Purge des vignettes…");
    const pref = state.rootName + "\u0000";
    for (const k of (await dbGetAll("thumbs")).filter(k => k.startsWith(pref))) await dbDelete("thumbs", k);
    status("");
  }
  render();
};
$("sortRating").onchange = e => { state.sortByRating = e.target.checked; render(); };
$("btnResetFilters").onclick = () => {
  state.selected = Array.from({length: NB_GROUPS}, () => new Set());
  state.noTag.clear();
  state.minRating = 0;
  state.groupSearch = Array(NB_GROUPS).fill("");
  state.letterSel = Array(NB_GROUPS).fill(null);
  render();
};
$("btnExpandAll").onclick = () => { state.collapsed.clear(); persistCollapsed(); render(); };
$("btnCollapseAll").onclick = () => { state.collapsed = allDirPaths(); persistCollapsed(); render(); };
$("tagDlgOk").onclick = submitTagDialog;
$("tagDlgCancel").onclick = () => $("tagDlg").close();
for (let g = 0; g < NB_GROUPS; g++) {
  $("tagDlgIn" + g).addEventListener("keydown", e => { if (e.key === "Enter") submitTagDialog(); });
}
$("vClose").onclick = closeViewer;
$("vEdit").onclick = () => {
  if (editActive) { $("editPanel").classList.remove("hidden"); updateCutUI(); return; }
  openEditPanel();
};
$("vDelete").onclick = deleteCurrentFile;
$("editDlgClose").onclick = closeEditPanel;
for (let g = 0; g < NB_GROUPS; g++) {
  $("editTags" + g).addEventListener("change", saveEditTags);
  $("editTags" + g).addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); saveEditTags(); } });
}
$("editBright").addEventListener("input", () => { $("editBrightVal").textContent = Math.round(($("editBright").value) * 100) + " %"; });
$("editContrast").addEventListener("input", () => { $("editContrastVal").textContent = Math.round(($("editContrast").value) * 100) + " %"; });
$("editImgReset").onclick = () => {
  $("editBright").value = 1; $("editBrightVal").textContent = "100 %";
  $("editContrast").value = 1; $("editContrastVal").textContent = "100 %";
};
$("editExport").onclick = exportEdited;
$("editCancel").onclick = () => { exportCancel = true; };
$("editRename").onclick = renameCurrentFile;
$("editMove").onclick = moveCurrentFile;
$("vPrev").onclick = () => viewerStep(-1);
$("vNext").onclick = () => viewerStep(1);
$("vBack30").onclick = () => seekVideo(-30);
$("vBack15").onclick = () => seekVideo(-10);
$("vFwd15").onclick = () => seekVideo(10);
$("vFwd30").onclick = () => seekVideo(30);
document.addEventListener("keydown", e => {
  if (!$("viewer").classList.contains("open")) return;
  if (e.key === "Escape") { if (editActive) closeEditPanel(); else closeViewer(); return; }
  if (editActive && document.activeElement && document.activeElement.tagName === "INPUT") return;
  if (editActive) {
    const v = $("vVideo");
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      const step = (e.ctrlKey ? 0.1 : e.shiftKey ? 10 : 1) * (e.key === "ArrowLeft" ? -1 : 1);
      v.pause();
      v.currentTime = Math.max(0, Math.min(v.duration || 0, v.currentTime + step));
      updateCutUI();
      return;
    }
    if (e.key === "s" || e.key === "S") { cutStart = v.currentTime; updateCutUI(); return; }
    if (e.key === "e" || e.key === "E") { cutEnd = v.currentTime; updateCutUI(); return; }
    if (e.key === " ") { e.preventDefault(); if (v.paused) v.play().catch(() => {}); else v.pause(); return; }
  }
  if (e.key === "ArrowLeft") seekVideo(-10);
  if (e.key === "ArrowRight") seekVideo(30);
  if (e.key === "ArrowUp") { e.preventDefault(); viewerStep(-1); }
  if (e.key === "ArrowDown") { e.preventDefault(); viewerStep(1); }
});

const toggle = document.createElement("button");
toggle.id = "btnView";
toggle.textContent = "🖼 Vue mosaïque";
toggle.classList.add("hidden");
$("btnTagsMgr").after(toggle);
toggle.onclick = () => {
  state.view = state.view === "table" ? "mosaic" : "table";
  if (state.view === "mosaic") state.mosaicSig = null;
  $("btnThumbs").classList.toggle("hidden", state.view !== "mosaic");
  toggle.textContent = state.view === "table" ? "🖼 Vue mosaïque" : "📋 Vue liste";
  render();
};

/* ---------- Démarrage ---------- */
(async () => {
  if (!window.showDirectoryPicker) {
    $("empty").innerHTML = "Votre navigateur ne supporte pas l'accès au disque local (File System Access API).<br>" +
      '<span class="hint">Utilisez Chrome, Edge ou Opera (versions récentes). Firefox et Safari ne sont pas compatibles.</span>';
    return;
  }
  await openDB();
  const savedRoot = await dbGet("meta", "root");
  state.rootName = savedRoot ? savedRoot.name : "";
  await migrateLegacyTags(state.rootName);
  state.autoBackup = (await dbGet("meta", "autoBackup")) || false;
  await loadTags();
  await loadRatings();
  await loadFavorites();
  state.collapsed = new Set((await dbGet("meta", "collapsed")) || []);
  const ok = await restoreRoot().catch(() => false);
  if (!ok) status("");
  const badge = document.querySelector('header .hintline[title*="version"]');
  if (badge && !badge.textContent.includes("v" + APP_JS_VERSION)) {
    alert(`Version incohérente : index.html est en ${badge.textContent.trim()} mais app.js est en v${APP_JS_VERSION}.\nRe-téléchargez TOUS les fichiers (index.html, app.js, app-core.js) depuis le dépôt GitHub.`);
  }
})();
