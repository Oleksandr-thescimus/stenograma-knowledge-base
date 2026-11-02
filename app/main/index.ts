import { join } from 'node:path';
import { app, BrowserWindow, shell } from 'electron';

// Links open in the default browser, and only with these schemes
const EXTERNAL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

const openExternally = (url: string) => {
  if (URL.canParse(url) && EXTERNAL_PROTOCOLS.has(new URL(url).protocol)) {
    // The URL isn't logged: links in emails and messages can carry private data
    shell.openExternal(url).catch(() => console.error('Opening a link in the browser failed'));
  }
};

const showWindow = (window: BrowserWindow) => {
  if (window.isMinimized()) {
    window.restore();
  }

  window.show();
  window.focus();
};

const createWindow = () => {
  const window = new BrowserWindow({
    width: 1100,
    height: 760,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      // The renderer will show emails and messages written by other people, so it gets no Node access
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });

  window.once('ready-to-show', () => window.show());

  // No new windows: a link that asks for one opens in the browser
  window.webContents.setWindowOpenHandler(({ url }) => {
    openExternally(url);

    return { action: 'deny' };
  });

  // The window never leaves the app's page; a reload (same URL) is allowed
  window.webContents.on('will-navigate', (event, url) => {
    if (url !== window.webContents.getURL()) {
      event.preventDefault();
      openExternally(url);
    }
  });

  // electron-vite dev serves the renderer with hot reload. A packaged app never loads a URL from the environment
  const devServerUrl = app.isPackaged ? undefined : process.env.ELECTRON_RENDERER_URL;

  if (devServerUrl) {
    window.loadURL(devServerUrl);
  } else {
    window.loadFile(join(__dirname, '../renderer/index.html'));
  }
};

// One instance: starting the app again shows the running one's window
if (app.requestSingleInstanceLock()) {
  app.on('second-instance', () => {
    const [window] = BrowserWindow.getAllWindows();

    if (window) {
      showWindow(window);
    }
  });

  app.on('window-all-closed', () => app.quit());
  app.whenReady().then(createWindow);
} else {
  app.quit();
}
