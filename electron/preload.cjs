const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('readerAPI', {
  getState: () => ipcRenderer.invoke('state:get'),
  importBooks: () => ipcRenderer.invoke('books:import'),
  getBook: (id) => ipcRenderer.invoke('books:get', id),
  updateBook: (id, changes) => ipcRenderer.invoke('books:update', id, changes),
  saveNote: (id, note) => ipcRenderer.invoke('notes:save', id, note),
  deleteNote: (id, noteId) => ipcRenderer.invoke('notes:delete', id, noteId),
  chooseVault: () => ipcRenderer.invoke('vault:choose'),
  syncAll: () => ipcRenderer.invoke('vault:syncAll'),
  openExport: (id) => ipcRenderer.invoke('vault:openExport', id)
});
