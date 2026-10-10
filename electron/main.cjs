const { app, BrowserWindow, dialog, ipcMain, shell, safeStorage, net } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { ReaderStore } = require('./store.cjs');
const { AiSettings, chat, messagesFor } = require('./ai.cjs');
const { Reflections } = require('./reflections.cjs');

let window;
let store;
let settings;
let reflections;
const requests = new Map();
const exportFolder = path.join('EPUB 阅读笔记', 'V0.2');

app.setPath('userData', process.env.EPUB_READER_DATA_DIR || path.join(app.getPath('appData'), 'epub-obsidian-reader-v02'));
const primaryInstance = app.requestSingleInstanceLock();
if (!primaryInstance) app.quit();
app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); } });

async function migrateLegacy(root) {
  // Copy once. Neither the original library nor its Markdown exports are modified.
  try { await fs.access(path.join(root, 'library.json')); return; } catch {}
  if (process.env.EPUB_READER_DATA_DIR) return;
  const legacyFile = path.join(app.getPath('appData'), 'epub-obsidian-reader', 'library.json');
  let data;
  try { data = JSON.parse(await fs.readFile(legacyFile, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  await fs.mkdir(path.join(root, 'books'), { recursive: true });
  for (const book of data.books || []) {
    const destination = path.join(root, 'books', `${book.id}.epub`);
    await fs.copyFile(book.file, destination);
    book.file = destination;
    if (data.vaultPath && book.exportFile) {
      const source = path.join(data.vaultPath, 'EPUB 阅读笔记', book.exportFile);
      const folder = path.join(data.vaultPath, exportFolder);
      try {
        await fs.mkdir(folder, { recursive: true });
        await fs.copyFile(source, path.join(folder, book.exportFile), require('node:fs').constants.COPYFILE_EXCL);
      } catch (error) { if (!['ENOENT', 'EEXIST'].includes(error.code)) throw error; }
    }
  }
  await fs.writeFile(path.join(root, 'library.json'), JSON.stringify(data, null, 2), 'utf8');
}

function createWindow() {
  window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 950,
    minHeight: 620,
    title: '页间 V0.2 · 阅读与行动',
    backgroundColor: '#f6f3ed',
    show: !process.env.EPUB_READER_SMOKE,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      backgroundThrottling: !process.env.EPUB_READER_SMOKE
    }
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.on('enter-full-screen', () => window.webContents.send('window:fullscreenChanged', true));
  window.on('leave-full-screen', () => window.webContents.send('window:fullscreenChanged', false));
  window.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || input.isAutoRepeat) return;
    if (input.key === 'F11' || (input.key === 'Escape' && window.isFullScreen())) {
      event.preventDefault();
      window.webContents.send('window:readingShortcut', input.key);
    }
  });
  window.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
}

app.whenReady().then(async () => {
  if (!primaryInstance) return;
  const root = app.getPath('userData');
  await migrateLegacy(root);
  store = new ReaderStore(root, exportFolder);
  await store.init();
  settings = new AiSettings(root, safeStorage);
  reflections = new Reflections(root);
  await settings.init();
  await reflections.init();
  ipcMain.handle('state:get', () => store.publicState());
  ipcMain.handle('window:setFullscreen', (event, enabled) => {
    if (typeof enabled !== 'boolean' || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error('无效的窗口操作');
    window.setFullScreen(enabled);
    return enabled;
  });
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
    const file = path.join(store.data.vaultPath, exportFolder, book.exportFile);
    const error = await shell.openPath(file);
    if (error) throw new Error(error);
    return true;
  });
  ipcMain.handle('ai:settings', () => settings.publicState());
  ipcMain.handle('ai:configure', (_event, input) => settings.save(input || {}));
  ipcMain.handle('ai:test', async () => {
    const content = await chat(settings.credentials(), [{ role: 'user', content: '请只回复：连接成功' }], net.fetch);
    return { ok: true, content };
  });
  ipcMain.handle('review:list', () => reflections.sessions);
  ipcMain.handle('review:create', (_event, bookId, input) => reflections.enqueue(() => reflections.create(store.book(bookId), input || {})));
  ipcMain.handle('review:send', async (_event, id, content, retry) => {
    if (requests.has(id)) throw new Error('这次回顾正在等待回复');
    const credentials = settings.credentials();
    const controller = new AbortController();
    requests.set(id, controller);
    let prepared = false;
    try {
      const session = await reflections.enqueue(() => reflections.prepare(id, content, retry));
      prepared = true;
      const reply = await chat(credentials, messagesFor(session), net.fetch, controller.signal);
      return { session: await reflections.enqueue(() => reflections.complete(id, reply)) };
    } catch (error) {
      if (!prepared) throw error;
      return { session: await reflections.enqueue(() => reflections.fail(id, error.message)), error: error.message };
    } finally { requests.delete(id); }
  });
  ipcMain.handle('review:cancel', (_event, id) => { requests.get(id)?.abort(); });
  const saveAndSync = async work => {
    const session = await work();
    return { session, sync: await reflections.sync(session, store.data.vaultPath) };
  };
  ipcMain.handle('review:bookmark', (_event, id, messageId) => reflections.enqueue(() => saveAndSync(() => reflections.bookmark(id, messageId))));
  ipcMain.handle('review:action', (_event, id, input) => reflections.enqueue(() => saveAndSync(() => reflections.action(id, input || {}))));
  ipcMain.handle('review:export', (_event, id) => reflections.enqueue(() => reflections.sync(reflections.get(id), store.data.vaultPath)));
  ipcMain.handle('review:openExport', async (_event, id) => {
    const result = await reflections.enqueue(() => reflections.sync(reflections.get(id), store.data.vaultPath));
    if (result.status !== 'synced') return result;
    const error = await shell.openPath(result.path);
    if (error) throw new Error(error);
    return result;
  });
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
}).catch(error => { dialog.showErrorBox('V0.2 启动失败', error.message); app.quit(); });

app.on('before-quit', () => { for (const controller of requests.values()) controller.abort(); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
