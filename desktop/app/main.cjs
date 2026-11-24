const { app, BrowserWindow, dialog, shell } = require('electron');
const dotenv = require('dotenv');
const net = require('node:net');
const { randomUUID } = require('node:crypto');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

let mainWindow;
let shutdown;
let isQuitting = false;

function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function assertLocalPortAvailable(port) {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', error => reject(new Error('JPTI cannot start because local port ' + port + ' is already in use. Close the other service or change its port.')));
    probe.listen(port, '127.0.0.1', () => probe.close(error => error ? reject(error) : resolve()));
  });
}

async function waitForApi() {
  const url = 'http://127.0.0.1:8787/api/health';
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1200) });
      if (response.ok) {
        const health = await response.json();
        if (health.desktopInstanceId === process.env.JPTI_DESKTOP_INSTANCE_ID) return;
      }
    } catch {}
    await delay(300);
  }
  throw new Error('The local JPTI API did not become ready on port 8787. Check whether another JPTI instance is running.');
}

function compareVersions(left, right) {
  const a = String(left || '0').split('.').map(value => Number.parseInt(value, 10) || 0);
  const b = String(right || '0').split('.').map(value => Number.parseInt(value, 10) || 0);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] || 0) - (b[index] || 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

async function checkForDesktopUpdate() {
  if (!app.isPackaged || !mainWindow || mainWindow.isDestroyed()) return;
  try {
    const response = await fetch('https://api.github.com/repos/kyleel2249/JPTI/releases?per_page=10', {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'JPTI-Desktop-Updater' },
      signal: AbortSignal.timeout(8000),
      cache: 'no-store'
    });
    if (!response.ok) throw new Error('GitHub release check returned HTTP ' + response.status);
    const releases = await response.json();
    const latest = Array.isArray(releases)
      ? releases.find(release => !release.draft && /^v?\d+\.\d+\.\d+$/.test(String(release.tag_name || '')) && release.assets?.length)
      : null;
    if (!latest) return;
    const latestVersion = String(latest.tag_name).replace(/^v/, '');
    if (compareVersions(latestVersion, app.getVersion()) <= 0) return;

    const platformPattern = process.platform === 'win32' ? /\.exe$/i
      : process.platform === 'darwin' ? /\.dmg$/i
      : /\.AppImage$|\.deb$/i;
    const asset = latest.assets.find(item => platformPattern.test(item.name));
    if (!asset) return;

    const choice = await dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: 'JPTI update available',
      message: 'JPTI ' + latestVersion + ' is available.',
      detail: 'Installed version: ' + app.getVersion() + '\nThe update package will open in your browser. Close JPTI before running the installer.',
      buttons: ['Download update', 'Later'],
      defaultId: 0,
      cancelId: 1,
      noLink: true
    });
    if (choice.response === 0) await shell.openExternal(asset.browser_download_url);
  } catch (error) {
    console.warn('[JPTI updater] Update check skipped:', error.message);
  }
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1480, height: 940, minWidth: 1024, minHeight: 700,
    backgroundColor: '#080d18',
    title: 'JPTI — Jopearl Trading Intelligence',
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) shell.openExternal(url);
    return { action: 'deny' };
  });
  await mainWindow.loadURL('http://127.0.0.1:8787/');
}

app.whenReady().then(async () => {
  app.setAppUserModelId('com.jopearl.jpti');
  try {
    const root = app.getAppPath();
    await assertLocalPortAvailable(8787);
    process.env.JPTI_DESKTOP_INSTANCE_ID = randomUUID();
    // Per-user desktop settings take priority; the repository .env.local is a
    // convenient fallback for running the desktop app from a local checkout.
    dotenv.config({ path: path.join(app.getPath('userData'), '.env'), override: false });
    dotenv.config({ path: path.join(root, '.env.local'), override: false });
    process.env.JPTI_API_HOST = '127.0.0.1';
    process.env.JPTI_ALLOW_LOCAL_PRIVATE_ACCESS = 'true';
    process.env.JPTI_REQUIRE_EDGE_SECRET = 'false';
    process.env.JPTI_API_PORT = '8787';
    process.env.PORT = '8787';
    process.env.JPTI_STORAGE_BACKEND = 'file';
    process.env.JPTI_DATA_DIR = path.join(app.getPath('userData'), 'data');
    process.env.JPTI_WEB_DIST = path.join(root, 'dist');
    process.env.JPTI_TBOTS_PUBLIC_DIR = path.join(root, 'integrations', 't-bots', 'public');
    process.env.JPTI_SERVE_WEB = 'true';
    process.env.JPTI_TRADING_MODE = 'paper';
    process.env.JPTI_ENABLE_LIVE_TRADING = 'false';
    const api = await import(pathToFileURL(path.join(root, 'api/server.js')).href);
    shutdown = api.shutdownJptiServer;
    await waitForApi();
    await createWindow();
    setTimeout(() => { void checkForDesktopUpdate(); }, 8000);
    setInterval(() => { void checkForDesktopUpdate(); }, 6 * 60 * 60 * 1000);
  } catch (error) {
    dialog.showErrorBox('JPTI could not start', error.message);
    app.quit();
  }
});

app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', event => {
  if (isQuitting || !shutdown) return;
  event.preventDefault();
  isQuitting = true;
  Promise.resolve(shutdown()).finally(() => app.exit(0));
});
