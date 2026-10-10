const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('readerAPI', {
  getState: () => ipcRenderer.invoke('state:get'),
  setFullscreen: (enabled) => ipcRenderer.invoke('window:setFullscreen', enabled),
  onFullscreenChange: (callback) => {
    const listener = (_event, enabled) => callback(enabled);
    ipcRenderer.on('window:fullscreenChanged', listener);
    return () => ipcRenderer.removeListener('window:fullscreenChanged', listener);
  },
  onReadingShortcut: (callback) => {
    const listener = (_event, key) => callback(key);
    ipcRenderer.on('window:readingShortcut', listener);
    return () => ipcRenderer.removeListener('window:readingShortcut', listener);
  },
  importBooks: () => ipcRenderer.invoke('books:import'),
  getBook: (id) => ipcRenderer.invoke('books:get', id),
  updateBook: (id, changes) => ipcRenderer.invoke('books:update', id, changes),
  saveNote: (id, note) => ipcRenderer.invoke('notes:save', id, note),
  deleteNote: (id, noteId) => ipcRenderer.invoke('notes:delete', id, noteId),
  chooseVault: () => ipcRenderer.invoke('vault:choose'),
  syncAll: () => ipcRenderer.invoke('vault:syncAll'),
  openExport: (id) => ipcRenderer.invoke('vault:openExport', id),
  aiSettings: () => ipcRenderer.invoke('ai:settings'),
  configureAi: (input) => ipcRenderer.invoke('ai:configure', input),
  testAi: () => ipcRenderer.invoke('ai:test'),
  listReviews: () => ipcRenderer.invoke('review:list'),
  createReview: (bookId, input) => ipcRenderer.invoke('review:create', bookId, input),
  sendReview: (id, content, retry = false) => ipcRenderer.invoke('review:send', id, content, retry),
  cancelReview: (id) => ipcRenderer.invoke('review:cancel', id),
  bookmarkReply: (id, messageId) => ipcRenderer.invoke('review:bookmark', id, messageId),
  saveAction: (id, input) => ipcRenderer.invoke('review:action', id, input),
  exportReview: (id) => ipcRenderer.invoke('review:export', id),
  openReviewExport: (id) => ipcRenderer.invoke('review:openExport', id)
});
