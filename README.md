# Fiches Maintenance — document de passation

À lire avant toute modification. Le code est fonctionnel et testé de bout en bout (aperçu, brouillon, bibliothèque, export PDF) ; plusieurs choix qui paraissent bizarres sont en réalité des correctifs de bugs mesurés. Ne les défais pas sans lire la section « Pièges ».

## 1. Ce que fait l'application

Application desktop Electron pour générer des fiches de maintenance sur site, exportées en PDF. Utilisateurs : techniciens GTB en intervention, transfert de photos depuis le téléphone via un drive partagé.

Parcours : écran d'accueil (nouvelle fiche ou reprise d'une fiche enregistrée) → saisie en deux onglets (Étapes / Informations du site) → aperçu → export PDF.

## 2. Arborescence

```
src/main/main.js           fenêtre, IPC, export PDF, brouillon, bibliothèque
src/main/preload.js        contextBridge (window.api)
src/renderer/index.html    écrans, onglets, boîtes de dialogue
src/renderer/app.js        état, rendu, interactions
src/renderer/styles.css
src/shared/reportTemplate.js  génération du HTML du rapport (UMD)
src/renderer/assets/       logo.png
resources/qpdf/            binaire qpdf embarqué (protection du PDF par mot de passe, voir section 4)
build/icon.ico             icône de l'EXE
```

`reportTemplate.js` est un module UMD chargé des deux côtés : par le main process pour l'export PDF, et par le renderer via `<script>` pour l'aperçu (`window.api`-free, iframe `srcdoc`). C'est ce qui garantit que l'aperçu et le PDF sont identiques. Ne le transforme pas en module ES.

Versions actuelles : Electron ^44.0.0, electron-builder ^24.13.3. Scripts : `npm start`, `npm run dist`, `npm run sign`.

## 3. Modèle de données
h
État central dans `app.js`, objet `state` :

```js
{
  fiche: { technicien, site, adresse, date, photo },  // photo = couverture ou null
  logo,          // data URL, lue par le main process
  categories: [],// ordre = numérotation du sommaire (2.1, 2.2…) — vide par defaut
  champs: [],    // tableau plat, la catégorie est stockée par NOM
  etapes: [],    // liste fixe, voir DEFAULT_ETAPES
  ficheId        // id dans la bibliothèque, null si jamais enregistrée
}
```

Champ — typé :

```js
{ id, nom, categorie, type, photos: [] }
// type 'texte'   -> remarques: ''
// type 'photo'   -> aucune case de texte, juste des photos
// type 'choix'   -> options: ['OUI','NON'], valeur: '', remarques: '' (note libre facultative)
// type 'tableau' -> colonnes: [...], lignes: [[...], ...]
```

Étape : `{ id, nom, statut: 'OK'|'NOK'|'EN COURS'|'', remarques, photos: [] }` — `''` = non renseigné, état de départ (rien de présélectionné).

Photo : `{ id, name, dataUrl }` côté renderer, plus `file` quand elle provient du disque.

**Aucune catégorie ni champ par défaut** : l'onglet « Informations du site » part vide, le technicien construit sa propre structure avec « + Nouvelle catégorie » / « + Ajouter » un champ.

**Étapes fixes**, toujours les mêmes 12, dans cet ordre (voir `DEFAULT_ETAPES` dans `app.js`) : Localisation des automates, Photo des automates, Références des automates et des modules, Communication tierce, Vérification des états des armoires, Présence des schémas électriques des armoires, Localisation de l'ordinateur de la GTC, Utilisateurs de l'ordinateur (Login/Mot de passe), Utilisateurs de la GTC (Login/Mot de passe), Screenshot de la GTC, Informations de l'ordinateur (IP, Stockage), Vérification des accès à distance. Ni renommables, ni supprimables, ni réordonnables côté interface — seuls le statut, la remarque et les photos sont modifiables.

## 4. Fonctionnalités en place

**Couverture PDF** : photo du site facultative (bandeau dégradé si absente, cadre fixe 92mm de haut avec `object-fit: contain` sinon — robuste même si la photo n'a pas le bon ratio), logo, titre, site, adresse, date, technicien.

**Sommaire** en page 2, numéroté à deux niveaux, construit dynamiquement depuis les catégories réellement documentées. Chaque catégorie démarre sur une nouvelle page dans le PDF (sauf la première de la section).

**Étapes** : toutes imprimées, tableau compact, pastille de statut (vert OK / rouge NOK / orange EN COURS / gris NON RENSEIGNÉ), remarque texte facultative affichée sous le nom.

**Informations du site** : champs typés (Texte / Photo / Choix + texte / Tableau), renommables (sauf le type, fixé à la création), réorganisables par glisser-déposer. Catégories renommables, supprimables, réorganisables. Un champ « Texte » ou « Photo » peut n'avoir qu'une photo sans aucun texte — le PDF n'affiche pas « Non renseigné » à côté dans ce cas.

**Modifier les infos** : les quatre champs d'accueil et la photo restent modifiables après le démarrage de la fiche.

**Brouillon** : la fiche en cours est écrite dans `userData/brouillon.json` 2,5 s après la dernière frappe. Fermer la fenêtre pendant une saisie déclenche une confirmation native. Au démarrage, une boîte propose de reprendre.

**Bibliothèque** : `userData/fiches/<id>/fiche.json` + `photos/*.jpg`. Actions : Ouvrir, Réutiliser, Supprimer. Recherche sur site / adresse / technicien. Un export PDF réussi enregistre automatiquement.

**Dossiers de la bibliothèque** (facultatifs, `userData/folders.json` : `[{ id, nom }]`) : purement un regroupement visuel dans l'onglet « Fiches enregistrées » — utile pour retrouver une fiche des années plus tard (un dossier par site) ou simplement s'organiser. Rangée de « puces » filtrantes au-dessus de la liste (Tous / Non classées / un par dossier, plus la création) plutôt qu'une arborescence imbriquée : pas de sous-dossiers, une fiche n'appartient qu'à un seul dossier à la fois. La recherche texte se combine avec le filtre de dossier, elle ne le remplace pas. Le champ `folderId` est stocké dans `fiche.json` de chaque fiche (pas dans `folders.json`) ; supprimer un dossier ne supprime jamais les fiches qu'il contient, elles repassent en « Non classées ». « Réutiliser » (voir plus bas) reporte automatiquement le dossier de la fiche d'origine sur la nouvelle fiche, dès son premier enregistrement — c'est le scénario principal visé (retrouver le dossier d'un site des années après une nouvelle visite).

**« Réutiliser »** conserve les informations du site (références, IP, tableaux, photos de matériel) mais remet les étapes à l'état non renseigné (pas de statut présélectionné, pas de remarque, pas de photo) et la date au jour même.

**Import/export d'une fiche entre deux postes** : une fiche de la bibliothèque peut être exportée vers un fichier `.json` autoporteur (photos incluses en base64), à transférer par clé USB/mail/réseau, puis importée sur un autre poste pour reprendre la saisie là où elle en était. Mot de passe facultatif à l'export (chiffrement AES-256-GCM) : si renseigné, le contenu du fichier n'est lisible qu'avec ce mot de passe, redemandé à l'import. L'aperçu à l'écran, lui, ne masque jamais rien : celui qui travaille sur la fiche dans l'appli est considéré de confiance et voit tout.

**Protection du PDF exporté par mot de passe** : même principe que l'export/import ci-dessus (mot de passe facultatif demandé juste avant l'enregistrement, vide = pas de protection), mais appliqué cette fois au PDF final. Contrairement au JSON d'export/import, un PDF a son propre format de chiffrement normalisé que les lecteurs doivent reconnaître pour proposer une invite de mot de passe standard — les modules `crypto` intégrés à Node ne suffisent pas à le produire, contrairement au cas du JSON. Le PDF est donc chiffré via [qpdf](https://qpdf.sourceforge.io/) (outil libre, Apache-2.0), embarqué dans `resources/qpdf/` et appelé en sous-processus par `main.js` (`protegerPdf()`), avec AES-256 et le même mot de passe côté lecture et côté propriétaire (aucune restriction d'impression/copie imposée — juste un mot de passe à l'ouverture). Ancienne décision assumée du projet, désormais revue à la demande : le PDF n'était jusque-là jamais chiffré.

**Compression rétroactive des photos** : à l'ouverture d'une fiche (bibliothèque) ou reprise d'un brouillon, chaque photo est revérifiée et recompressée sur place si elle dépasse encore un ancien réglage de qualité — les photos capturées avant un changement de compression se corrigent automatiquement à la prochaine ouverture, pas seulement les nouvelles.

## 5. Pièges — ne pas défaire

`object-fit: cover` est interdit dans `reportTemplate.js`. Mesuré : avec `cover`, Chromium ré-encode l'image sans compression dans le PDF — 3 545 ko au lieu de 575 ko pour la même photo, ce qui faisait ramer le lecteur au défilement. `contain` conserve le JPEG d'origine. La photo de couverture est bornée à un cadre fixe (92mm) avec `object-fit: contain` : ni recadrage ni ré-encodage, juste une protection si la photo n'est pas déjà au bon ratio.

Le conteneur `.photos` (galerie de photos d'un champ/étape) est en `display: block` avec des photos en `inline-block`, pas en `flex`. Un conteneur flex ne se fragmente pas proprement à l'impression dans Chromium : le bloc entier saute d'un coup sur la page suivante en laissant une zone blanche derrière lui. Chaque `.photo` garde son propre `break-inside: avoid` (une photo ne se coupe jamais en deux), mais le groupe peut désormais se répartir naturellement entre deux pages.

Les lignes de tableau (`.grid tr`) qui enveloppent un sous-tableau entier ou un bloc de photos portent une classe (`row-subtable`, `row-photos`) qui **annule** le `break-inside: avoid` hérité — sinon, exactement le même problème que ci-dessus : tout le bloc saute sur la page suivante au lieu de s'enchaîner.

`escapeHtml()`/`esc()` doivent échapper les guillemets et apostrophes. Ces valeurs partent dans des attributs (`value="…"`, `alt="…"`) et les noms de champs/catégories sont saisis à la main. Bug déjà corrigé une fois.

Le logo est lu par le main process, pas par la page (`readLogoDataUrl()` dans `main.js`). Une page `file://` ne peut ni faire un fetch local, ni dessiner une image `file://` dans un canvas (erreur de sécurité). Mis en cache pour la session — si tu remplaces `logo.png`, relance l'appli.

Les photos sont externalisées côté main, pas côté renderer (`externaliserPhoto()` / `reinjecterPhoto()` dans `main.js`). Le renderer ne manipule que des data URL. Une fiche recompressée en mémoire (voir compression rétroactive) doit faire `delete photo.file` avant le prochain enregistrement, sinon `externaliserPhoto()` garde l'ancien fichier lourd sur disque au lieu d'écrire la nouvelle version.

Le renommage d'une catégorie se valide sur `change`, pas sur `input` (redessine toute la liste, un renommage à chaque frappe ferait perdre le focus). Le renommage d'un champ, lui, est sur `input` car il ne redessine rien.

Le glisser-déposer (champs, catégories) n'est armé qu'au `mousedown` sur la poignée. Si la ligne était `draggable` en permanence, on ne pourrait plus sélectionner de texte dans les champs de saisie.

La classe `.category-card` est utilisée aussi par l'onglet Étapes. Tout sélecteur global sur cette classe attrape une carte de trop. Scope sur `#categorySections`.

Les marges de `printToPDF` dans `main.js` et le padding sous `@media screen` dans `reportTemplate.js` doivent rester cohérents, sinon l'aperçu et le PDF divergent.

Filtrage à l'export : toutes les étapes sont imprimées ; les champs le sont seulement s'ils sont renseignés (`fieldHasContent()`, adapté à chaque type — une photo seule suffit, même sans texte).

Le chiffrement du fichier d'export/import (`chiffrerJson()`/`dechiffrerJson()` dans `main.js`) est fait avec les modules intégrés à Node (`crypto`, AES-256-GCM, sel aléatoire par export) — aucune dépendance ajoutée pour ça. L'aperçu, lui, n'est jamais masqué (voir section 4).

Le chemin de `qpdf.exe` (protection du PDF) diffère entre `npm start` (source, non empaqueté) et un EXE de `dist\` : `qpdfExePath()` dans `main.js` teste `app.isPackaged` pour choisir entre `resources/qpdf/` à la racine du projet et `process.resourcesPath/qpdf/` une fois empaqueté. Si le dossier `resources/qpdf/` disparaît ou que `extraResources` est retiré de `package.json`, l'export avec mot de passe échoue proprement (erreur remontée au renderer) — il n'y a jamais de repli silencieux vers un PDF non protégé alors qu'un mot de passe a été demandé.

La CSP dans `index.html` inclut `'unsafe-inline'` sur `style-src` : l'iframe d'aperçu (`srcdoc`) hérite de cette policy, et `reportTemplate.js` y injecte son CSS dans un `<style>` inline. La retirer casse l'aperçu silencieusement.

Constantes de qualité photo en haut de `app.js` : `PHOTO_MAX_DIM = 570` (≈180 ppi sur la page, choisi pour limiter le poids du PDF), `COVER_WIDTH = 1600`, `COVER_RATIO = 182/92`.

## 6. Signature de l'EXE — non résolu

Les EXE générés par `npm run dist` ne sont **pas signés**. Sur un Windows avec le Contrôle intelligent des applications (Smart App Control) activé, l'exécution peut être bloquée sans possibilité de passer outre depuis la boîte de dialogue. Deux voies réelles, décision à prendre :

- **Azure Trusted Signing** (~10 $/mois) — certificat reconnu, la voie la plus simple à long terme.
- **Déploiement via l'IT Veolia avec une règle WDAC** — pas de coût récurrent, dépend de l'IT.

Un certificat auto-signé (générer localement + `certutil -addstore` sur chaque poste) fonctionne mais ne passe pas le Contrôle intelligent des applications, qui exige une chaîne remontant à une autorité du Trusted Root Program de Microsoft.

`npm run sign` (voir `scripts/sign-dist.ps1`) existe et signe avec le certificat configuré sur cette machine — utile seulement une fois la voie de signature définitive choisie. Il signe aussi `qpdf.exe` (embarqué dans `resources/qpdf/`, voir section 4) : c'est un sous-processus lancé par l'app, que Smart App Control peut évaluer indépendamment de l'exe principal à l'exécution.

## 7. Dette technique restante

- Photos en base64 en mémoire côté renderer : le brouillon réécrit tout le JSON à chaque pause de saisie. Passer à des `Blob` + object URLs, et transmettre des `Uint8Array` par IPC, réduirait la charge — pas fait, l'appli reste fluide en pratique grâce à la compression.
- `sandbox: false` dans `main.js` (fenêtre principale et fenêtre d'export PDF) : probablement inutile, le preload n'utilise que `contextBridge`/`ipcRenderer` qui fonctionnent en preload sandboxé. Changement à faible risque, pas encore fait.

## 8. Vérifications après modification

```powershell
npm start                      # tester depuis les sources, jamais un EXE de dist\
```

Un EXE embarque un `app.asar` figé : modifier `src/` ne change rien tant que `npm run dist` n'a pas tourné. Et `npm run sign` doit suivre chaque `dist` une fois la signature réglée (le hash Authenticode change à chaque build).

Scénarios à repasser après toute modification touchant l'état ou le PDF :

- Créer une fiche, construire une catégorie avec un champ « Photo » seule (sans texte), cocher un NOK avec remarque sur une étape, exporter — vérifier l'absence de lag.
- Renommer une catégorie contenant un guillemet, déplacer un champ, vérifier que rien n'est tronqué.
- Fermer la fenêtre en cours de saisie, relancer, reprendre le brouillon.
- Enregistrer, relancer, rouvrir depuis la bibliothèque : photos rechargées, taille des anciennes photos réduite automatiquement.
- Réutiliser une fiche : infos site conservées, étapes remises à l'état non renseigné.
- Exporter une fiche vers un fichier avec un mot de passe, l'importer (mauvais mot de passe puis bon, sans rouvrir le sélecteur de fichier entre les deux).
- Exporter un PDF avec un mot de passe, l'ouvrir dans un lecteur PDF (navigateur, Adobe…) : le mot de passe doit être demandé, un mauvais mot de passe doit être refusé. Exporter sans mot de passe : comportement inchangé, PDF non protégé. À refaire après tout `npm run dist` (le binaire `qpdf.exe` empaqueté doit être présent dans `resources/qpdf/` du build).
- Créer un dossier dans la bibliothèque, y déplacer une fiche depuis le sélecteur de chaque carte, vérifier le filtre « Non classées » et la recherche à l'intérieur d'un dossier. Supprimer un dossier : ses fiches doivent rester intactes et repasser en « Non classées ». Réutiliser une fiche d'un dossier et l'enregistrer : la nouvelle fiche doit apparaître dans le même dossier sans action supplémentaire.
