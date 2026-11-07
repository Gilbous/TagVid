# TagVid 🎬

Application locale en **un seul fichier** (`index.html`) pour organiser, trier et visionner une arborescence de vidéos — sans installation, sans dépendance, sans serveur.

**Version actuelle : v1.23**

## Utilisation

1. Téléchargez `index.html` depuis ce dépôt.
2. Ouvrez-le avec **Chrome, Edge ou Opera** (l'API *File System Access* n'est pas supportée par Firefox/Safari).
3. Cliquez sur **« Choisir le dossier racine »** et autorisez l'accès en lecture.

Tout se passe en local : aucune donnée n'est envoyée sur le réseau.

## Fonctionnalités

### Arborescence et fichiers
- **Scan récursif** d'une racine paramétrable ; le dossier racine est mémorisé entre les sessions (bouton « Réouvrir le dernier dossier »).
- **Vue liste en arborescence dépliable** : chaque sous-répertoire s'ouvre/ferme d'un clic, avec comptage des fichiers ; l'état ouvert/fermé est persistant.
- Boutons **« Déplier tout » / « Replier tout »**.
- Bascule **vue liste ⇄ vue mosaïque**.

### Tags (4 groupes libres)
- **4 groupes de tags génériques** (« Tags 1 » à « Tags 4 »), 4 colonnes dans la vue liste.
- Tags libres, séparés par des virgules, éditables par fichier (boîte de dialogue avec un champ par groupe) ; retrait individuel par ✕.
- **Persistants en IndexedDB** (navigateur), indexés par chemin de fichier.
- **Export / import des tags en JSON** (sauvegarde ou partage) ; l'import lit l'ancien format mono-liste.

### Filtrage
- **Tags 1** : nuage de tags avec **recherche** et **index alphabétique** (seules les lettres présentes sont proposées) ; sélection en OU interne ; tag virtuel **« (sans tag) »** pour isoler les fichiers non taggés du groupe.
- **Tags 2-4** : tous les tags affichés, avec boutons radio **OU / ET** propres à chaque groupe.
- **Entre les groupes : toujours ET** — ex. `(Tags 1 : vacances OU plage) ET (Tags 2 : famille ET 2024)`.
- **Filtre par vote** : « toutes | ★+ | ★★+ | … | ★★★★★+ ».
- Bouton **« ↺ Réinitialiser les filtres »** (sélections, sans tag, vote, recherche, index).
- Compteur de fichiers affichés en temps réel.

### Mosaïque et visionneuse
- **Vignettes vidéo intelligentes** : la frame la plus lumineuse parmi 1, 3, 5, 7 et 9 s est retenue (évite les secondes noires de début) ; 320 px, JPEG, **mises en cache** en IndexedDB.
- Bouton **« Régénérer les vignettes »** : purge du cache et recalcul complet.
- **Contrôle au-delà de 100 vidéos** : confirmation demandée avant d'afficher une mosaïque de plus de 100 vidéos (au basculement ou lors d'un changement de filtre), défaut **Non** ; « Non » revient en vue liste.
- **Visionneuse intégrée plein écran** : lecture `<video>`, navigation **Précédent/Suivant** et au clavier.
- **Raccourcis clavier** : `←` −10 s, `→` +30 s, `↑` vidéo précédente, `↓` vidéo suivante, `Échap` fermer ; boutons de saut ±10/±30 s à l'écran.
- **Bouton « 🏷 Tags »** dans la visionneuse : édition des tags de la vidéo en cours.
- **Vote 1 à 5 étoiles** par vidéo (persistant), recliquer sur l'étoile active retire le vote ; étoiles affichées en vue liste (colonne « Vote ») et sur les vignettes.
- **Tri par vote ↓** (case à cocher) applicable aux deux modes d'affichage, non votés en dernier.

### Opérations physiques sur les fichiers
Depuis la visionneuse (le navigateur demande l'**autorisation d'écriture** sur le dossier racine au premier usage) :
- **🗑 Supprimer** : suppression physique du fichier, avec confirmation.
- **✏️ Renommer** : vérification d'**unicité du nom dans le répertoire** (redemande en cas de conflit).
- **📂 Déplacer** : choix du sous-répertoire **dans une liste des répertoires existants** (option « Nouveau sous-répertoire… » pour en créer un) ; vérification d'unicité dans le répertoire cible.
- **Tags, votes et vignettes migrent automatiquement** vers le nouveau chemin après renommage ou déplacement ; l'arborescence est rafraîchie après chaque opération.

## Structure du projet

- `index.html` — structure et styles (aucune logique)
- `app-core.js` — **logique pure** (filtres, tri, arborescence, formats) : sans DOM ni IndexedDB, testable avec Node
- `app.js` — interface, persistance IndexedDB, opérations disque
- `tests/core.test.js` — tests automatisés de la logique pure

## Tests

Sans aucune dépendance ni environnement de développement :

```
node tests/core.test.js
```

30 tests couvrent notamment : filtrage (OU intra-groupe, ET inter-groupes, « sans tag », vote minimum), tri par vote, arborescence, formats, et une **régression** sur le contrôle mosaïque >100 vidéos.

## Notes techniques

- Aucune dépendance, aucun framework : HTML + CSS + JavaScript pur.
- Stockage local : **IndexedDB** (bases `tags`, `ratings`, `thumbs`, `meta`) dans le navigateur, cloisonnées par dossier racine.
- Les tags/votes sont indexés par le **chemin relatif** du fichier : un déplacement/renommage hors de l'application ne sera pas suivi (utiliser les boutons intégrés).
- Vérifiez le **badge de version** en haut à droite de l'application pour vous assurer d'exécuter la dernière version publiée. Chaque version est aussi taguée dans ce dépôt (onglet *Tags*).
- Développement : chaque évolution est livrée via une **branche dédiée + pull request**, puis taguée.
