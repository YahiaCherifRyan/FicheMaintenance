const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  exportPdf: (fiche, password, options) => ipcRenderer.invoke('export-pdf', fiche, password, options),
  getLogo: () => ipcRenderer.invoke('get-logo'),

  // Brouillon de la fiche en cours
  setFicheEnCours: (value) => ipcRenderer.send('set-fiche-en-cours', value),
  draftSave: (payload) => ipcRenderer.invoke('draft-save', payload),
  draftLoad: () => ipcRenderer.invoke('draft-load'),
  draftClear: () => ipcRenderer.invoke('draft-clear'),

  // Bibliotheque de fiches enregistrees
  ficheSave: (snapshot, ficheId) => ipcRenderer.invoke('fiche-save', { snapshot, ficheId }),
  ficheList: () => ipcRenderer.invoke('fiche-list'),
  ficheLoad: (id) => ipcRenderer.invoke('fiche-load', id),
  ficheDelete: (id) => ipcRenderer.invoke('fiche-delete', id),

  // Dossiers d'organisation de la bibliotheque (facultatifs)
  folderList: () => ipcRenderer.invoke('folder-list'),
  folderCreate: (nom) => ipcRenderer.invoke('folder-create', nom),
  folderRename: (id, nom) => ipcRenderer.invoke('folder-rename', id, nom),
  folderDelete: (id) => ipcRenderer.invoke('folder-delete', id),
  ficheSetFolder: (ficheId, folderId) => ipcRenderer.invoke('fiche-set-folder', ficheId, folderId),

  // Transfert d'une fiche vers/depuis un autre poste (fichier .json autoporteur,
  // mot de passe facultatif)
  ficheExportBundle: (id, password) => ipcRenderer.invoke('fiche-export-bundle', id, password),
  ficheImportBundle: () => ipcRenderer.invoke('fiche-import-bundle'),
  ficheImportBundleWithPassword: (filePath, password) =>
    ipcRenderer.invoke('fiche-import-bundle-with-password', filePath, password)
});
