(function () {
  'use strict';

  const OUI_NON = ['OUI', 'NON'];

  // Etapes fixes de l'onglet "Etapes" : liste plate, ordonnee, imposee. Pas
  // de renommage, d'ajout ni de suppression cote interface (voir
  // buildEtapeRow) — c'est le meme deroule d'intervention a chaque fiche.
  const DEFAULT_ETAPES = [
    'Localisation des automates',
    'Photo des automates',
    'Références des automates et des modules',
    'Communication tierce',
    'Vérification des états des armoires',
    'Présence des schémas électriques des armoires',
    "Localisation de l'ordinateur de la GTC",
    "Utilisateurs de l'ordinateur (Login/Mot de passe)",
    'Utilisateurs de la GTC (Login/Mot de passe)',
    'Screenshot de la GTC',
    "Informations de l'ordinateur (IP, Stockage)",
    'Vérification des accès à distance'
  ];

  const NO_PHOTO_LABEL = 'Aucune photo — la couverture utilisera un bandeau de couleur';

  // Zone de couverture dans le PDF : 182 mm de large (A4 moins les marges)
  // sur 92 mm de haut. La photo est recadree a ce ratio des l'import, ce qui
  // evite d'avoir a la recadrer en CSS cote PDF.
  const COVER_RATIO = 182 / 92;
  const COVER_WIDTH = 1600;   // ~223 ppi sur la page, suffisant pour l'impression

  // Photos de champs et d'etapes : affichees a 80 mm de large dans le PDF.
  // 570 px donnent environ 180 ppi a cette taille, choisi pour limiter le
  // poids du PDF (donc le lag au defilement) sur les fiches a beaucoup de
  // photos. Suffisant pour une photo consultee a l'ecran ou imprimee.
  const PHOTO_MAX_DIM = 570;

  const state = {
    // photo : { name, dataUrl } ou null (photo de couverture, facultative)
    // telephone/email : coordonnees facultatives du technicien, affichees sur
    // la couverture du PDF quand elles sont renseignees.
    fiche: { technicien: '', site: '', adresse: '', date: todayISO(), telephone: '', email: '', photo: null },
    // logo de couverture, lu par le main process dans src/renderer/assets/
    logo: null,
    // Aucune categorie/champ par defaut : l'onglet "Informations du site"
    // part vide, le technicien construit sa propre structure.
    categories: [],
    // Chaque "champ" : { id, nom, categorie, type, photos, ... selon le type }
    //   type 'texte'   -> remarques: ''
    //   type 'choix'   -> options: [...], valeur: '' (vide = non renseigné)
    //   type 'tableau' -> colonnes: [...], lignes: [[...], ...]
    champs: [],
    // Chaque "etape" : { id, nom, statut: 'OK'|'NOK'|'EN COURS'|'', remarques, photos: [] }
    // ('' = non renseigne, etat de depart). Liste fixe : voir DEFAULT_ETAPES.
    etapes: [],
    // Identifiant dans la bibliotheque. null = fiche jamais enregistree.
    ficheId: null
  };

  // ---------- Helpers ----------
  function $(id) { return document.getElementById(id); }

  function uuid() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
      return window.crypto.randomUUID();
    }
    return 'id-' + Date.now() + '-' + Math.random().toString(16).slice(2);
  }

  function todayISO() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  // Echappe aussi les guillemets : ces valeurs sont injectees dans des
  // attributs HTML (value="...", alt="..."), et un nom de champ contenant
  // une apostrophe ou un guillemet casserait l'attribut.
  function escapeHtml(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function showToast(message, type) {
    const container = $('toastContainer');
    const toast = document.createElement('div');
    toast.className = `toast ${type || ''}`.trim();
    toast.textContent = message;
    container.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add('show'));
    setTimeout(() => {
      toast.classList.remove('show');
      setTimeout(() => toast.remove(), 250);
    }, 3500);
  }

  function confirmAction(message, onConfirm) {
    const dlg = $('confirmDialog');
    $('confirmMessage').textContent = message;
    const okBtn = $('confirmOkBtn');
    const cancelBtn = $('confirmCancelBtn');

    function onOk() { dlg.close('confirm'); }
    function onCancel() { dlg.close('cancel'); }

    // Le nettoyage passe par l'evenement natif 'close' (et non les clics eux-memes)
    // pour rester correct meme si l'utilisateur ferme la boite avec la touche Echap.
    function onDialogClose() {
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      dlg.removeEventListener('close', onDialogClose);
      const confirmed = dlg.returnValue === 'confirm';
      dlg.returnValue = '';
      if (confirmed) onConfirm();
    }

    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    dlg.addEventListener('close', onDialogClose);
    dlg.showModal();
  }

  // Petite boite de saisie generique, utilisee pour editer la liste des choix
  // d'un champ (et, avec opts.type = 'password', pour la saisie d'un mot de
  // passe d'export/import). Meme mecanique de nettoyage que confirmAction.
  function promptDialog(title, hint, initialValue, onValidate, opts) {
    const dlg = $('promptDialog');
    $('promptTitle').textContent = title;
    $('promptHint').textContent = hint;
    const input = $('promptInput');
    input.type = (opts && opts.type) || 'text';
    input.value = initialValue || '';

    const okBtn = $('promptOkBtn');
    const cancelBtn = $('promptCancelBtn');

    function onOk() { dlg.close('confirm'); }
    function onCancel() { dlg.close('cancel'); }
    function onKeydown(e) {
      if (e.key === 'Enter') { e.preventDefault(); onOk(); }
    }

    function onDialogClose() {
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      input.removeEventListener('keydown', onKeydown);
      dlg.removeEventListener('close', onDialogClose);
      const confirmed = dlg.returnValue === 'confirm';
      dlg.returnValue = '';
      input.type = 'text'; // etat par defaut pour le prochain usage partage de cette boite
      if (confirmed) onValidate(input.value);
    }

    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    input.addEventListener('keydown', onKeydown);
    dlg.addEventListener('close', onDialogClose);
    dlg.showModal();
    input.focus();
    input.select();
  }

  // "OUI ; NON ; EN COURS" -> ['OUI', 'NON', 'EN COURS']
  function parseList(raw) {
    return String(raw || '')
      .split(/[;\n]/)
      .map((s) => s.trim())
      .filter(Boolean);
  }

  function resizeImage(file, maxDim, quality) {
    maxDim = maxDim || PHOTO_MAX_DIM;
    quality = quality || 0.75;
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        const img = new Image();
        img.onload = () => {
          let { width, height } = img;
          if (width > maxDim || height > maxDim) {
            if (width >= height) {
              height = Math.round(height * (maxDim / width));
              width = maxDim;
            } else {
              width = Math.round(width * (maxDim / height));
              height = maxDim;
            }
          }
          const canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, width, height);
          resolve(canvas.toDataURL('image/jpeg', quality));
        };
        img.onerror = () => reject(new Error('Image illisible'));
        img.src = e.target.result;
      };
      reader.onerror = () => reject(new Error('Lecture du fichier impossible'));
      reader.readAsDataURL(file);
    });
  }

  // Recadrage centre au ratio demande, puis reduction. Sert uniquement a la
  // photo de couverture.
  function cropImageToRatio(file, ratio, targetWidth, quality) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        const img = new Image();
        img.onload = () => {
          const sourceRatio = img.width / img.height;
          let sx = 0, sy = 0, sw = img.width, sh = img.height;

          if (sourceRatio > ratio) {
            sw = Math.round(img.height * ratio);
            sx = Math.round((img.width - sw) / 2);
          } else {
            sh = Math.round(img.width / ratio);
            sy = Math.round((img.height - sh) / 2);
          }

          const width = Math.min(targetWidth, sw);
          const height = Math.round(width / ratio);

          const canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, sx, sy, sw, sh, 0, 0, width, height);
          resolve(canvas.toDataURL('image/jpeg', quality || 0.78));
        };
        img.onerror = () => reject(new Error('Image illisible'));
        img.src = e.target.result;
      };
      reader.onerror = () => reject(new Error('Lecture du fichier impossible'));
      reader.readAsDataURL(file);
    });
  }

  // ---------- Compression retroactive (fiches/brouillons anciens) ----------
  // resizeImage()/cropImageToRatio() ne s'appliquent qu'a l'import d'une
  // photo. Une fiche enregistree avec une version anterieure de l'appli (ou
  // avant un reglage de compression plus agressif) garde donc ses photos a
  // l'ancienne taille pour toujours, meme si le code change. Pour eviter
  // d'avoir a rouvrir chaque photo a la main, on revalide la taille de
  // chaque photo au chargement d'une fiche/d'un brouillon, et on la
  // recompresse sur place si besoin. N'a aucun effet (ni recompression, ni
  // perte) sur une photo deja a la bonne taille : le round-trip s'arrete des
  // que les dimensions sont lues.
  function shrinkDataUrlIfNeeded(dataUrl, maxDim, quality) {
    return new Promise((resolve) => {
      if (!dataUrl) { resolve(dataUrl); return; }
      const img = new Image();
      img.onload = () => {
        if (img.width <= maxDim && img.height <= maxDim) { resolve(dataUrl); return; }
        let { width, height } = img;
        if (width >= height) {
          height = Math.round(height * (maxDim / width));
          width = maxDim;
        } else {
          width = Math.round(width * (maxDim / height));
          height = maxDim;
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        canvas.getContext('2d').drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', quality || 0.75));
      };
      // Data URL illisible : on la laisse telle quelle plutot que de perdre la photo.
      img.onerror = () => resolve(dataUrl);
      img.src = dataUrl;
    });
  }

  async function shrinkPhotosIfNeeded(photos) {
    const list = Array.isArray(photos) ? photos : [];
    await Promise.all(list.map(async (photo) => {
      if (!photo || !photo.dataUrl) return;
      const shrunk = await shrinkDataUrlIfNeeded(photo.dataUrl, PHOTO_MAX_DIM, 0.75);
      if (shrunk !== photo.dataUrl) {
        photo.dataUrl = shrunk;
        // Force externaliserPhoto() (main.js) a reecrire le fichier au lieu
        // de garder l'ancien sur disque : sans ca, l'enregistrement suivant
        // conserverait la version lourde puisqu'une reference "file" valide
        // existe deja.
        delete photo.file;
      }
    }));
  }

  // Meme logique pour une fiche/un brouillon complet : tous les champs,
  // toutes les etapes, et la photo de couverture (bornee a COVER_WIDTH).
  async function shrinkFicheEnMemoire(donnees) {
    const champs = Array.isArray(donnees.champs) ? donnees.champs : [];
    const etapes = Array.isArray(donnees.etapes) ? donnees.etapes : [];

    await Promise.all([
      ...champs.map((c) => shrinkPhotosIfNeeded(c.photos)),
      ...etapes.map((e) => shrinkPhotosIfNeeded(e.photos))
    ]);

    const photo = donnees.fiche && donnees.fiche.photo;
    if (photo && photo.dataUrl) {
      const shrunk = await shrinkDataUrlIfNeeded(photo.dataUrl, COVER_WIDTH, 0.78);
      if (shrunk !== photo.dataUrl) {
        photo.dataUrl = shrunk;
        delete photo.file;
      }
    }
  }

  function cssEscape(value) {
    return String(value).replace(/["\\]/g, '\\$&');
  }

  function formatDateFrShort(iso) {
    const parts = String(iso || '').split('-');
    if (parts.length !== 3) return iso || '';
    return `${parts[2]}/${parts[1]}/${parts[0]}`;
  }

  // ---------- Fabrique de champs ----------
  function createField(descriptor, categorie) {
    const desc = typeof descriptor === 'string' ? { nom: descriptor } : (descriptor || {});
    const type = desc.type || 'texte';

    const field = {
      id: uuid(),
      nom: desc.nom || '',
      categorie,
      type,
      remarques: '',
      photos: []
    };

    if (type === 'choix') {
      field.options = (desc.options && desc.options.length ? desc.options : OUI_NON).slice();
      field.valeur = '';
    }

    if (type === 'tableau') {
      const colonnes = desc.colonnes && desc.colonnes.length
        ? desc.colonnes.slice()
        : ['Colonne 1', 'Colonne 2'];
      field.colonnes = colonnes;
      field.lignes = [colonnes.map(() => '')];
    }

    return field;
  }

  // ---------- Logo de couverture ----------
  // Lu par le main process : une page file:// ne peut pas charger le fichier
  // elle-meme (fetch local interdit, canvas "tainted").
  if (window.api && typeof window.api.getLogo === 'function') {
    window.api.getLogo()
      .then((logo) => { state.logo = logo || null; })
      .catch(() => { state.logo = null; });
  }

  // ---------- Sélecteur de photo réutilisable ----------
  // Utilise deux fois : sur l'ecran d'accueil et dans la boite "Modifier les
  // infos". Garde sa propre copie de la photo, ce qui permet d'annuler la
  // boite de dialogue sans toucher a l'etat de la fiche.
  function createPhotoPicker(ids) {
    const preview = $(ids.preview);
    const pickBtn = $(ids.pick);
    const removeBtn = $(ids.remove);
    const input = $(ids.input);
    let current = null;

    function render() {
      preview.innerHTML = '';
      if (current && current.dataUrl) {
        const img = document.createElement('img');
        img.src = current.dataUrl;
        img.alt = current.name || 'Photo du site';
        preview.appendChild(img);
        removeBtn.classList.remove('hidden');
        pickBtn.textContent = 'Remplacer la photo';
      } else {
        const span = document.createElement('span');
        span.className = 'photo-picker-empty';
        span.textContent = NO_PHOTO_LABEL;
        preview.appendChild(span);
        removeBtn.classList.add('hidden');
        pickBtn.textContent = 'Choisir une photo';
      }
    }

    pickBtn.addEventListener('click', () => input.click());

    removeBtn.addEventListener('click', () => {
      current = null;
      render();
    });

    input.addEventListener('change', async (e) => {
      const file = (e.target.files || [])[0];
      e.target.value = '';
      if (!file) return;
      try {
        const dataUrl = await cropImageToRatio(file, COVER_RATIO, COVER_WIDTH, 0.78);
        current = { name: file.name, dataUrl };
        render();
      } catch (err) {
        showToast('Photo ignorée : ' + err.message, 'error');
      }
    });

    render();

    return {
      get: () => current,
      set: (photo) => {
        current = photo && photo.dataUrl ? { name: photo.name, dataUrl: photo.dataUrl } : null;
        render();
      }
    };
  }

  const homePhotoPicker = createPhotoPicker({
    preview: 'homePhotoPreview',
    pick: 'btnHomePhotoPick',
    remove: 'btnHomePhotoRemove',
    input: 'homePhotoInput'
  });

  const editPhotoPicker = createPhotoPicker({
    preview: 'editPhotoPreview',
    pick: 'btnEditPhotoPick',
    remove: 'btnEditPhotoRemove',
    input: 'editPhotoInput'
  });

  // ---------- Brouillon ----------
  // La fiche en cours est ecrite sur disque en continu. Ce n'est pas une
  // persistance entre deux fiches : "Nouvelle fiche" et le refus de reprise
  // effacent le brouillon. C'est uniquement un filet contre une fermeture
  // accidentelle en pleine intervention.
  const DRAFT_DEBOUNCE_MS = 2500;
  let draftTimer = null;
  let ficheDemarree = false;

  function draftAvailable() {
    return Boolean(window.api && typeof window.api.draftSave === 'function');
  }

  function buildDraft() {
    return {
      version: 1,
      savedAt: new Date().toISOString(),
      fiche: state.fiche,
      ficheId: state.ficheId,
      categories: state.categories,
      champs: state.champs,
      etapes: state.etapes
    };
  }

  function scheduleDraftSave() {
    if (!ficheDemarree || !draftAvailable()) return;
    if (draftTimer) clearTimeout(draftTimer);
    draftTimer = setTimeout(() => {
      draftTimer = null;
      window.api.draftSave(buildDraft()).catch(() => {
        // Echec d'ecriture : on ne derange pas le technicien en pleine saisie,
        // la prochaine sauvegarde reessaiera.
      });
    }, DRAFT_DEBOUNCE_MS);
  }

  function clearDraft() {
    if (draftTimer) { clearTimeout(draftTimer); draftTimer = null; }
    if (draftAvailable()) window.api.draftClear().catch(() => {});
  }

  function setFicheEnCours(value) {
    ficheDemarree = value;
    if (window.api && typeof window.api.setFicheEnCours === 'function') {
      window.api.setFicheEnCours(value);
    }
  }

  // Au demarrage, aucune fiche n'est ouverte : la fermeture ne doit rien demander.
  setFicheEnCours(false);

  // Toute frappe ou tout clic dans l'ecran de saisie repousse l'enregistrement.
  // Ecouteurs en phase de remontee : ils passent apres les gestionnaires des
  // elements, donc apres la mise a jour de l'etat.
  ['input', 'change', 'click'].forEach((type) => {
    document.addEventListener(type, (e) => {
      if (e.target && e.target.closest && e.target.closest('#screen-fiche')) {
        scheduleDraftSave();
      }
    });
  });

  async function restoreDraft(draft) {
    await shrinkFicheEnMemoire(draft);

    state.fiche = {
      technicien: (draft.fiche && draft.fiche.technicien) || '',
      site: (draft.fiche && draft.fiche.site) || '',
      adresse: (draft.fiche && draft.fiche.adresse) || '',
      date: (draft.fiche && draft.fiche.date) || todayISO(),
      telephone: (draft.fiche && draft.fiche.telephone) || '',
      email: (draft.fiche && draft.fiche.email) || '',
      photo: (draft.fiche && draft.fiche.photo) || null
    };
    state.categories = Array.isArray(draft.categories) ? draft.categories : [];
    state.champs = Array.isArray(draft.champs) ? draft.champs : [];
    state.etapes = Array.isArray(draft.etapes) ? draft.etapes : [];
    state.ficheId = draft.ficheId || null;

    updateRecap();
    $('screen-home').classList.remove('active');
    $('screen-fiche').classList.add('active');
    renderCategorySections();
    renderEtapes();
    setFicheEnCours(true);
    setSaveStatus(state.ficheId ? 'Fiche enregistrée, modifications en cours' : 'Non enregistrée');
    showToast('Brouillon restauré.', 'success');
  }

  function proposeDraft(draft) {
    const site = (draft.fiche && draft.fiche.site) || 'site non renseigné';
    let quand = '';
    if (draft.savedAt) {
      const d = new Date(draft.savedAt);
      if (!isNaN(d.getTime())) {
        const pad = (n) => String(n).padStart(2, '0');
        quand = ` du ${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} à ${pad(d.getHours())}h${pad(d.getMinutes())}`;
      }
    }

    $('draftMessage').textContent = `Une fiche non terminée${quand} a été retrouvée pour « ${site} ».`;
    $('draftDialog').showModal();

    const dlg = $('draftDialog');
    const resumeBtn = $('draftResumeBtn');
    const discardBtn = $('draftDiscardBtn');

    function onResume() { dlg.close('resume'); }
    function onDiscard() { dlg.close('discard'); }
    function onClose() {
      resumeBtn.removeEventListener('click', onResume);
      discardBtn.removeEventListener('click', onDiscard);
      dlg.removeEventListener('close', onClose);
      const action = dlg.returnValue;
      dlg.returnValue = '';
      if (action === 'resume') restoreDraft(draft);
      else if (action === 'discard') clearDraft();
      // Fermeture par Echap : on ne touche a rien, le brouillon reste.
    }

    resumeBtn.addEventListener('click', onResume);
    discardBtn.addEventListener('click', onDiscard);
    dlg.addEventListener('close', onClose);
  }

  if (draftAvailable()) {
    window.api.draftLoad()
      .then((draft) => {
        if (draft && (draft.champs || draft.etapes)) proposeDraft(draft);
      })
      .catch(() => {});
  }

  // ---------- Bibliothèque de fiches ----------
  // Les fiches terminees sont conservees sur disque (un dossier par fiche).
  // Deux usages au demarrage : rouvrir une fiche pour la completer, ou
  // repartir de la fiche d'une visite precedente sur le meme site.
  let libraryCache = [];

  // Dossiers d'organisation (facultatifs) : purement un regroupement visuel
  // (ex : un dossier par site, pour retrouver une fiche des années plus
  // tard). currentFolderFilter vaut 'all', 'none' (non classées) ou l'id
  // d'un dossier — filtre appliqué en plus de la recherche texte, pas à sa
  // place : on peut chercher à l'intérieur d'un dossier comme dans toute la
  // bibliothèque.
  let libraryFolders = [];
  let currentFolderFilter = 'all';
  // Dossier a assigner au tout premier enregistrement d'une fiche issue de
  // "Réutiliser" (voir openFromLibrary) : state ne suit pas le dossier d'une
  // fiche (c'est un concept propre à la bibliothèque, pas à l'édition), donc
  // on le porte à part le temps que la nouvelle fiche obtienne un id.
  let pendingFolderId = null;

  function libraryAvailable() {
    return Boolean(window.api && typeof window.api.ficheList === 'function');
  }

  function formatSavedAt(iso) {
    const d = new Date(iso);
    if (!iso || isNaN(d.getTime())) return '';
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} à ${pad(d.getHours())}h${pad(d.getMinutes())}`;
  }

  async function refreshLibrary() {
    if (!libraryAvailable()) return;
    try {
      libraryCache = await window.api.ficheList();
    } catch (err) {
      libraryCache = [];
    }
    $('libraryCount').textContent = String(libraryCache.length);
    renderLibrary();
  }

  async function refreshFolders() {
    if (!window.api || typeof window.api.folderList !== 'function') return;
    try {
      libraryFolders = await window.api.folderList();
    } catch (err) {
      libraryFolders = [];
    }
    if (currentFolderFilter !== 'all' && currentFolderFilter !== 'none' &&
        !libraryFolders.some((f) => f.id === currentFolderFilter)) {
      currentFolderFilter = 'all';
    }
    renderLibrary();
  }

  function fichesInFolder(folderId) {
    return folderId === 'none'
      ? libraryCache.filter((f) => !f.folderId)
      : libraryCache.filter((f) => f.folderId === folderId);
  }

  function folderLabel(id) {
    if (id === 'none') return 'Non classées';
    const found = libraryFolders.find((f) => f.id === id);
    return found ? found.nom : '';
  }

  // ---------- Explorateur : dossiers + fiches en grille d'icônes ----------
  // A la racine (currentFolderFilter === 'all', pas de recherche en cours) :
  // une grille de dossiers (+ "Non classées"), comme des icônes de dossier
  // dans un explorateur de fichiers. En entrant dans l'un d'eux (ou dès
  // qu'une recherche est tapée — elle aplatit la hiérarchie, comme un vrai
  // explorateur) : une grille de vignettes de fiches.
  function renderLibrary() {
    closeFileTileMenu();

    const foldersGrid = $('libraryFolders');
    const filesGrid = $('libraryList');
    const breadcrumb = $('libraryBreadcrumb');
    const recherche = $('librarySearch').value.trim();
    const filtre = recherche.toLowerCase();

    if (!libraryCache.length) {
      foldersGrid.innerHTML = '';
      foldersGrid.classList.add('hidden');
      breadcrumb.innerHTML = '';
      filesGrid.innerHTML = '<p class="empty-hint-small">Aucune fiche enregistrée pour l\'instant. Elles apparaîtront ici après un enregistrement ou un export PDF.</p>';
      return;
    }

    if (filtre) {
      foldersGrid.innerHTML = '';
      foldersGrid.classList.add('hidden');
      breadcrumb.innerHTML = `<span class="breadcrumb-current">Résultats pour « ${escapeHtml(recherche)} »</span>`;
      const fiches = libraryCache.filter((f) =>
        [f.site, f.adresse, f.technicien].join(' ').toLowerCase().includes(filtre));
      renderFileGrid(filesGrid, fiches, 'Aucune fiche ne correspond à cette recherche.');
      return;
    }

    if (currentFolderFilter === 'all') {
      breadcrumb.innerHTML = '';
      foldersGrid.classList.remove('hidden');
      renderFolderGrid(foldersGrid);
      filesGrid.innerHTML = '';
      return;
    }

    foldersGrid.innerHTML = '';
    foldersGrid.classList.add('hidden');

    breadcrumb.innerHTML = '';
    const backBtn = document.createElement('button');
    backBtn.type = 'button';
    backBtn.className = 'breadcrumb-back';
    backBtn.textContent = '← Toutes les fiches';
    backBtn.addEventListener('click', () => {
      currentFolderFilter = 'all';
      renderLibrary();
    });
    const sep = document.createElement('span');
    sep.className = 'breadcrumb-sep';
    sep.textContent = '/';
    const current = document.createElement('span');
    current.className = 'breadcrumb-current';
    current.textContent = folderLabel(currentFolderFilter);
    breadcrumb.appendChild(backBtn);
    breadcrumb.appendChild(sep);
    breadcrumb.appendChild(current);

    renderFileGrid(filesGrid, fichesInFolder(currentFolderFilter), 'Aucune fiche dans ce dossier.');
  }

  function renderFolderGrid(container) {
    container.innerHTML = '';

    container.appendChild(buildFolderTile('none', 'Non classées', fichesInFolder('none').length, false));

    libraryFolders.forEach((f) => {
      container.appendChild(buildFolderTile(f.id, f.nom, fichesInFolder(f.id).length, true));
    });

    const addTile = document.createElement('button');
    addTile.type = 'button';
    addTile.className = 'folder-tile folder-tile-add';
    addTile.innerHTML = '<span class="folder-tile-icon">➕</span><span class="folder-tile-name">Nouveau dossier</span>';
    addTile.addEventListener('click', () => {
      promptDialog('Nouveau dossier', 'Nom du dossier (par exemple, le nom du site).', '', async (nom) => {
        const result = await window.api.folderCreate(nom);
        if (!result || !result.ok) {
          showToast((result && result.error) || 'Création impossible.', 'error');
          return;
        }
        currentFolderFilter = result.folder.id;
        await refreshFolders();
      });
    });
    container.appendChild(addTile);
  }

  function buildFolderTile(id, nom, count, editable) {
    const tile = document.createElement('div');
    tile.className = 'folder-tile';
    tile.innerHTML = `
      <span class="folder-tile-icon">📁</span>
      <span class="folder-tile-name">${escapeHtml(nom)}</span>
      <span class="folder-tile-count">${count} fiche${count > 1 ? 's' : ''}</span>
    `;

    tile.addEventListener('click', () => {
      currentFolderFilter = id;
      renderLibrary();
    });

    if (editable) {
      const actions = document.createElement('div');
      actions.className = 'folder-tile-actions';

      const renameBtn = document.createElement('button');
      renameBtn.type = 'button';
      renameBtn.className = 'icon-btn small';
      renameBtn.title = 'Renommer le dossier';
      renameBtn.textContent = '✎';
      renameBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        promptDialog('Renommer le dossier', 'Nouveau nom du dossier.', nom, async (nouveauNom) => {
          const result = await window.api.folderRename(id, nouveauNom);
          if (!result || !result.ok) {
            showToast((result && result.error) || 'Renommage impossible.', 'error');
            return;
          }
          await refreshFolders();
        });
      });
      actions.appendChild(renameBtn);

      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'icon-btn small danger';
      delBtn.title = 'Supprimer le dossier';
      delBtn.textContent = '×';
      delBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        confirmAction(
          `Supprimer le dossier « ${nom} » ? Les fiches qu'il contient ne sont pas supprimées : elles repassent en « Non classées ».`,
          async () => {
            await window.api.folderDelete(id);
            if (currentFolderFilter === id) currentFolderFilter = 'all';
            await refreshFolders();
            await refreshLibrary();
            showToast('Dossier supprimé.', 'success');
          }
        );
      });
      actions.appendChild(delBtn);

      tile.appendChild(actions);
    }

    return tile;
  }

  function renderFileGrid(container, fiches, emptyMessage) {
    container.innerHTML = '';
    if (!fiches.length) {
      container.innerHTML = `<p class="empty-hint-small">${escapeHtml(emptyMessage)}</p>`;
      return;
    }
    fiches.forEach((f) => container.appendChild(buildFileTile(f)));
  }

  // Vignette d'une fiche : le clic principal ouvre la fiche (comme un
  // double-clic sur un fichier), les actions secondaires (Réutiliser,
  // Exporter, déplacer, Supprimer) passent par le menu ⋮.
  function buildFileTile(f) {
    const tile = document.createElement('div');
    tile.className = 'file-tile';
    tile.title = `${f.site || '(Sans nom)'} — intervention du ${formatDateFrShort(f.date)}`;
    tile.innerHTML = `
      <button type="button" class="file-tile-menu-btn" title="Actions">⋮</button>
      <span class="file-tile-icon">🗎</span>
      <span class="file-tile-name">${escapeHtml(f.site || '(Sans nom)')}</span>
      <span class="file-tile-meta">${escapeHtml(formatDateFrShort(f.date))}</span>
    `;

    tile.addEventListener('click', () => openFromLibrary(f.id, false));

    const menuBtn = tile.querySelector('.file-tile-menu-btn');
    menuBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openFileTileMenu(menuBtn, f);
    });

    return tile;
  }

  // ---------- Menu contextuel d'une vignette de fiche ----------
  let openTileMenu = null;

  function closeFileTileMenu() {
    if (!openTileMenu) return;
    openTileMenu.menu.remove();
    openTileMenu.btn.classList.remove('active');
    document.removeEventListener('mousedown', onOutsideTileMenuClick, true);
    document.removeEventListener('keydown', onTileMenuKeydown, true);
    openTileMenu = null;
  }

  function onOutsideTileMenuClick(e) {
    if (openTileMenu && !openTileMenu.menu.contains(e.target)) closeFileTileMenu();
  }

  function onTileMenuKeydown(e) {
    if (e.key === 'Escape') closeFileTileMenu();
  }

  function openFileTileMenu(btn, f) {
    closeFileTileMenu();

    const menu = document.createElement('div');
    menu.className = 'file-tile-menu';

    function addItem(label, onClick, danger) {
      const item = document.createElement('button');
      item.type = 'button';
      if (danger) item.className = 'danger';
      item.textContent = label;
      item.addEventListener('click', () => {
        closeFileTileMenu();
        onClick();
      });
      menu.appendChild(item);
      return item;
    }

    function addSeparator() {
      const sep = document.createElement('div');
      sep.className = 'file-tile-menu-sep';
      menu.appendChild(sep);
    }

    addItem('Ouvrir', () => openFromLibrary(f.id, false));
    addItem('Réutiliser', () => openFromLibrary(f.id, true));
    addItem('Exporter…', () => exportFicheFromLibrary(f.id));

    addSeparator();
    const label = document.createElement('div');
    label.className = 'file-tile-menu-label';
    label.textContent = 'Déplacer vers';
    menu.appendChild(label);

    async function moveTo(folderId) {
      const result = await window.api.ficheSetFolder(f.id, folderId);
      if (result && !result.ok) showToast(result.error || 'Déplacement impossible.', 'error');
      else await refreshLibrary();
    }

    const noneItem = addItem('Non classée', () => moveTo(null));
    noneItem.classList.add('folder-option');
    if (!f.folderId) noneItem.classList.add('active');

    libraryFolders.forEach((folder) => {
      const item = addItem(folder.nom, () => moveTo(folder.id));
      item.classList.add('folder-option');
      if (f.folderId === folder.id) item.classList.add('active');
    });

    addSeparator();
    addItem('Supprimer', () => {
      confirmAction(`Supprimer définitivement la fiche « ${f.site || 'sans nom'} » et ses photos ?`, async () => {
        await window.api.ficheDelete(f.id);
        await refreshLibrary();
        showToast('Fiche supprimée.', 'success');
      });
    }, true);

    document.body.appendChild(menu);

    const rect = btn.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();
    let left = Math.max(8, rect.right - menuRect.width);
    let top = rect.bottom + 4;
    if (top + menuRect.height > window.innerHeight - 8) {
      top = Math.max(8, rect.top - menuRect.height - 4);
    }
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;

    btn.classList.add('active');
    openTileMenu = { menu, btn };
    document.addEventListener('mousedown', onOutsideTileMenuClick, true);
    document.addEventListener('keydown', onTileMenuKeydown, true);
  }

  // reuse = true : on repart de la fiche precedente pour une nouvelle visite.
  // Les informations du site (references, IP, appareils, photos de materiel)
  // sont conservees ; le deroulement de l'intervention est remis a zero, car
  // il decrit ce qui a ete constate ce jour-la et n'a pas a etre herite.
  async function openFromLibrary(id, reuse) {
    const data = await window.api.ficheLoad(id);
    if (!data) {
      showToast('Fiche illisible ou introuvable.', 'error');
      await refreshLibrary();
      return;
    }

    await shrinkFicheEnMemoire(data);

    state.fiche = {
      technicien: (data.fiche && data.fiche.technicien) || '',
      site: (data.fiche && data.fiche.site) || '',
      adresse: (data.fiche && data.fiche.adresse) || '',
      date: (data.fiche && data.fiche.date) || todayISO(),
      telephone: (data.fiche && data.fiche.telephone) || '',
      email: (data.fiche && data.fiche.email) || '',
      photo: (data.fiche && data.fiche.photo) || null
    };
    state.categories = Array.isArray(data.categories) ? data.categories : [];
    state.champs = Array.isArray(data.champs) ? data.champs : [];
    state.etapes = Array.isArray(data.etapes) ? data.etapes : [];

    if (reuse) {
      state.ficheId = null;
      // La fiche precedente etait dans un dossier (ex: le site) : la
      // nouvelle visite du meme site y atterrit automatiquement des son
      // premier enregistrement, sans manipulation en plus.
      pendingFolderId = data.folderId || null;
      state.fiche.date = todayISO();
      state.etapes = state.etapes.map((etape) => ({
        id: uuid(),
        nom: etape.nom,
        statut: '',
        remarques: '',
        photos: []
      }));
    } else {
      state.ficheId = data.id || id;
    }

    updateRecap();
    $('screen-home').classList.remove('active');
    $('screen-fiche').classList.add('active');
    renderCategorySections();
    renderEtapes();
    setFicheEnCours(true);
    setSaveStatus(reuse ? 'Nouvelle fiche, non enregistrée' : 'Enregistrée le ' + formatSavedAt(data.savedAt));
    scheduleDraftSave();

    showToast(reuse ? 'Nouvelle fiche créée à partir de la précédente.' : 'Fiche ouverte.', 'success');
  }

  // Envoie une fiche de la bibliotheque locale vers un fichier .json
  // autoporteur (photos incluses), a transferer sur un autre poste par
  // cle USB, mail ou reseau partage — pour qu'un collegue reprenne la saisie
  // la ou elle en est.
  // Le mot de passe est demande a l'export (pas fixe a la creation de la
  // fiche) : c'est au moment de donner le fichier a quelqu'un qu'on sait si
  // une protection est utile, et rien n'a besoin d'etre garde en memoire
  // dans la fiche elle-meme entre-temps. Laisser le champ vide = pas de mot
  // de passe, comportement identique a avant.
  function exportFicheFromLibrary(id) {
    if (!window.api || typeof window.api.ficheExportBundle !== 'function') return;

    promptDialog(
      'Exporter la fiche',
      'Mot de passe à demander à l’import sur l’autre poste (laissez vide pour ne pas protéger le fichier).',
      '',
      async (password) => {
        try {
          const result = await window.api.ficheExportBundle(id, password || '');
          if (!result || result.canceled) return;
          if (result.error) {
            showToast('Export impossible : ' + result.error, 'error');
            return;
          }
          showToast('Fiche exportée : ' + result.filePath, 'success');
        } catch (err) {
          showToast('Export impossible : ' + err.message, 'error');
        }
      },
      { type: 'password' }
    );
  }

  // Lit un fichier exporte par exportFicheFromLibrary (sur ce poste ou un
  // autre) et l'ajoute a la bibliotheque locale, sous un nouvel identifiant :
  // n'ecrase jamais une fiche existante.
  async function importFicheToLibrary() {
    if (!window.api || typeof window.api.ficheImportBundle !== 'function') return;
    try {
      const result = await window.api.ficheImportBundle();
      if (!result || result.canceled) return;

      if (result.needsPassword) {
        askImportPassword(result.filePath);
        return;
      }

      if (!result.ok) {
        showToast('Import impossible : ' + (result.error || 'fichier invalide'), 'error');
        return;
      }
      await refreshLibrary();
      showToast(`Fiche « ${result.site || 'sans nom'} » importée.`, 'success');
    } catch (err) {
      showToast('Import impossible : ' + err.message, 'error');
    }
  }

  // Redemande le mot de passe (sans rouvrir le selecteur de fichier) tant que
  // le dechiffrement echoue : un mot de passe se tape mal plus souvent qu'un
  // fichier se choisit mal.
  function askImportPassword(filePath) {
    promptDialog(
      'Fichier protégé',
      'Ce fichier a été exporté avec un mot de passe. Saisissez-le pour l’importer.',
      '',
      async (password) => {
        try {
          const result = await window.api.ficheImportBundleWithPassword(filePath, password);
          if (!result) return;
          if (!result.ok) {
            showToast(result.error || 'Mot de passe incorrect.', 'error');
            askImportPassword(filePath);
            return;
          }
          await refreshLibrary();
          showToast(`Fiche « ${result.site || 'sans nom'} » importée.`, 'success');
        } catch (err) {
          showToast('Import impossible : ' + err.message, 'error');
        }
      },
      { type: 'password' }
    );
  }

  if ($('btnImportFiche')) {
    $('btnImportFiche').addEventListener('click', importFicheToLibrary);
  }

  function setSaveStatus(text) {
    $('saveStatus').textContent = text || '';
  }

  async function saveToLibrary(silencieux) {
    if (!libraryAvailable()) return false;
    try {
      const premierEnregistrement = !state.ficheId;
      const result = await window.api.ficheSave(getFicheSnapshot(), state.ficheId);
      if (!result || !result.ok) {
        showToast('Enregistrement impossible : ' + ((result && result.error) || 'erreur inconnue'), 'error');
        return false;
      }
      state.ficheId = result.id;

      if (premierEnregistrement && pendingFolderId) {
        await window.api.ficheSetFolder(result.id, pendingFolderId);
        pendingFolderId = null;
      }

      setSaveStatus('Enregistrée le ' + formatSavedAt(result.savedAt));
      if (!silencieux) showToast('Fiche enregistrée.', 'success');
      await refreshLibrary();
      return true;
    } catch (err) {
      showToast('Enregistrement impossible : ' + err.message, 'error');
      return false;
    }
  }

  $('btnSaveFiche').addEventListener('click', () => saveToLibrary(false));

  $('librarySearch').addEventListener('input', renderLibrary);

  document.querySelectorAll('.home-tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.home-tab-btn').forEach((b) => b.classList.toggle('active', b === btn));
      const target = btn.dataset.homeTab;
      document.querySelectorAll('.home-panel').forEach((panel) => {
        panel.classList.toggle('active', panel.id === `home-tab-${target}`);
      });
      // La grille de la bibliotheque respire davantage qu'un formulaire.
      document.querySelector('.home-card').classList.toggle('home-card--wide', target === 'library');
    });
  });

  // Sequence, pas en parallele : renderLibrary() lit libraryFolders pour
  // construire le <select> "dossier" de chaque carte, il doit donc etre deja
  // rempli avant le premier rendu de la liste.
  refreshFolders().then(refreshLibrary);

  // ---------- Écran accueil ----------
  $('ficheDate').value = state.fiche.date;

  $('homeForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const technicien = $('ficheTechnicien').value.trim();
    const site = $('ficheSite').value.trim();
    const adresse = $('ficheAdresse').value.trim();
    const date = $('ficheDate').value;

    if (!technicien || !site || !adresse || !date) {
      showToast('Merci de renseigner tous les champs obligatoires.', 'error');
      return;
    }

    state.fiche.technicien = technicien;
    state.fiche.site = site;
    state.fiche.adresse = adresse;
    state.fiche.date = date;
    state.fiche.telephone = $('ficheTelephone').value.trim();
    state.fiche.email = $('ficheEmail').value.trim();
    state.fiche.photo = homePhotoPicker.get();

    goToFicheScreen();
  });

  function goToFicheScreen() {
    updateRecap();
    $('screen-home').classList.remove('active');
    $('screen-fiche').classList.add('active');
    seedDefaultEtapes();
    renderCategorySections();
    renderEtapes();
    setFicheEnCours(true);
    setSaveStatus('Non enregistrée');
    scheduleDraftSave();
  }

  function updateRecap() {
    const photoLabel = state.fiche.photo ? ' — photo ✓' : '';
    $('ficheRecap').textContent =
      `${state.fiche.site} — ${state.fiche.technicien} — ${formatDateFrShort(state.fiche.date)}${photoLabel}`;
  }

  // Statut vide au depart ('' , ni OK ni NOK ni EN COURS) : le technicien
  // doit choisir explicitement pour chaque etape, plutot que de laisser un
  // OK par defaut qui pourrait ne jamais avoir ete verifie.
  function seedDefaultEtapes() {
    DEFAULT_ETAPES.forEach((nom) => {
      state.etapes.push({ id: uuid(), nom, statut: '', remarques: '', photos: [] });
    });
  }

  // ---------- Modifier les informations de l'intervention ----------
  // Les quatre champs de l'accueil (et la photo) restent modifiables une fois
  // la fiche commencee : une faute de frappe sur le nom du site ne doit pas
  // obliger a repartir de zero.
  $('btnEditInfos').addEventListener('click', () => {
    $('editTechnicien').value = state.fiche.technicien;
    $('editSite').value = state.fiche.site;
    $('editAdresse').value = state.fiche.adresse;
    $('editDate').value = state.fiche.date;
    $('editTelephone').value = state.fiche.telephone || '';
    $('editEmail').value = state.fiche.email || '';
    editPhotoPicker.set(state.fiche.photo);
    $('infoDialog').showModal();
  });

  $('infoCancelBtn').addEventListener('click', () => {
    $('infoDialog').close();
  });

  $('infoSaveBtn').addEventListener('click', () => {
    const technicien = $('editTechnicien').value.trim();
    const site = $('editSite').value.trim();
    const adresse = $('editAdresse').value.trim();
    const date = $('editDate').value;

    if (!technicien || !site || !adresse || !date) {
      showToast('Merci de renseigner tous les champs obligatoires.', 'error');
      return;
    }

    state.fiche.technicien = technicien;
    state.fiche.site = site;
    state.fiche.adresse = adresse;
    state.fiche.date = date;
    state.fiche.telephone = $('editTelephone').value.trim();
    state.fiche.email = $('editEmail').value.trim();
    state.fiche.photo = editPhotoPicker.get();

    updateRecap();
    $('infoDialog').close();
    showToast('Informations mises à jour.', 'success');
  });

  // ---------- Onglets ----------
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b === btn));
      const target = btn.dataset.tab;
      document.querySelectorAll('.tab-panel').forEach((panel) => {
        panel.classList.toggle('active', panel.id === `tab-${target}`);
      });
    });
  });

  // ---------- Nouvelle fiche ----------
  $('btnNewFiche').addEventListener('click', () => {
    confirmAction('Démarrer une nouvelle fiche ? Les données actuelles seront perdues.', () => {
      setFicheEnCours(false);
      clearDraft();
      // Laisse le temps a l'effacement de partir avant de recharger la page.
      setTimeout(() => location.reload(), 120);
    });
  });

  // ---------- Catégories ----------
  function addCategory(name) {
    const trimmed = String(name || '').trim();
    if (!trimmed) return false;
    const exists = state.categories.some((c) => c.toLowerCase() === trimmed.toLowerCase());
    if (exists) {
      showToast('Cette catégorie existe déjà.', 'error');
      return false;
    }
    state.categories.push(trimmed);
    renderCategorySections();
    return true;
  }

  // Renomme une catégorie et reporte le nouveau nom sur tous ses champs
  // (state.champs stocke la catégorie par son nom, pas par un identifiant).
  function renameCategory(oldName, rawNewName) {
    const newName = String(rawNewName || '').trim();

    if (!newName) {
      showToast('Le nom de la catégorie ne peut pas être vide.', 'error');
      renderCategorySections();
      return;
    }

    if (newName === oldName) return;

    const clash = state.categories.some(
      (c) => c !== oldName && c.toLowerCase() === newName.toLowerCase()
    );
    if (clash) {
      showToast('Une catégorie porte déjà ce nom.', 'error');
      renderCategorySections();
      return;
    }

    state.categories = state.categories.map((c) => (c === oldName ? newName : c));
    state.champs.forEach((champ) => {
      if (champ.categorie === oldName) champ.categorie = newName;
    });

    renderCategorySections();
  }

  function removeCategory(name) {
    const fieldCount = state.champs.filter((s) => s.categorie === name).length;
    const message = fieldCount
      ? `Supprimer la catégorie « ${name} » et ses ${fieldCount} champ(s) ?`
      : `Supprimer la catégorie « ${name} » ?`;
    confirmAction(message, () => {
      state.categories = state.categories.filter((c) => c !== name);
      state.champs = state.champs.filter((s) => s.categorie !== name);
      renderCategorySections();
    });
  }

  $('btnShowNewCategory').addEventListener('click', () => {
    $('newCategoryInlineRow').classList.remove('hidden');
    $('btnShowNewCategory').classList.add('hidden');
    $('newCategoryInlineInput').focus();
  });

  $('btnNewCategoryInlineCancel').addEventListener('click', () => {
    $('newCategoryInlineInput').value = '';
    $('newCategoryInlineRow').classList.add('hidden');
    $('btnShowNewCategory').classList.remove('hidden');
  });

  $('btnNewCategoryInlineConfirm').addEventListener('click', () => {
    const input = $('newCategoryInlineInput');
    if (addCategory(input.value)) {
      input.value = '';
      $('newCategoryInlineRow').classList.add('hidden');
      $('btnShowNewCategory').classList.remove('hidden');
    }
  });

  // ---------- Rendu des sections de catégories (onglet "Informations du site") ----------
  function renderCategorySections() {
    const container = $('categorySections');
    container.innerHTML = '';

    if (!state.categories.length) {
      container.innerHTML = '<p class="empty-hint">Aucune catégorie. Cliquez sur « + Nouvelle catégorie ».</p>';
      return;
    }

    state.categories.forEach((cat) => {
      container.appendChild(buildCategoryCard(cat));
    });

    enableCategoryDragAndDrop(container);
  }

  // L'ordre des categories pilote la numerotation du sommaire du PDF
  // (2.1, 2.2, ...), d'ou l'interet de pouvoir les reorganiser.
  function enableCategoryDragAndDrop(container) {
    let draggedCat = null;

    container.querySelectorAll('.category-card').forEach((card) => {
      const handle = card.querySelector('.category-handle');
      if (!handle) return;

      handle.addEventListener('mousedown', () => { card.draggable = true; });
      handle.addEventListener('mouseup', () => { card.draggable = false; });

      card.addEventListener('dragstart', (e) => {
        draggedCat = card.dataset.category;
        card.classList.add('is-dragging');
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', draggedCat);
        e.stopPropagation();
      });

      card.addEventListener('dragend', () => {
        card.draggable = false;
        card.classList.remove('is-dragging');
        container.querySelectorAll('.category-card').forEach((c) => {
          c.classList.remove('drop-before', 'drop-after');
        });
        draggedCat = null;
      });

      card.addEventListener('dragover', (e) => {
        if (!draggedCat || card.dataset.category === draggedCat) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        const rect = card.getBoundingClientRect();
        const after = e.clientY > rect.top + rect.height / 2;
        card.classList.toggle('drop-after', after);
        card.classList.toggle('drop-before', !after);
      });

      card.addEventListener('dragleave', () => {
        card.classList.remove('drop-before', 'drop-after');
      });

      card.addEventListener('drop', (e) => {
        if (!draggedCat || card.dataset.category === draggedCat) return;
        e.preventDefault();
        e.stopPropagation();
        const rect = card.getBoundingClientRect();
        const after = e.clientY > rect.top + rect.height / 2;
        moveCategoryTo(draggedCat, card.dataset.category, after);
      });
    });
  }

  function moveCategoryTo(draggedCat, targetCat, placeAfter) {
    const list = state.categories.slice();
    const from = list.indexOf(draggedCat);
    if (from === -1) return;

    list.splice(from, 1);
    const targetPos = list.indexOf(targetCat);
    if (targetPos === -1) return;

    list.splice(placeAfter ? targetPos + 1 : targetPos, 0, draggedCat);
    state.categories = list;
    renderCategorySections();
    scheduleDraftSave();
  }

  function buildCategoryCard(cat) {
    const card = document.createElement('section');
    card.className = 'category-card';
    card.dataset.category = cat;

    const header = document.createElement('div');
    header.className = 'category-card-header';
    header.innerHTML = `
      <span class="drag-handle category-handle" title="Glisser pour réorganiser les catégories">⠿</span>
      <input type="text" class="category-title-input" value="${escapeHtml(cat)}" aria-label="Nom de la catégorie">
      <button type="button" class="btn btn-ghost btn-small" data-action="delete-category">Supprimer</button>
    `;

    // Le renommage est valide sur 'change' (Entree ou perte de focus) et non
    // sur chaque frappe : renommer redessine toute la liste, ce qui ferait
    // perdre le focus a chaque caractere.
    const titleInput = header.querySelector('.category-title-input');
    titleInput.addEventListener('change', () => renameCategory(cat, titleInput.value));
    titleInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); titleInput.blur(); }
      if (e.key === 'Escape') { titleInput.value = cat; titleInput.blur(); }
    });

    header.querySelector('[data-action="delete-category"]').addEventListener('click', () => removeCategory(cat));
    card.appendChild(header);

    const fieldsList = document.createElement('div');
    fieldsList.className = 'fields-list';
    fieldsList.dataset.categoryFields = cat;
    card.appendChild(fieldsList);

    card.appendChild(buildAddFieldForm(cat));

    renderFieldsForCategoryInto(fieldsList, cat);

    return card;
  }

  // Formulaire d'ajout : nom + type, avec une saisie complementaire selon le
  // type choisi (liste des choix, ou liste des colonnes).
  function buildAddFieldForm(cat) {
    const addRow = document.createElement('div');
    addRow.className = 'add-field-row';
    addRow.innerHTML = `
      <input type="text" class="new-field-input" placeholder="Nouveau champ">
      <select class="new-field-type" aria-label="Type de champ">
        <option value="texte">Texte</option>
        <option value="photo">Photo</option>
        <option value="choix">Choix + texte</option>
        <option value="tableau">Tableau</option>
      </select>
      <input type="text" class="new-field-extra hidden" placeholder="OUI ; NON">
      <button type="button" class="btn btn-small" data-action="add-field">+ Ajouter</button>
    `;

    const nameInput = addRow.querySelector('.new-field-input');
    const typeSelect = addRow.querySelector('.new-field-type');
    const extraInput = addRow.querySelector('.new-field-extra');

    function syncExtra() {
      const type = typeSelect.value;
      if (type === 'choix') {
        extraInput.classList.remove('hidden');
        extraInput.placeholder = 'Choix séparés par ; (ex : OUI ; NON ; EN COURS)';
        if (!extraInput.value) extraInput.value = 'OUI ; NON';
      } else if (type === 'tableau') {
        extraInput.classList.remove('hidden');
        extraInput.placeholder = 'Colonnes séparées par ; (ex : Nom ; Adresse IP)';
        if (!extraInput.value || extraInput.value === 'OUI ; NON') {
          extraInput.value = "Nom de l'appareil ; Adresse IP ; Type de connexion";
        }
      } else {
        extraInput.classList.add('hidden');
        extraInput.value = '';
      }
    }

    typeSelect.addEventListener('change', syncExtra);

    function submitNewField() {
      const name = nameInput.value.trim();
      if (!name) {
        showToast('Donnez un nom au champ.', 'error');
        return;
      }

      // "Photo" est un type a part entiere (pas de case de texte, contrairement
      // a "Texte" qui peut aussi n'avoir qu'une photo mais garde son champ de
      // saisie) : voir buildChampRow(). On ouvre en plus le selecteur de
      // fichier tout de suite apres creation, pour eviter un clic en plus.
      const type = typeSelect.value;
      const desc = { nom: name, type };
      const extras = parseList(extraInput.value);

      if (type === 'choix') {
        if (extras.length < 2) {
          showToast('Indiquez au moins deux choix, séparés par « ; ».', 'error');
          return;
        }
        desc.options = extras;
      }

      if (type === 'tableau') {
        if (!extras.length) {
          showToast('Indiquez au moins une colonne, séparées par « ; ».', 'error');
          return;
        }
        desc.colonnes = extras;
      }

      const field = createField(desc, cat);
      state.champs.push(field);
      nameInput.value = '';
      typeSelect.value = 'texte';
      syncExtra();
      renderFieldsForCategory(cat);

      if (type === 'photo') {
        const photoInput = document.querySelector(`.field-row[data-item-id="${field.id}"] .field-photo-input`);
        if (photoInput) photoInput.click();
      }
    }

    addRow.querySelector('[data-action="add-field"]').addEventListener('click', submitNewField);
    nameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); submitNewField(); }
    });
    extraInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); submitNewField(); }
    });

    return addRow;
  }

  function renderFieldsForCategory(cat) {
    const list = document.querySelector(`.fields-list[data-category-fields="${cssEscape(cat)}"]`);
    if (list) renderFieldsForCategoryInto(list, cat);
  }

  function renderFieldsForCategoryInto(list, cat) {
    list.innerHTML = '';
    const fields = state.champs.filter((s) => s.categorie === cat);

    if (!fields.length) {
      list.innerHTML = '<p class="empty-hint-small">Aucun champ. Ajoutez-en un ci-dessous.</p>';
      return;
    }

    fields.forEach((field) => {
      list.appendChild(buildChampRow(field, cat));
    });

    enableDragAndDrop(list, cat);
  }

  // ---------- Glisser-déposer des champs ----------
  // Remplace les fleches haut/bas. Le glissement n'est arme qu'au clic sur la
  // poignee, sinon on ne pourrait plus selectionner du texte dans les inputs.
  function enableDragAndDrop(list, cat) {
    let draggedId = null;

    list.querySelectorAll('.field-row').forEach((row) => {
      const handle = row.querySelector('.drag-handle');
      if (!handle) return;

      handle.addEventListener('mousedown', () => { row.draggable = true; });
      handle.addEventListener('mouseup', () => { row.draggable = false; });

      row.addEventListener('dragstart', (e) => {
        draggedId = row.dataset.itemId;
        row.classList.add('is-dragging');
        e.dataTransfer.effectAllowed = 'move';
        // Firefox exige une donnee pour demarrer le glissement.
        e.dataTransfer.setData('text/plain', draggedId);
      });

      row.addEventListener('dragend', () => {
        row.draggable = false;
        row.classList.remove('is-dragging');
        list.querySelectorAll('.field-row').forEach((r) => {
          r.classList.remove('drop-before', 'drop-after');
        });
        draggedId = null;
      });

      row.addEventListener('dragover', (e) => {
        if (!draggedId || row.dataset.itemId === draggedId) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        const rect = row.getBoundingClientRect();
        const after = e.clientY > rect.top + rect.height / 2;
        row.classList.toggle('drop-after', after);
        row.classList.toggle('drop-before', !after);
      });

      row.addEventListener('dragleave', () => {
        row.classList.remove('drop-before', 'drop-after');
      });

      row.addEventListener('drop', (e) => {
        if (!draggedId || row.dataset.itemId === draggedId) return;
        e.preventDefault();
        const rect = row.getBoundingClientRect();
        const after = e.clientY > rect.top + rect.height / 2;
        moveFieldTo(cat, draggedId, row.dataset.itemId, after);
      });
    });
  }

  // Reordonne a l'interieur d'une categorie. state.champs est un tableau plat
  // toutes categories confondues : on reecrit uniquement les emplacements
  // occupes par cette categorie, pour ne pas perturber les autres.
  function moveFieldTo(cat, draggedId, targetId, placeAfter) {
    const slots = [];
    state.champs.forEach((f, i) => { if (f.categorie === cat) slots.push(i); });

    const items = slots.map((i) => state.champs[i]);
    const from = items.findIndex((f) => f.id === draggedId);
    if (from === -1) return;

    const [moved] = items.splice(from, 1);
    const targetPos = items.findIndex((f) => f.id === targetId);
    if (targetPos === -1) return;

    items.splice(placeAfter ? targetPos + 1 : targetPos, 0, moved);
    slots.forEach((globalIndex, k) => { state.champs[globalIndex] = items[k]; });

    renderFieldsForCategory(cat);
  }

  // ---------- Ligne de champ (onglet "Informations du site") ----------
  function buildChampRow(field, cat) {
    const row = document.createElement('div');
    row.className = 'field-row';
    row.dataset.itemId = field.id;

    row.innerHTML = `
      <div class="field-row-main">
        <span class="drag-handle" title="Glisser pour réorganiser">⠿</span>
        <input type="text" class="field-name field-name-input" value="${escapeHtml(field.nom)}" placeholder="Nom du champ" title="Cliquez pour renommer">
        <div class="field-control"></div>
        <button type="button" class="icon-btn" data-action="photo" title="Ajouter une photo">📷</button>
        <button type="button" class="icon-btn danger" data-action="delete" title="Supprimer">×</button>
        <input type="file" class="field-photo-input hidden" accept="image/*" multiple>
      </div>
      <div class="field-extra"></div>
      <div class="field-photos"></div>
    `;

    const nameInput = row.querySelector('.field-name-input');
    nameInput.addEventListener('input', () => { field.nom = nameInput.value; });
    nameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); nameInput.blur(); }
    });

    row.querySelector('[data-action="delete"]').addEventListener('click', () => {
      state.champs = state.champs.filter((s) => s.id !== field.id);
      renderFieldsForCategory(cat);
    });

    const control = row.querySelector('.field-control');
    const extra = row.querySelector('.field-extra');

    if (field.type === 'choix') {
      renderChoiceControl(control, field, cat);
      renderChoiceRemark(extra, field);
    } else if (field.type === 'tableau') {
      control.innerHTML = '<span class="field-type-badge">Tableau</span>';
      renderFieldTable(extra, field);
    } else if (field.type === 'photo') {
      // Volontairement aucune case de texte : c'est ce qui distingue ce type
      // de "Texte" (qui, lui, peut deja avoir une photo sans remarque). Si
      // besoin d'un mot de texte, il faut choisir "Texte", pas "Photo".
      control.innerHTML = '<span class="field-type-badge">Photo</span>';
    } else {
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'field-value';
      input.placeholder = 'Valeur / remarque';
      input.value = field.remarques || '';
      input.addEventListener('input', () => { field.remarques = input.value; });
      control.appendChild(input);
    }

    wirePhotoInput(row, field);
    renderItemPhotos(row, field);

    return row;
  }

  // Pastilles cliquables. Recliquer sur la valeur active la desactive, ce qui
  // permet de remettre un champ a "non renseigne" (donc absent du PDF).
  function renderChoiceControl(container, field, cat) {
    container.innerHTML = '';

    const group = document.createElement('div');
    group.className = 'choice-toggle';

    field.options.forEach((option) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'choice-btn ' + choiceClass(option);
      if (field.valeur === option) btn.classList.add('active');
      btn.textContent = option;
      btn.addEventListener('click', () => {
        field.valeur = field.valeur === option ? '' : option;
        renderChoiceControl(container, field, cat);
      });
      group.appendChild(btn);
    });

    container.appendChild(group);

    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'icon-btn small';
    editBtn.title = 'Modifier les choix possibles';
    editBtn.textContent = '⚙';
    editBtn.addEventListener('click', () => {
      promptDialog(
        'Choix possibles',
        'Séparez les choix par un point-virgule.',
        field.options.join(' ; '),
        (value) => {
          const options = parseList(value);
          if (options.length < 2) {
            showToast('Indiquez au moins deux choix.', 'error');
            return;
          }
          field.options = options;
          if (options.indexOf(field.valeur) === -1) field.valeur = '';
          renderChoiceControl(container, field, cat);
        }
      );
    });
    container.appendChild(editBtn);
  }

  // Une valeur "choix" (OUI/NON/...) peut avoir besoin d'une precision libre
  // (ex: NON + "cable HS, commande en cours"). Champ facultatif, stocke dans
  // le meme "remarques" que les champs texte : le PDF l'affiche sous la
  // pastille quand il est rempli.
  function renderChoiceRemark(container, field) {
    container.innerHTML = '';

    const wrap = document.createElement('div');
    wrap.className = 'choice-remark-wrap';

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'field-value';
    input.placeholder = 'Remarque (facultatif)';
    input.value = field.remarques || '';
    input.addEventListener('input', () => { field.remarques = input.value; });

    wrap.appendChild(input);
    container.appendChild(wrap);
  }

  // Reprend la logique de couleur du PDF, pour que l'ecran et le document
  // final donnent la meme lecture immediate.
  function choiceClass(option) {
    const v = String(option || '').trim().toUpperCase();
    if (v === 'OUI' || v === 'OK' || v === 'ACTIF' || v === 'CONFORME') return 'yes';
    if (v === 'NON' || v === 'NOK' || v === 'KO' || v === 'ABSENT') return 'no';
    if (v === 'EN COURS' || v === 'PARTIEL' || v === 'A VERIFIER') return 'wip';
    return 'neutral';
  }

  // ---------- Tableau saisi dans un champ ----------
  function renderFieldTable(container, field) {
    container.innerHTML = '';

    const wrap = document.createElement('div');
    wrap.className = 'field-table-wrap';

    const table = document.createElement('table');
    table.className = 'field-table';

    // En-tetes : renommables, et supprimables tant qu'il reste une colonne.
    const thead = document.createElement('thead');
    const headRow = document.createElement('tr');

    field.colonnes.forEach((colonne, colIndex) => {
      const th = document.createElement('th');

      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'table-col-input';
      input.value = colonne;
      input.addEventListener('input', () => { field.colonnes[colIndex] = input.value; });
      th.appendChild(input);

      if (field.colonnes.length > 1) {
        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'table-del';
        del.title = 'Supprimer la colonne';
        del.textContent = '×';
        del.addEventListener('click', () => {
          field.colonnes.splice(colIndex, 1);
          field.lignes.forEach((ligne) => ligne.splice(colIndex, 1));
          renderFieldTable(container, field);
        });
        th.appendChild(del);
      }

      headRow.appendChild(th);
    });

    headRow.appendChild(document.createElement('th'));
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');

    field.lignes.forEach((ligne, rowIndex) => {
      const tr = document.createElement('tr');

      field.colonnes.forEach((_, colIndex) => {
        const td = document.createElement('td');
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'table-cell-input';
        input.value = ligne[colIndex] || '';
        input.addEventListener('input', () => { field.lignes[rowIndex][colIndex] = input.value; });
        td.appendChild(input);
        tr.appendChild(td);
      });

      const actions = document.createElement('td');
      actions.className = 'table-row-actions';
      if (field.lignes.length > 1) {
        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'table-del';
        del.title = 'Supprimer la ligne';
        del.textContent = '×';
        del.addEventListener('click', () => {
          field.lignes.splice(rowIndex, 1);
          renderFieldTable(container, field);
        });
        actions.appendChild(del);
      }
      tr.appendChild(actions);

      tbody.appendChild(tr);
    });

    table.appendChild(tbody);
    wrap.appendChild(table);

    const buttons = document.createElement('div');
    buttons.className = 'table-buttons';

    const addRowBtn = document.createElement('button');
    addRowBtn.type = 'button';
    addRowBtn.className = 'btn btn-small btn-secondary';
    addRowBtn.textContent = '+ Ligne';
    addRowBtn.addEventListener('click', () => {
      field.lignes.push(field.colonnes.map(() => ''));
      renderFieldTable(container, field);
    });

    const addColBtn = document.createElement('button');
    addColBtn.type = 'button';
    addColBtn.className = 'btn btn-small btn-secondary';
    addColBtn.textContent = '+ Colonne';
    addColBtn.addEventListener('click', () => {
      field.colonnes.push('Colonne ' + (field.colonnes.length + 1));
      field.lignes.forEach((ligne) => ligne.push(''));
      renderFieldTable(container, field);
    });

    buttons.appendChild(addRowBtn);
    buttons.appendChild(addColBtn);
    wrap.appendChild(buttons);

    container.appendChild(wrap);
  }

  // ---------- Onglet "Etapes" ----------
  function renderEtapes() {
    const list = $('etapesList');
    list.innerHTML = '';

    if (!state.etapes.length) {
      list.innerHTML = '<p class="empty-hint-small">Aucune étape enregistrée pour cette fiche.</p>';
      return;
    }

    state.etapes.forEach((etape) => {
      list.appendChild(buildEtapeRow(etape));
    });
  }

  // Etape fixe : ni renommable, ni supprimable (voir DEFAULT_ETAPES) — seuls
  // le statut, la remarque et les photos sont modifiables.
  function buildEtapeRow(etape) {
    const row = document.createElement('div');
    row.className = 'field-row';
    row.dataset.itemId = etape.id;

    row.innerHTML = `
      <div class="field-row-main">
        <div class="field-name">${escapeHtml(etape.nom)}</div>
        <input type="text" class="field-value etape-remarque-input" placeholder="Remarque (facultatif)" value="${escapeHtml(etape.remarques)}">
        <div class="field-status-toggle">
          <button type="button" class="status-btn ok ${etape.statut === 'OK' ? 'active' : ''}" data-status="OK">OK</button>
          <button type="button" class="status-btn nok ${etape.statut === 'NOK' ? 'active' : ''}" data-status="NOK">NOK</button>
          <button type="button" class="status-btn wip ${etape.statut === 'EN COURS' ? 'active' : ''}" data-status="EN COURS">EN COURS</button>
        </div>
        <button type="button" class="icon-btn" data-action="photo" title="Ajouter une photo">📷</button>
        <input type="file" class="field-photo-input hidden" accept="image/*" multiple>
      </div>
      <div class="field-photos"></div>
    `;

    const remarqueInput = row.querySelector('.etape-remarque-input');
    remarqueInput.addEventListener('input', () => { etape.remarques = remarqueInput.value; });

    row.querySelectorAll('.status-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        etape.statut = btn.dataset.status;
        row.querySelectorAll('.status-btn').forEach((b) => b.classList.toggle('active', b === btn));
      });
    });

    wirePhotoInput(row, etape);
    renderItemPhotos(row, etape);

    return row;
  }

  // ---------- Photos d'un élément ----------
  function wirePhotoInput(row, item) {
    const photoInput = row.querySelector('.field-photo-input');
    row.querySelector('[data-action="photo"]').addEventListener('click', () => photoInput.click());
    photoInput.addEventListener('change', async (e) => {
      const files = Array.from(e.target.files || []);
      for (const file of files) {
        try {
          const dataUrl = await resizeImage(file, PHOTO_MAX_DIM);
          item.photos.push({ id: uuid(), name: file.name, dataUrl });
        } catch (err) {
          showToast(`Photo ignorée (${file.name}) : ${err.message}`, 'error');
        }
      }
      e.target.value = '';
      renderItemPhotos(row, item);
      scheduleDraftSave();
    });
  }

  function renderItemPhotos(row, item) {
    const grid = row.querySelector('.field-photos');
    grid.innerHTML = '';
    item.photos.forEach((photo) => {
      const thumb = document.createElement('div');
      thumb.className = 'photo-thumb';
      thumb.innerHTML = `<img src="${escapeHtml(photo.dataUrl)}" alt="${escapeHtml(photo.name || '')}"><button type="button" aria-label="Retirer la photo">×</button>`;
      thumb.querySelector('button').addEventListener('click', () => {
        item.photos = item.photos.filter((p) => p.id !== photo.id);
        renderItemPhotos(row, item);
      });
      grid.appendChild(thumb);
    });
  }

  // ---------- Snapshot pour aperçu / export ----------
  function getFicheSnapshot() {
    return {
      technicien: state.fiche.technicien,
      site: state.fiche.site,
      adresse: state.fiche.adresse,
      date: state.fiche.date,
      telephone: state.fiche.telephone,
      email: state.fiche.email,
      photo: state.fiche.photo,
      logo: state.logo,
      // L'ordre des catégories pilote la numérotation du sommaire (2.1, 2.2…).
      categories: state.categories.slice(),
      champs: state.champs,
      etapes: state.etapes
    };
  }

  function hasAnyContent() {
    return state.champs.length > 0 || state.etapes.length > 0;
  }

  // ---------- Aperçu ----------
  $('btnPreview').addEventListener('click', () => {
    if (!hasAnyContent()) {
      showToast('Ajoutez au moins un champ ou une étape avant de prévisualiser.', 'error');
      return;
    }
    const html = ReportTemplate.buildReportHtml(getFicheSnapshot());
    $('previewFrame').srcdoc = html;
    $('previewOverlay').classList.add('active');
  });

  $('btnClosePreview').addEventListener('click', () => {
    $('previewOverlay').classList.remove('active');
  });

  // ---------- Export PDF ----------
  $('btnExport').addEventListener('click', (e) => doExport(e, false));
  $('btnExportFromPreview').addEventListener('click', (e) => doExport(e, false));
  $('btnExportClient').addEventListener('click', (e) => doExport(e, true));

  // Meme principe que l'export/import de fiche entre postes (voir
  // exportFicheFromLibrary) : un mot de passe facultatif, demandé juste avant
  // l'enregistrement, protège l'ouverture du PDF (chiffrement réel via qpdf,
  // voir main.js) — laisser vide ne protège pas le fichier.
  // clientExport = true : version a remettre au client, qui masque l'onglet
  // Étapes (deroulement interne de l'intervention, pas destine a sortir de
  // l'equipe) — voir reportTemplate.js (options.hideEtapes).
  function doExport(e, clientExport) {
    if (!hasAnyContent()) {
      showToast('Ajoutez au moins un champ ou une étape avant d’exporter.', 'error');
      return;
    }

    if (clientExport && !state.champs.length) {
      showToast('Attention : sans champ dans « Informations du site », le PDF client sera vide (les étapes internes n’y figurent pas).', 'error');
    }

    const btn = e && e.currentTarget;

    promptDialog(
      clientExport ? 'Exporter en PDF (client)' : 'Exporter en PDF',
      'Mot de passe demandé à l’ouverture du PDF (laissez vide pour ne pas protéger le fichier).',
      '',
      (password) => runExport(btn, password, clientExport),
      { type: 'password' }
    );
  }

  async function runExport(btn, password, clientExport) {
    const originalLabel = btn ? btn.textContent : null;
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Génération en cours…';
    }

    try {
      const result = await window.api.exportPdf(getFicheSnapshot(), password || '', { hideEtapes: Boolean(clientExport) });
      if (result.canceled) {
        // Rien à faire : l'utilisateur a annulé l'enregistrement.
      } else if (result.error) {
        showToast('Erreur lors de la génération du PDF : ' + result.error, 'error');
      } else {
        showToast(clientExport ? 'PDF client exporté avec succès.' : 'PDF exporté avec succès.', 'success');
        // Un export marque la fin d'une intervention : la fiche rejoint la
        // bibliotheque sans que le technicien ait a y penser.
        await saveToLibrary(true);
      }
    } catch (err) {
      showToast('Erreur inattendue : ' + err.message, 'error');
    }
    finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = originalLabel;
      }
    }
  }
})();
