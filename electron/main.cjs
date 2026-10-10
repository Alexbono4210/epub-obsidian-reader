const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { ReaderStore } = require('./store.cjs');

let window;
let store;

if (process.env.EPUB_READER_DATA_DIR) app.setPath('userData', process.env.EPUB_READER_DATA_DIR);

function createWindow() {
  window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 950,
    minHeight: 620,
    title: '页间 · EPUB 阅读器',
    backgroundColor: '#f6f3ed',
    show: !process.env.EPUB_READER_SMOKE,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true
    }
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
}

app.whenReady().then(async () => {
  store = new ReaderStore(process.env.EPUB_READER_DATA_DIR || app.getPath('userData'));
  await store.init();
  ipcMain.handle('state:get', () => store.publicState());
  ipcMain.handle('books:import', async () => {
    const result = await dialog.showOpenDialog(window, {
      title: '导入 EPUB',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'EPUB 电子书', extensions: ['epub'] }]
    });
    if (result.canceled) return { state: store.publicState(), imported: [] };
    return store.enqueue(async () => {
      const imported = [];
      for (const file of result.filePaths) imported.push(await store.importFile(file));
      return { state: store.publicState(), imported };
    });
  });
  ipcMain.handle('books:get', async (_event, id) => {
    const book = store.book(id);
    return (await fs.readFile(book.file)).toString('base64');
  });
  ipcMain.handle('books:update', (_event, id, changes) => store.enqueue(() => store.updateBook(id, changes || {})));
  ipcMain.handle('notes:save', (_event, id, note) => store.enqueue(() => store.saveNote(id, note)));
  ipcMain.handle('notes:delete', (_event, id, noteId) => store.enqueue(() => store.deleteNote(id, noteId)));
  ipcMain.handle('vault:choose', async () => {
    const result = await dialog.showOpenDialog(window, {
      title: '选择 Obsidian 仓库文件夹',
      defaultPath: store.data.vaultPath || undefined,
      properties: ['openDirectory']
    });
    if (result.canceled) return { state: store.publicState(), results: [] };
    return store.enqueue(() => store.setVault(result.filePaths[0]));
  });
  ipcMain.handle('vault:syncAll', () => store.enqueue(() => store.syncAll()));
  ipcMain.handle('vault:openExport', async (_event, id) => {
    const book = store.book(id);
    if (!store.data.vaultPath || !book.exportFile) return false;
    const file = path.join(store.data.vaultPath, 'EPUB 阅读笔记', book.exportFile);
    const error = await shell.openPath(file);
    if (error) throw new Error(error);
    return true;
  });
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
