# TagVid 🎬

Application locale en **un seul fichier** (`index.html`) pour organiser et visionner une arborescence de vidéos — sans installation, sans dépendance, sans serveur.

## Utilisation

1. Téléchargez `index.html`.
2. Ouvrez-le avec **Chrome, Edge ou Opera** (l'API *File System Access* n'est pas supportée par Firefox/Safari).
3. Cliquez sur **« Choisir le dossier racine »** et autorisez l'accès en lecture.

## Fonctionnalités

- **Scan récursif** d'une arborescence à partir d'une racine paramétrable (mémorisée entre les sessions).
- **Tags libres** par fichier, persistés dans le navigateur (IndexedDB).
- **Filtrage par tags** : mode « tous les tags » (ET) ou « au moins un » (OU).
- **Vue liste** et **vue mosaïque** avec vignettes vidéo générées automatiquement (capture canvas, mises en cache).
- **Visionneuse intégrée** plein écran : navigation précédent/suivant, flèches ← →, Échap pour fermer.
- **Export / import des tags** en JSON.

## Notes

- Les tags sont indexés par le chemin relatif du fichier : si vous déplacez/renommez des fichiers dans l'arborescence, leurs tags ne suivront pas.
- Tout se passe en local : aucune donnée n'est envoyée sur le réseau.
