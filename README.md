# TagVid 🎬

Application locale en **fichiers statiques** (`index.html`, `app.js`, `app-core.js`, `libs/`) pour organiser, trier, retoucher et visionner une arborescence de vidéos — sans installation, sans dépendance à installer, sans serveur.

**Version actuelle : v1.55**

## Installation

1. Téléchargez le dépôt (*Code → Download ZIP*) et décompressez-le — **tous les fichiers doivent rester ensemble** :
   ```
   TagVid/
   ├── index.html
   ├── app.js
   ├── app-core.js
   ├── libs/
   │   ├── mp4box.all.js      (démultiplexage MP4 — téléchargée séparément, voir ci-dessous)
   │   ├── mp4-muxer.js       (multiplexage MP4 — téléchargée séparément)
   │   └── webm-mini.js       (mini-multiplexeur WebM, embarqué aussi en secours dans app.js)
   └── tests/
   ```
2. Ouvrez `index.html` avec **Chrome, Edge ou Opera** (l'API *File System Access* n'est pas supportée par Firefox/Safari).
3. Cliquez sur **« Choisir le dossier racine »** et autorisez l'accès en lecture. Le dossier est mémorisé entre les sessions.

Les librairies `mp4box.all.js` (https://unpkg.com/mp4box@0.5.4/dist/mp4box.all.js) et `mp4-muxer.js` (https://github.com/Vanilagy/mp4-muxer → dist/mp4-muxer.js) ne sont pas dans le dépôt : téléchargez-les et placez-les dans `libs/` pour activer l'export instantané et la retouche MP4. Sans elles, l'application fonctionne en mode dégradé (export temps réel).

**Vérifiez toujours le badge de version** en haut à droite de l'application : il doit correspondre au dernier tag du dépôt. Une alerte s'affiche si `index.html` et `app.js` ne sont pas de la même version.

Tout se passe en local : aucune donnée n'est envoyée sur le réseau.

## Fonctionnalités

### Arborescence et affichage
- **Scan récursif** d'une racine ; dossier mémorisé entre les sessions.
- **Vue liste en arborescence dépliable** (état persistant) : Nom · Durée · Taille · Vote · 🏷 · Tags 1-4.
- **Vue mosaïque** : vignettes intelligentes (frame la plus lumineuse parmi 1/3/5/7/9 s, mises en cache), **durée affichée**, **aperçu animé au survol** (10 images réparties sur la vidéo), vote en étoiles.
- Contrôle au-delà de **100 vidéos** avant affichage mosaïque (confirmation, défaut Non).
- File de génération de vignettes limitée (2 décodages simultanés) ; « Régénérer les vignettes » ne recalcule que les manquantes par défaut.

### Tags (4 groupes libres)
- Tags libres, séparés par virgules ; édition par fichier depuis la vue liste, **ou en ligne dans le panneau Modifier**.
- **Persistants en IndexedDB, cloisonnés par dossier racine** ; export/import JSON (tags + votes + favoris), sauvegarde automatique (fichier roulant `tagvid-<racine>.json`), nettoyage des orphelins (fichiers supprimés).

### Filtrage
- **Tags 1** : recherche + index alphabétique + **favoris** (zone dédiée, cœur rouge, clic droit ou cœur au survol, entrée ❤️ dans l'index) + tag virtuel **« (sans tag) »**.
- **Tags 2-4** : bouton bascule **Mode : OU / ET** par groupe.
- **Entre groupes : ET** ; filtre par vote (★+ à ★★★★★+) ; tri par vote ; bouton « Tout sélectionner » (tags visibles) et « Réinitialiser les filtres ».

### Visionneuse
- Lecture, navigation clavier (← −10 s, → +30 s, ↑/↓ vidéo précédente/suivante, Échap), **vote 1-5 étoiles** persistant.
- Boutons : **✂️ Modifier** et 🗑 Supprimer (suppression physique avec confirmation).

### Panneau « ✂️ Modifier » (ancré à droite)
- **🏷 Tags** : édition en ligne des 4 groupes.
- **📁 Fichier** : ✏️ Renommer (contrôle d'unicité) et 📂 Déplacer (choix dans la liste des sous-répertoires) — opérations physiques avec migration des tags/votes/vignettes.
- **✂️ Retouche** :
  - **Découpe** : bande de temps interactive sous la vidéo (poignées début/fin glissables, scrubbing, curseur de lecture) ; clavier de précision : ←/→ ±1 s, Maj ±10 s, **Ctrl ±0,1 s**, S début, E fin, Espace lecture.
  - **Image** : curseurs luminosité/contraste avec **aperçu de l'effet** en direct.
  - **Export** :
    - sans réglage d'image : **remux instantané sans réencodage** (mp4box + mp4-muxer) — qualité identique, son conservé, quelques secondes ; coupe alignée à l'image-clé suivante ;
    - avec réglages d'image : **réencodage vidéo accéléré (~4×)** avec filtres, audio copié sans réencodage → MP4 avec son ;
    - repli temps réel (MediaRecorder) si librairies absentes.
  - Le fichier exporté (`-modifiee.mp4`) récupère tags et vote ; remplacement de l'original proposé après confirmation.

### Gestion de l'arborescence (bouton 📁 Arborescence)
- Treeview des sous-répertoires ; **renommage et déplacement de répertoires** (copie récursive + `move()` natif si disponible), estimation volume/durée avant confirmation, progression, migration complète des données.
- **Renommage du dossier racine** (sélection du parent requise par le navigateur) avec migration des tags/votes/vignettes/favoris.

## Structure du projet

- `index.html` — structure et styles
- `app-core.js` — **logique pure** (filtres, tri, arborescence, formats) : sans DOM ni IndexedDB, testable avec Node
- `app.js` — interface, persistance IndexedDB, opérations disque, export vidéo
- `libs/` — librairies de multiplexage/démultiplexage
- `tests/core.test.js` — tests automatisés de la logique pure

## Tests

Sans dépendance : `node tests/core.test.js` (30 tests : filtrage OU/ET, « sans tag », votes, tri, arborescence, formats, régression mosaïque >100).

## Notes techniques

- Stockage local : **IndexedDB** (tags, votes, vignettes, méta), cloisonné par dossier racine (clé interne : nom de racine + chemin).
- Les tags/votes sont indexés par **chemin relatif** : un déplacement/renommage hors de l'application ne sera pas suivi.
- Développement : branche par évolution + PR + **tag de version** synchronisé avec le badge de l'application.
- ⚠️ Les librairies `mp4box.all.js` et `mp4-muxer.js` doivent être téléchargées manuellement dans `libs/` (voir Installation).
