# Fiches Maintenance

Application desktop (Windows, [Electron](https://www.electronjs.org/)) pour générer des fiches d'intervention de maintenance GTB/GTC sur site, avec export en PDF. Pensée pour des techniciens en déplacement : saisie hors-ligne, photos prises sur place, aucune dépendance à un serveur ou une connexion internet.

## 1. Fonctionnalités

### Saisie de la fiche

Une fiche se construit en deux onglets :

- **Étapes** — une checklist fixe de 12 étapes standard du déroulé d'intervention (localisation des automates, photos, références, comptes d'accès, schémas électriques, accès à distance…). Chaque étape reçoit un statut (**OK** / **NOK** / **EN COURS**), une remarque libre et des photos. La liste est volontairement fixe (même déroulé à chaque intervention) — seuls le statut, la remarque et les photos sont modifiables.
- **Informations du site** — entièrement libre : le technicien crée ses propres catégories et champs (Texte, Photo, Choix + texte, Tableau), les renomme, les réorganise par glisser-déposer. Rien n'est pré-rempli : chaque site a sa propre structure.

### Export PDF

Deux versions du même rapport, générées depuis le même écran :

- **Export complet** — inclut les étapes de l'intervention et les informations du site. Usage interne.
- **Export client** — identique, mais sans la section "Étapes de l'intervention" (déroulé interne non destiné au client).

Le PDF peut être protégé par un mot de passe à l'ouverture (facultatif). La couverture affiche le logo, une photo du site, l'adresse, la date, le technicien et, si renseignées, ses coordonnées (téléphone / email).

### Bibliothèque de fiches

Les fiches enregistrées sont classées dans un explorateur façon gestionnaire de fichiers : une grille de dossiers (créés librement, par exemple un dossier par site) à la racine, puis les fiches en vignettes une fois entré dans un dossier. Depuis une fiche de la bibliothèque : l'ouvrir pour la compléter, la **réutiliser** pour une nouvelle visite du même site (les infos du site sont conservées, les étapes repartent à zéro), l'exporter vers un fichier pour la transférer sur un autre poste, ou la supprimer.

### Brouillon automatique

La fiche en cours de saisie est réécrite sur disque en continu (quelques secondes après chaque frappe). Fermer l'application en pleine saisie ne perd rien : au redémarrage, une boîte de dialogue propose de reprendre le brouillon.

### Transfert entre postes

Une fiche de la bibliothèque peut être exportée vers un fichier `.json` autoporteur (photos incluses), protégeable par mot de passe (chiffrement AES-256-GCM), pour être transférée par clé USB, mail ou réseau partagé et reprise sur un autre poste sans rien perdre.

## 2. Architecture

Application Electron classique à deux processus :

- **Main process** (`src/main/`) — Node.js complet : fenêtre de l'application, accès disque (bibliothèque de fiches, brouillon, dossiers), génération du PDF, chiffrement.
- **Renderer process** (`src/renderer/`) — l'interface (HTML/CSS/JS vanilla, sans framework), exécutée dans une page sans accès direct au système : elle ne communique avec le disque qu'au travers d'un pont sécurisé (`window.api`, exposé par `preload.js`).

```
src/
  main/
    main.js            fenêtre, IPC, export PDF, bibliothèque, dossiers, brouillon, chiffrement
    preload.js          pont sécurisé (contextBridge) entre le renderer et le main process
  renderer/
    index.html           structure des écrans, onglets, boîtes de dialogue
    app.js                état de l'application, rendu de l'interface, interactions
    styles.css
    assets/logo.png       logo affiché sur la couverture du PDF
  shared/
    reportTemplate.js   génère le HTML du rapport — utilisé à la fois pour l'aperçu écran et pour le PDF, afin qu'ils soient toujours identiques

resources/
  qpdf/                  binaire qpdf embarqué, utilisé pour protéger un PDF par mot de passe

build/
  icon.ico               icône de l'application (bureau, barre des tâches, exécutable)
```

## 3. Où sont stockées les données

Rien n'est stocké dans le dossier du projet : tout vit dans le dossier utilisateur de l'application (`%APPDATA%\fiches-maintenance` sous Windows), indépendant du code source :

```
fiches/<id>/fiche.json     une fiche enregistrée
fiches/<id>/photos/        ses photos, en fichiers séparés (pas en base64 dans le JSON)
folders.json                liste des dossiers de la bibliothèque
brouillon.json              la fiche en cours de saisie, non encore enregistrée
```

Séparer les photos du JSON évite d'avoir un fichier de plusieurs dizaines de mégaoctets par fiche : le renderer manipule des images (aperçu, saisie) mais c'est le main process qui les écrit/relit sur disque au bon moment.

## 4. Comment fonctionne l'export PDF

1. Le renderer construit un snapshot de la fiche (`getFicheSnapshot()`) et le transmet au main process.
2. `reportTemplate.js` transforme ce snapshot en une page HTML autonome (styles inclus) — le même module sert à l'aperçu à l'écran (dans une `<iframe>`) et à l'export, pour garantir qu'ils affichent exactement la même chose.
3. Le main process charge cette page dans une fenêtre Electron invisible et utilise `printToPDF` (Chromium) pour produire le fichier.
4. Si un mot de passe a été demandé, le PDF est ensuite chiffré via [qpdf](https://qpdf.sourceforge.io/) (outil libre embarqué dans `resources/qpdf/`) : Chromium seul ne sait pas poser de mot de passe d'ouverture standard sur un PDF, qpdf s'en charge en sous-processus.

## 5. Installation et développement

Prérequis : [Node.js](https://nodejs.org/).

```powershell
npm install       # installe les dépendances
npm start         # lance l'application depuis les sources
```

### Construire l'exécutable Windows

```powershell
npm run dist:win
```

Génère dans `dist/` un installeur (`Fiches Maintenance Setup <version>.exe`), une version portable, et le dossier décompressé (`dist/win-unpacked/`). L'exécutable embarque une copie figée du code (`app.asar`) : modifier `src/` ne change rien à un `.exe` déjà construit tant que ce script n'a pas été relancé.

### Signature de l'exécutable

```powershell
npm run sign
```

Signe l'exécutable généré avec le certificat configuré sur la machine (voir `scripts/sign-dist.ps1`). Sans certificat reconnu par Microsoft, un Windows avec le Contrôle intelligent des applications activé peut bloquer l'exécution sur un autre poste.

## 6. Stack technique

- [Electron](https://www.electronjs.org/) ^44
- [electron-builder](https://www.electron.build/) pour la construction de l'exécutable
- Aucune dépendance d'interface (pas de framework front) : HTML/CSS/JS natifs
- [qpdf](https://qpdf.sourceforge.io/) pour le chiffrement des PDF exportés
