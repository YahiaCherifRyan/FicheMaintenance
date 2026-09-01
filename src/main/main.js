const { app, BrowserWindow, ipcMain, dialog, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { buildReportHtml } = require('../shared/reportTemplate');

let mainWindow;

// Vrai des qu'une fiche est en cours de saisie cote renderer. Sert uniquement
// a decider s'il faut confirmer la fermeture de la fenetre.
let ficheEnCours = false;
let fermetureForcee = false;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 1000,
    minHeight: 700,
    title: 'Fiches Maintenance',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // Fermer la fenetre en pleine intervention perdait toute la fiche sans
  // aucun avertissement. On confirme, et le brouillon reste sur le disque.
  mainWindow.on('close', (event) => {
    if (fermetureForcee || !ficheEnCours) return;

    event.preventDefault();
    const choix = dialog.showMessageBoxSync(mainWindow, {
      type: 'warning',
      buttons: ['Annuler', 'Quitter'],
      defaultId: 0,
      cancelId: 0,
      title: 'Fiche en cours',
      message: 'Une fiche est en cours de saisie.',
      detail: "Elle est enregistrée comme brouillon et vous sera proposée au prochain démarrage. Quitter maintenant ?"
    });

    if (choix === 1) {
      fermetureForcee = true;
      mainWindow.close();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

function sanitizeFilename(name) {
  const cleaned = String(name || 'site').replace(/[\\/:*?"<>|]+/g, '_').trim();
  return cleaned || 'site';
}

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ---------- Logo de couverture ----------
// Le logo est un fichier posé dans src/renderer/assets/. Il est lu ici (et non
// dans le renderer) parce qu'une page file:// ne peut ni faire un fetch local
// ni dessiner une image file:// dans un canvas sans erreur de sécurité.
const LOGO_CANDIDATES = [
  ['logo.png', 'image/png'],
  ['logo.svg', 'image/svg+xml'],
  ['logo.jpg', 'image/jpeg'],
  ['logo.jpeg', 'image/jpeg']
];

let logoCache;

function readLogoDataUrl() {
  if (logoCache !== undefined) return logoCache;

  const assetsDir = path.join(__dirname, '..', 'renderer', 'assets');
  for (const [filename, mime] of LOGO_CANDIDATES) {
    const filePath = path.join(assetsDir, filename);
    try {
      const buffer = fs.readFileSync(filePath);
      logoCache = `data:${mime};base64,${buffer.toString('base64')}`;
      return logoCache;
    } catch (err) {
      // Fichier absent : on essaie le format suivant.
    }
  }

  logoCache = null;
  return logoCache;
}

ipcMain.handle('get-logo', () => readLogoDataUrl());

// ---------- Brouillon ----------
// Filet de securite pendant une intervention : la fiche en cours est ecrite
// sur disque, et proposee au demarrage suivant si l'application s'est fermee
// sans que la fiche soit terminee. Ce n'est pas une persistance entre deux
// fiches : "Nouvelle fiche" efface le brouillon.
function draftPath() {
  return path.join(app.getPath('userData'), 'brouillon.json');
}

ipcMain.on('set-fiche-en-cours', (event, value) => {
  ficheEnCours = Boolean(value);
});

ipcMain.handle('draft-save', async (event, payload) => {
  const target = draftPath();
  const temp = target + '.tmp';
  try {
    // Ecriture puis renommage : une coupure en plein enregistrement ne peut
    // pas laisser un brouillon a moitie ecrit, donc illisible.
    await fs.promises.writeFile(temp, JSON.stringify(payload), 'utf-8');
    await fs.promises.rename(temp, target);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});

ipcMain.handle('draft-load', async () => {
  try {
    const raw = await fs.promises.readFile(draftPath(), 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    return null;
  }
});

// ---------- Bibliotheque de fiches ----------
// Une fiche = un dossier sous userData/fiches/<id>/ :
//   fiche.json   les donnees, photos remplacees par une reference de fichier
//   photos/*.jpg les photos en binaire
// Le renderer ne connait que des data URL ; la conversion dans les deux sens
// se fait ici. Sans ca, une fiche avec 40 photos donnerait un JSON de 60 Mo,
// illisible et lent a relire.
function fichesDir() {
  return path.join(app.getPath('userData'), 'fiches');
}

function newFicheId() {
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

function decodeDataUrl(dataUrl) {
  const match = /^data:([^;]+);base64,(.*)$/.exec(String(dataUrl || ''));
  if (!match) return null;
  return { mime: match[1], buffer: Buffer.from(match[2], 'base64') };
}

function extensionPour(mime) {
  if (mime === 'image/png') return 'png';
  if (mime === 'image/webp') return 'webp';
  return 'jpg';
}

function mimePour(fichier) {
  const ext = path.extname(fichier).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  return 'image/jpeg';
}

// Ecrit une photo sur disque si besoin et renvoie sa reference.
// Une photo relue depuis le disque porte deja "file" : on ne la reecrit pas.
async function externaliserPhoto(photo, dossier, conserves) {
  if (!photo) return null;

  if (photo.file) {
    try {
      await fs.promises.access(path.join(dossier, photo.file));
      conserves.add(photo.file);
      return { id: photo.id, name: photo.name, file: photo.file };
    } catch (err) {
      // Fichier disparu : on le reecrit depuis la data URL si on l'a encore.
    }
  }

  const decode = decodeDataUrl(photo.dataUrl);
  if (!decode) return null;

  const nom = (photo.id || newFicheId()) + '.' + extensionPour(decode.mime);
  const relatif = path.posix.join('photos', nom);
  await fs.promises.writeFile(path.join(dossier, relatif), decode.buffer);
  conserves.add(relatif);
  return { id: photo.id, name: photo.name, file: relatif };
}

async function externaliserListe(photos, dossier, conserves) {
  const source = Array.isArray(photos) ? photos : [];
  const sortie = [];
  for (const photo of source) {
    const ref = await externaliserPhoto(photo, dossier, conserves);
    if (ref) sortie.push(ref);
  }
  return sortie;
}

async function reinjecterPhoto(ref, dossier) {
  if (!ref || !ref.file) return null;
  try {
    const buffer = await fs.promises.readFile(path.join(dossier, ref.file));
    return {
      id: ref.id,
      name: ref.name,
      file: ref.file,
      dataUrl: `data:${mimePour(ref.file)};base64,${buffer.toString('base64')}`
    };
  } catch (err) {
    // Photo manquante sur le disque : la fiche reste exploitable sans elle.
    return null;
  }
}

async function reinjecterListe(refs, dossier) {
  const source = Array.isArray(refs) ? refs : [];
  const sortie = [];
  for (const ref of source) {
    const photo = await reinjecterPhoto(ref, dossier);
    if (photo) sortie.push(photo);
  }
  return sortie;
}

ipcMain.handle('fiche-save', async (event, payload) => {
  try {
    const snapshot = (payload && payload.snapshot) || {};
    const id = (payload && payload.ficheId) || newFicheId();
    const dossier = path.join(fichesDir(), id);

    await fs.promises.mkdir(path.join(dossier, 'photos'), { recursive: true });

    // Reprend le dossier d'organisation deja assigne (s'il y en a un) : un
    // simple "Enregistrer" sur une fiche deja classee ne doit pas la faire
    // ressortir de son dossier.
    let folderId = null;
    if (payload && payload.ficheId) {
      try {
        const ancien = JSON.parse(await fs.promises.readFile(path.join(dossier, 'fiche.json'), 'utf-8'));
        folderId = ancien.folderId || null;
      } catch (err) {
        // Premier enregistrement sous cet id (brouillon jamais sauvegardé) : rien à reprendre.
      }
    }

    const conserves = new Set();

    const champs = [];
    for (const champ of (Array.isArray(snapshot.champs) ? snapshot.champs : [])) {
      champs.push(Object.assign({}, champ, {
        photos: await externaliserListe(champ.photos, dossier, conserves)
      }));
    }

    const etapes = [];
    for (const etape of (Array.isArray(snapshot.etapes) ? snapshot.etapes : [])) {
      etapes.push(Object.assign({}, etape, {
        photos: await externaliserListe(etape.photos, dossier, conserves)
      }));
    }

    const couverture = await externaliserPhoto(snapshot.photo, dossier, conserves);

    const donnees = {
      version: 1,
      id,
      savedAt: new Date().toISOString(),
      folderId,
      fiche: {
        technicien: snapshot.technicien || '',
        site: snapshot.site || '',
        adresse: snapshot.adresse || '',
        date: snapshot.date || '',
        telephone: snapshot.telephone || '',
        email: snapshot.email || '',
        photo: couverture
      },
      categories: Array.isArray(snapshot.categories) ? snapshot.categories : [],
      champs,
      etapes
    };

    const cible = path.join(dossier, 'fiche.json');
    const temp = cible + '.tmp';
    await fs.promises.writeFile(temp, JSON.stringify(donnees, null, 2), 'utf-8');
    await fs.promises.rename(temp, cible);

    // Menage : les photos retirees de la fiche n'ont plus a occuper le disque.
    try {
      const presents = await fs.promises.readdir(path.join(dossier, 'photos'));
      for (const nom of presents) {
        if (!conserves.has(path.posix.join('photos', nom))) {
          await fs.promises.unlink(path.join(dossier, 'photos', nom)).catch(() => {});
        }
      }
    } catch (err) {
      // Dossier photos absent : rien a nettoyer.
    }

    return { ok: true, id, savedAt: donnees.savedAt };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});

ipcMain.handle('fiche-list', async () => {
  try {
    const entrees = await fs.promises.readdir(fichesDir(), { withFileTypes: true });
    const resultats = [];

    for (const entree of entrees) {
      if (!entree.isDirectory()) continue;
      try {
        const brut = await fs.promises.readFile(
          path.join(fichesDir(), entree.name, 'fiche.json'), 'utf-8'
        );
        const donnees = JSON.parse(brut);
        const nbPhotos =
          (donnees.champs || []).reduce((n, c) => n + ((c.photos || []).length), 0) +
          (donnees.etapes || []).reduce((n, e) => n + ((e.photos || []).length), 0);

        resultats.push({
          id: donnees.id || entree.name,
          site: (donnees.fiche && donnees.fiche.site) || '',
          adresse: (donnees.fiche && donnees.fiche.adresse) || '',
          technicien: (donnees.fiche && donnees.fiche.technicien) || '',
          date: (donnees.fiche && donnees.fiche.date) || '',
          savedAt: donnees.savedAt || '',
          folderId: donnees.folderId || null,
          nbPhotos
        });
      } catch (err) {
        // Dossier illisible ou incomplet : on l'ignore plutot que de casser la liste.
      }
    }

    resultats.sort((a, b) => String(b.savedAt).localeCompare(String(a.savedAt)));
    return resultats;
  } catch (err) {
    return [];
  }
});

// Relit une fiche depuis userData/fiches/<id>/ et reinjecte ses photos en
// data URL. Partagee par fiche-load (ouvrir/reprendre) et fiche-export-bundle
// (envoyer la fiche a un autre poste) : meme lecture, deux usages differents.
async function chargerFicheAvecPhotos(id) {
  const dossier = path.join(fichesDir(), String(id));
  const donnees = JSON.parse(await fs.promises.readFile(path.join(dossier, 'fiche.json'), 'utf-8'));

  const champs = [];
  for (const champ of (donnees.champs || [])) {
    champs.push(Object.assign({}, champ, { photos: await reinjecterListe(champ.photos, dossier) }));
  }

  const etapes = [];
  for (const etape of (donnees.etapes || [])) {
    etapes.push(Object.assign({}, etape, { photos: await reinjecterListe(etape.photos, dossier) }));
  }

  return {
    id: donnees.id || String(id),
    savedAt: donnees.savedAt || '',
    folderId: donnees.folderId || null,
    fiche: Object.assign({}, donnees.fiche, {
      photo: await reinjecterPhoto(donnees.fiche && donnees.fiche.photo, dossier)
    }),
    categories: donnees.categories || [],
    champs,
    etapes
  };
}

ipcMain.handle('fiche-load', async (event, id) => {
  try {
    return await chargerFicheAvecPhotos(id);
  } catch (err) {
    return null;
  }
});

ipcMain.handle('fiche-delete', async (event, id) => {
  try {
    await fs.promises.rm(path.join(fichesDir(), String(id)), { recursive: true, force: true });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});

// ---------- Dossiers (organisation de la bibliotheque) ----------
// Un simple regroupement visuel dans l'onglet "Fiches enregistrées" (ex : un
// dossier par site, pour retrouver une fiche des annees plus tard). Purement
// local et facultatif : une fiche sans dossier reste utilisable normalement.
// Stocke a part (userData/folders.json) plutot que dans fiche.json de chaque
// fiche, pour pouvoir lister/renommer/supprimer un dossier sans avoir a
// parcourir toute la bibliotheque. "folder" (et non "dossier") cote code,
// pour ne pas entrer en collision avec la variable locale `dossier` deja
// utilisee partout ailleurs dans ce fichier pour designer le repertoire
// disque d'UNE fiche (userData/fiches/<id>/).
function foldersPath() {
  return path.join(app.getPath('userData'), 'folders.json');
}

async function chargerFolders() {
  try {
    const raw = await fs.promises.readFile(foldersPath(), 'utf-8');
    const liste = JSON.parse(raw);
    return Array.isArray(liste) ? liste : [];
  } catch (err) {
    return [];
  }
}

async function ecrireFolders(liste) {
  const cible = foldersPath();
  const temp = cible + '.tmp';
  await fs.promises.writeFile(temp, JSON.stringify(liste, null, 2), 'utf-8');
  await fs.promises.rename(temp, cible);
}

ipcMain.handle('folder-list', async () => {
  return chargerFolders();
});

ipcMain.handle('folder-create', async (event, nom) => {
  const trimmed = String(nom || '').trim();
  if (!trimmed) return { ok: false, error: 'Le nom du dossier ne peut pas être vide.' };

  const folders = await chargerFolders();
  if (folders.some((f) => f.nom.toLowerCase() === trimmed.toLowerCase())) {
    return { ok: false, error: 'Un dossier porte déjà ce nom.' };
  }

  const folder = { id: newFicheId(), nom: trimmed };
  folders.push(folder);
  await ecrireFolders(folders);
  return { ok: true, folder };
});

ipcMain.handle('folder-rename', async (event, id, nom) => {
  const trimmed = String(nom || '').trim();
  if (!trimmed) return { ok: false, error: 'Le nom du dossier ne peut pas être vide.' };

  const folders = await chargerFolders();
  if (folders.some((f) => f.id !== id && f.nom.toLowerCase() === trimmed.toLowerCase())) {
    return { ok: false, error: 'Un dossier porte déjà ce nom.' };
  }

  const cible = folders.find((f) => f.id === id);
  if (!cible) return { ok: false, error: 'Dossier introuvable.' };

  cible.nom = trimmed;
  await ecrireFolders(folders);
  return { ok: true };
});

// Supprime le dossier lui-meme, mais jamais les fiches qu'il contenait :
// elles repassent simplement en "Non classées" (folderId remis a null).
ipcMain.handle('folder-delete', async (event, id) => {
  const folders = await chargerFolders();
  await ecrireFolders(folders.filter((f) => f.id !== id));

  try {
    const entrees = await fs.promises.readdir(fichesDir(), { withFileTypes: true });
    for (const entree of entrees) {
      if (!entree.isDirectory()) continue;
      const ficheJsonPath = path.join(fichesDir(), entree.name, 'fiche.json');
      try {
        const donnees = JSON.parse(await fs.promises.readFile(ficheJsonPath, 'utf-8'));
        if (donnees.folderId === id) {
          donnees.folderId = null;
          await fs.promises.writeFile(ficheJsonPath, JSON.stringify(donnees, null, 2), 'utf-8');
        }
      } catch (err) {
        // Fiche illisible : on l'ignore plutot que de bloquer la suppression du dossier.
      }
    }
  } catch (err) {
    // Pas de bibliotheque : rien a mettre a jour.
  }

  return { ok: true };
});

ipcMain.handle('fiche-set-folder', async (event, ficheId, folderId) => {
  try {
    const ficheJsonPath = path.join(fichesDir(), String(ficheId), 'fiche.json');
    const donnees = JSON.parse(await fs.promises.readFile(ficheJsonPath, 'utf-8'));
    donnees.folderId = folderId || null;
    await fs.promises.writeFile(ficheJsonPath, JSON.stringify(donnees, null, 2), 'utf-8');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});

// ---------- Export / import d'une fiche vers/depuis un autre poste ----------
// La bibliotheque (userData/fiches/<id>/) est locale a chaque machine : ces
// deux commandes permettent de faire voyager UNE fiche (cle USB, mail, reseau
// partage...) sous la forme d'un seul fichier .json autoporteur, photos
// incluses en base64. C'est le meme format que ce que fiche-load renvoie au
// renderer, juste enveloppe avec un marqueur de type pour le distinguer d'un
// fichier quelconque a l'import.
const BUNDLE_TYPE = 'fiche-maintenance-export';

// Mot de passe facultatif sur le fichier .json de transfert : AES-256-GCM,
// cle derivee du mot de passe via scrypt (sel aleatoire, jamais reutilise).
// Uniquement des modules integres a Node — pas de dependance ajoutee au
// projet pour ca. Le PDF, lui, ne peut pas etre protege de la meme facon :
// voir protegerPdf() plus haut, qui passe par qpdf (le format PDF a son
// propre schema de chiffrement, que crypto seul ne sait pas produire).
function chiffrerJson(objet, motDePasse) {
  const sel = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const cle = crypto.scryptSync(motDePasse, sel, 32);
  const cipher = crypto.createCipheriv('aes-256-gcm', cle, iv);
  const chiffre = Buffer.concat([cipher.update(JSON.stringify(objet), 'utf-8'), cipher.final()]);
  return {
    encrypted: true,
    version: 1,
    salt: sel.toString('hex'),
    iv: iv.toString('hex'),
    authTag: cipher.getAuthTag().toString('hex'),
    ciphertext: chiffre.toString('hex')
  };
}

// Renvoie null si le mot de passe est incorrect (echec d'authentification
// GCM) plutot que de laisser l'exception remonter brute a l'appelant.
function dechiffrerJson(payload, motDePasse) {
  try {
    const sel = Buffer.from(payload.salt, 'hex');
    const iv = Buffer.from(payload.iv, 'hex');
    const cle = crypto.scryptSync(motDePasse, sel, 32);
    const decipher = crypto.createDecipheriv('aes-256-gcm', cle, iv);
    decipher.setAuthTag(Buffer.from(payload.authTag, 'hex'));
    const clair = Buffer.concat([decipher.update(Buffer.from(payload.ciphertext, 'hex')), decipher.final()]);
    return JSON.parse(clair.toString('utf-8'));
  } catch (err) {
    return null;
  }
}

// Ecrit le bundle importe dans la bibliotheque locale, sous un nouvel id :
// partagee par les deux chemins d'import (protege ou non), pour ne pas
// dupliquer cette logique.
async function importerBundle(bundle) {
  if (!bundle || bundle.type !== BUNDLE_TYPE) {
    return { canceled: false, ok: false, error: "Ce fichier n'est pas une fiche exportée valide." };
  }

  // Toujours un nouvel id local : importer ne doit jamais ecraser une
  // fiche existante sur ce poste, meme si le fichier a deja ete importe.
  const id = newFicheId();
  const dossier = path.join(fichesDir(), id);
  await fs.promises.mkdir(path.join(dossier, 'photos'), { recursive: true });
  const conserves = new Set();

  const champs = [];
  for (const champ of (Array.isArray(bundle.champs) ? bundle.champs : [])) {
    champs.push(Object.assign({}, champ, {
      photos: await externaliserListe(champ.photos, dossier, conserves)
    }));
  }

  const etapes = [];
  for (const etape of (Array.isArray(bundle.etapes) ? bundle.etapes : [])) {
    etapes.push(Object.assign({}, etape, {
      photos: await externaliserListe(etape.photos, dossier, conserves)
    }));
  }

  const couverture = await externaliserPhoto(bundle.fiche && bundle.fiche.photo, dossier, conserves);

  const donnees = {
    version: 1,
    id,
    savedAt: new Date().toISOString(),
    fiche: {
      technicien: (bundle.fiche && bundle.fiche.technicien) || '',
      site: (bundle.fiche && bundle.fiche.site) || '',
      adresse: (bundle.fiche && bundle.fiche.adresse) || '',
      date: (bundle.fiche && bundle.fiche.date) || '',
      telephone: (bundle.fiche && bundle.fiche.telephone) || '',
      email: (bundle.fiche && bundle.fiche.email) || '',
      photo: couverture
    },
    categories: Array.isArray(bundle.categories) ? bundle.categories : [],
    champs,
    etapes
  };

  const cible = path.join(dossier, 'fiche.json');
  await fs.promises.writeFile(cible, JSON.stringify(donnees, null, 2), 'utf-8');

  return { canceled: false, ok: true, id, site: donnees.fiche.site };
}

ipcMain.handle('fiche-export-bundle', async (event, id, motDePasse) => {
  try {
    const donnees = await chargerFicheAvecPhotos(id);

    const bundle = {
      bundleVersion: 1,
      type: BUNDLE_TYPE,
      exportedAt: new Date().toISOString(),
      fiche: donnees.fiche,
      categories: donnees.categories,
      champs: donnees.champs,
      etapes: donnees.etapes
    };

    const contenu = motDePasse ? chiffrerJson(bundle, motDePasse) : bundle;

    const defaultName = `Fiche_${sanitizeFilename(donnees.fiche && donnees.fiche.site)}_${(donnees.fiche && donnees.fiche.date) || ''}.json`;
    const saveResult = await dialog.showSaveDialog(mainWindow, {
      title: 'Exporter la fiche vers un autre poste',
      defaultPath: path.join(app.getPath('documents'), defaultName),
      filters: [{ name: 'Fiche de maintenance (.json)', extensions: ['json'] }]
    });

    if (saveResult.canceled || !saveResult.filePath) return { canceled: true };

    await fs.promises.writeFile(saveResult.filePath, JSON.stringify(contenu), 'utf-8');
    return { canceled: false, filePath: saveResult.filePath };
  } catch (err) {
    return { canceled: false, error: (err && err.message) || String(err) };
  }
});

ipcMain.handle('fiche-import-bundle', async () => {
  try {
    const openResult = await dialog.showOpenDialog(mainWindow, {
      title: 'Importer une fiche',
      filters: [{ name: 'Fiche de maintenance (.json)', extensions: ['json'] }],
      properties: ['openFile']
    });

    if (openResult.canceled || !openResult.filePaths.length) return { canceled: true };

    const filePath = openResult.filePaths[0];
    const raw = await fs.promises.readFile(filePath, 'utf-8');
    const payload = JSON.parse(raw);

    // Fichier protege : on s'arrete ici, le renderer redemande le mot de
    // passe puis rappelle fiche-import-bundle-with-password avec ce meme
    // chemin, sans rouvrir le selecteur de fichier.
    if (payload && payload.encrypted) {
      return { canceled: false, needsPassword: true, filePath };
    }

    return await importerBundle(payload);
  } catch (err) {
    return { canceled: false, ok: false, error: (err && err.message) || String(err) };
  }
});

ipcMain.handle('fiche-import-bundle-with-password', async (event, filePath, motDePasse) => {
  try {
    const raw = await fs.promises.readFile(filePath, 'utf-8');
    const payload = JSON.parse(raw);
    const bundle = dechiffrerJson(payload, motDePasse || '');
    if (!bundle) {
      return { canceled: false, ok: false, error: 'Mot de passe incorrect.' };
    }
    return await importerBundle(bundle);
  } catch (err) {
    return { canceled: false, ok: false, error: (err && err.message) || String(err) };
  }
});

ipcMain.handle('draft-clear', async () => {
  try {
    await fs.promises.unlink(draftPath());
  } catch (err) {
    // Pas de brouillon a supprimer : rien a signaler.
  }
  return { ok: true };
});

// ---------- Protection du PDF par mot de passe ----------
// Chromium (printToPDF) ne sait pas poser de mot de passe d'ouverture sur un
// PDF, et il ne suffit pas de chiffrer les octets du fichier comme pour le
// JSON d'export/import (chiffrerJson/dechiffrerJson) : un PDF a son propre
// schema de chiffrement normalise, que les lecteurs doivent reconnaitre pour
// proposer une invite de mot de passe standard. On embarque donc qpdf (outil
// libre, Apache-2.0, voir resources/qpdf/LICENSE-qpdf.txt) et on l'appelle en
// sous-processus plutot que de reimplementer ce schema a la main.
function qpdfExePath() {
  // En dev (npm start), l'app n'est pas empaquetee : on lit directement le
  // dossier source. Une fois empaquetee, electron-builder copie
  // resources/qpdf/ (voir "extraResources" dans package.json) a cote de
  // l'exe, sous process.resourcesPath.
  return app.isPackaged
    ? path.join(process.resourcesPath, 'qpdf', 'qpdf.exe')
    : path.join(__dirname, '..', '..', 'resources', 'qpdf', 'qpdf.exe');
}

function runQpdf(args) {
  return new Promise((resolve, reject) => {
    execFile(qpdfExePath(), args, { windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error((stderr && String(stderr).trim()) || err.message));
      } else {
        resolve();
      }
    });
  });
}

// Meme mot de passe cote lecture et cote proprietaire : on ne cherche pas a
// restreindre l'impression ou la copie, juste a demander un mot de passe a
// l'ouverture, comme n'importe quel PDF protege recu par mail. En cas
// d'echec (binaire manquant, qpdf en erreur...), l'exception remonte a
// l'appelant : pas de repli silencieux vers un PDF non protege alors qu'un
// mot de passe a ete demande.
async function protegerPdf(pdfBuffer, motDePasse, tmpDir) {
  const entree = path.join(tmpDir, 'rapport.pdf');
  const sortie = path.join(tmpDir, 'rapport-protege.pdf');
  await fs.promises.writeFile(entree, pdfBuffer);
  await runQpdf(['--encrypt', motDePasse, motDePasse, '256', '--', entree, sortie]);
  return fs.promises.readFile(sortie);
}

// ---------- Export PDF ----------
ipcMain.handle('export-pdf', async (event, fiche, motDePasse, options) => {
  let tmpDir;
  let pdfWindow;
  try {
    const html = buildReportHtml(fiche, options);

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fiche-maintenance-'));
    const tmpHtmlPath = path.join(tmpDir, 'rapport.html');
    fs.writeFileSync(tmpHtmlPath, html, 'utf-8');

    pdfWindow = new BrowserWindow({
      show: false,
      webPreferences: { sandbox: false }
    });

    await pdfWindow.loadFile(tmpHtmlPath);

    const siteLabel = escapeHtml((fiche && fiche.site) || '');
    const footerTemplate = `
      <div style="width:100%;padding:0 14mm;font-family:'Segoe UI',Arial,sans-serif;font-size:7pt;color:#9ca3af;display:flex;justify-content:space-between;">
        <span>Fiche de maintenance — ${siteLabel}</span>
        <span>Page <span class="pageNumber"></span> / <span class="totalPages"></span></span>
      </div>`;

    let pdfBuffer = await pdfWindow.webContents.printToPDF({
      pageSize: 'A4',
      printBackground: true,
      // Marges en pouces. Elles doivent rester cohérentes avec le padding
      // @media screen du template, sinon l'aperçu et le PDF divergent.
      margins: { top: 0.47, bottom: 0.63, left: 0.55, right: 0.55 },
      displayHeaderFooter: true,
      headerTemplate: '<span></span>',
      footerTemplate
    });

    if (motDePasse) {
      pdfBuffer = await protegerPdf(pdfBuffer, motDePasse, tmpDir);
    }

    const suffix = options && options.hideEtapes ? '_Client' : '';
    const defaultName = `Fiche_maintenance_${sanitizeFilename(fiche && fiche.site)}_${(fiche && fiche.date) || ''}${suffix}.pdf`;
    const saveResult = await dialog.showSaveDialog(mainWindow, {
      title: 'Exporter la fiche en PDF',
      defaultPath: path.join(app.getPath('documents'), defaultName),
      filters: [{ name: 'Fichier PDF', extensions: ['pdf'] }]
    });

    if (saveResult.canceled || !saveResult.filePath) {
      return { canceled: true };
    }

    fs.writeFileSync(saveResult.filePath, pdfBuffer);
    return { canceled: false, filePath: saveResult.filePath };
  } catch (err) {
    return { canceled: false, error: (err && err.message) || String(err) };
  } finally {
    if (pdfWindow && !pdfWindow.isDestroyed()) {
      pdfWindow.destroy();
    }
    if (tmpDir) {
      fs.rm(tmpDir, { recursive: true, force: true }, () => {});
    }
  }
});
