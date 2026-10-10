const fs = require('node:fs/promises');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'release', '页间');
const runtime = path.dirname(require('electron'));

(async () => {
  await fs.mkdir(output, { recursive: true });
  for (const entry of await fs.readdir(runtime)) {
    if (entry === 'electron.exe') continue;
    await fs.cp(path.join(runtime, entry), path.join(output, entry), { recursive: true });
  }
  await fs.copyFile(path.join(runtime, 'electron.exe'), path.join(output, '页间 V0.2.exe'));
  const appRoot = path.join(output, 'resources', 'app');
  await fs.mkdir(appRoot, { recursive: true });
  for (const entry of ['electron', 'dist', 'package.json']) await fs.cp(path.join(root, entry), path.join(appRoot, entry), { recursive: true });
  console.log('Portable application: ' + path.join(output, '页间 V0.2.exe'));
})().catch(error => { console.error(error.message); process.exitCode = 1; });
