"use strict";
/* Tests de la logique pure de TagVid — exécution : node tests/core.test.js (aucune dépendance) */

const core = require("../app-core.js");
const { state, NB_GROUPS, dbKey, emptyGroups, normalizeStored, tagsOf, allTags,
        normalizeKey, escapeHtml, fmtSize, fmtBytes, fmtTimeRange, fmtDuration,
        starsHTML, buildTree, countFiles, allDirPaths, applyFilter, sortVisible } = core;

let passed = 0, failed = 0;
const norm = v => JSON.stringify(v, (k, x) => x instanceof Set ? [...x] : x);
function eq(actual, expected, label) {
  const a = norm(actual), e = norm(expected);
  if (a === e) { passed++; }
  else { failed++; console.error(`✗ ${label}\n  attendu: ${e}\n  obtenu : ${a}`); }
}
function resetState(files, tags, ratings) {
  state.files = files;
  state.tags = tags || new Map();
  state.ratings = ratings || new Map();
  state.selected = Array.from({length: NB_GROUPS}, () => new Set());
  state.noTag = new Set();
  state.groupMode = Array(NB_GROUPS).fill("or");
  state.minRating = 0;
  state.sortByRating = false;
  state.mosaicSig = null;
  state.filterSig = null;
  state.visible = [];
}
const mkFile = (path, ext = "mp4", size = 1000) => ({ path, name: path.split("/").pop(), dir: path.includes("/") ? path.slice(0, path.lastIndexOf("/") + 1) : "", size, ext });

/* ---------- normalizeStored ---------- */
eq(normalizeStored(null), [[], [], [], []], "normalizeStored(null)");
eq(normalizeStored(["a", "b"]), [["a", "b"], [], [], []], "normalizeStored legacy (liste simple -> groupe 1)");
eq(normalizeStored([["a"], [], ["c"], ["d", "e"]]), [["a"], [], ["c"], ["d", "e"]], "normalizeStored 4 groupes");

/* ---------- formats ---------- */
eq(fmtDuration(0), "", "fmtDuration(0)");
eq(fmtDuration(75), "1:15", "fmtDuration(75)");
eq(fmtDuration(3675), "1:01:15", "fmtDuration(3675)");
eq(fmtBytes(0), "0 o", "fmtBytes(0)");
eq(fmtBytes(1024 * 1024 * 1.5), "1.5 Mo", "fmtBytes(1.5 Mo)");
eq(fmtSize(0), "—", "fmtSize(0)");
eq(fmtTimeRange(400e6), "1 s à 8 s", "fmtTimeRange(400 Mo)");
eq(normalizeKey(" école"), "E", "normalizeKey accent (lettre de base)");
eq(escapeHtml('<a>&"'), "&lt;a&gt;&amp;&quot;", "escapeHtml");
eq(starsHTML(2, 5), '<span class="stars-inline"><span class="on">★</span><span class="on">★</span><span class="">★</span><span class="">★</span><span class="">★</span></span>', "starsHTML(2,5)");

/* ---------- arborescence ---------- */
{
  const files = [mkFile("a/x.mp4"), mkFile("a/b/y.mp4"), mkFile("a/b/z.mp4"), mkFile("w.mp4")];
  const tree = buildTree(files);
  eq(countFiles(tree), 4, "countFiles racine");
  eq(countFiles(tree.dirs.get("a").dirs.get("b")), 2, "countFiles a/b");
  resetState(files);
  eq([...allDirPaths()].sort(), ["a/", "a/b/"], "allDirPaths");
}

/* ---------- filtrage ---------- */
{
  // Régression v1.23 : sans filtre, filterSig doit être calculé (contrôle mosaïque >100)
  const files = Array.from({length: 150}, (_, i) => mkFile(`v${i}.mp4`));
  resetState(files);
  applyFilter();
  eq(state.visible.length, 150, "sans filtre : tous les fichiers visibles");
  eq(state.filterSig !== null, true, "RÉGRESSION: filterSig calculé même sans filtre actif");
}
{
  // OU intra-groupe, ET inter-groupes
  const files = [mkFile("f1.mp4"), mkFile("f2.mp4"), mkFile("f3.mp4")];
  resetState(files, new Map([
    ["f1.mp4", normalizeStored([["vacances", "plage"], ["famille"], [], []])],
    ["f2.mp4", normalizeStored([["vacances"], [], [], []])],
    ["f3.mp4", normalizeStored([["plage"], ["famille"], [], []])],
  ]));
  state.selected[0] = new Set(["vacances", "plage"]);
  state.selected[1] = new Set(["famille"]);
  applyFilter();
  eq(state.visible.map(f => f.path), ["f1.mp4", "f3.mp4"], "OU intra-groupe ET inter-groupes");
}
{
  // Mode ET intra-groupe (groupes 2-4)
  const files = [mkFile("f1.mp4"), mkFile("f2.mp4")];
  resetState(files, new Map([
    ["f1.mp4", normalizeStored([[], ["a", "b"], [], []])],
    ["f2.mp4", normalizeStored([[], ["a"], [], []])],
  ]));
  state.selected[1] = new Set(["a", "b"]);
  state.groupMode[1] = "and";
  applyFilter();
  eq(state.visible.map(f => f.path), ["f1.mp4"], "mode ET intra-groupe");
}
{
  // « sans tag » du groupe 1 (OU avec les autres sélections)
  const files = [mkFile("f1.mp4"), mkFile("f2.mp4"), mkFile("f3.mp4")];
  resetState(files, new Map([
    ["f1.mp4", normalizeStored([["x"], [], [], []])],
    ["f2.mp4", normalizeStored([[], [], [], []])],
    ["f3.mp4", normalizeStored([["x"], [], [], []])],
  ]));
  state.noTag.add(0);
  applyFilter();
  eq(state.visible.map(f => f.path), ["f2.mp4"], "sans tag groupe 1");
  state.selected[0] = new Set(["x"]);
  applyFilter();
  eq(state.visible.map(f => f.path), ["f1.mp4", "f2.mp4", "f3.mp4"], "sans tag OU tag x");
}
{
  // Filtre par vote
  const files = [mkFile("f1.mp4"), mkFile("f2.mp4")];
  resetState(files, null, new Map([["f1.mp4", 4], ["f2.mp4", 2]]));
  state.minRating = 3;
  applyFilter();
  eq(state.visible.map(f => f.path), ["f1.mp4"], "filtre vote >= 3");
}
{
  // Tri par vote décroissant, non votés en dernier
  const files = [mkFile("a.mp4"), mkFile("b.mp4"), mkFile("c.mp4")];
  resetState(files, null, new Map([["a.mp4", 2], ["b.mp4", 5]]));
  state.sortByRating = true;
  applyFilter();
  eq(state.visible.map(f => f.path), ["b.mp4", "a.mp4", "c.mp4"], "tri par vote décroissant");
}
{
  // Signature des filtres : change quand la sélection change
  const files = [mkFile("f.mp4")];
  resetState(files);
  applyFilter();
  const s1 = state.filterSig;
  state.selected[0].add("nouveau");
  applyFilter();
  eq(state.filterSig !== s1, true, "filterSig change avec la sélection");
}

/* ---------- tagsOf / allTags / dbKey ---------- */
{
  resetState([mkFile("f.mp4")]);
  state.rootName = "MaRacine";
  eq(dbKey("a/b.mp4"), "MaRacine\u0000a/b.mp4", "dbKey préfixé par racine");
  state.tags.set("f.mp4", normalizeStored([["t1"], [], [], []]));
  eq([...tagsOf("f.mp4")[0]], ["t1"], "tagsOf");
  eq([...tagsOf("inconnu.mp4")].every(s => s.size === 0), true, "tagsOf fichier sans tags");
  eq(allTags(0), ["t1"], "allTags groupe 1");
  eq(allTags(1), [], "allTags groupe 2 vide");
}

console.log(`\n${passed} test(s) OK, ${failed} échec(s)`);
process.exit(failed === 0 ? 0 : 1);
