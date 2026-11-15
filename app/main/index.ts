import { join } from 'node:path';
import { app, BrowserWindow, ipcMain, Menu, nativeImage, Notification, screen, shell, Tray } from 'electron';
import type { AppEvent, AppStatus, CoreMethods, CoreStatus, ProcessStatus } from '../../core/protocol';
import windowIconPath from '../../resources/icon.png?asset';
import trayIconPath from '../../resources/tray.png?asset';
import coreHostPath from '../core-host/index?modulePath';
import { HIDDEN_ARG, syncAutostart } from './autostart';
import { createCoreSupervisor } from './core';
import { checkCall } from './ipc';

// The app (docs/PLAN.md, M3): one instance, in the tray, starting at login. The core runs in a utilityProcess, so
// syncing and the extension's pushes go on while the window is closed; only Quit stops them

// Links open in the default browser, and only with these schemes
const EXTERNAL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

const openExternally = (url: string) => {
  if (URL.canParse(url) && EXTERNAL_PROTOCOLS.has(new URL(url).protocol)) {
    // The URL isn't logged: links in emails and messages can carry private data
    shell.openExternal(url).catch(() => console.error('Opening a link in the browser failed'));
  }
};

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;
let coreStatus: CoreStatus | null = null;
// The setting as last read from the core; null until it runs
let startAtLogin: boolean | null = null;

const appStatus = (): AppStatus => ({ process: core.getStatus(), core: coreStatus });

const sendToRenderer = (event: AppEvent) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('kb:event', event);
  }
};

const describeProcess = (status: ProcessStatus) => {
  switch (status.state) {
    case 'running':
      return 'The knowledge base is running';
    case 'restarting':
      return 'The knowledge base stopped; starting it again';
    case 'stopped':
      return 'The knowledge base is stopped';
    default:
      return 'The knowledge base is starting';
  }
};

// The window opens maximized the first time it's shown
let shownOnce = false;

// GNOME on X11 ignores maximizing a window it hasn't mapped yet, even right after show(): once it's shown, and again a
// moment later
const maximizeWhenShown = (window: BrowserWindow) => {
  window.once('show', () => {
    window.maximize();
    setTimeout(() => !window.isDestroyed() && !window.isMaximized() && window.maximize(), 300);
  });
};

const showWindow = () => {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow(true);

    return;
  }

  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }

  // Maximized the first time it's shown (it starts hidden in the tray at login); as the user left it after that
  if (!shownOnce) {
    shownOnce = true;
    maximizeWhenShown(mainWindow);
  }

  mainWindow.show();
  mainWindow.focus();
};

// The background AI work (images, summaries) takes the GPU: it's paused from the tray too, without opening the window
const imagesItem = (): Electron.MenuItemConstructorOptions[] => {
  const attachments = coreStatus?.attachments;

  if (!attachments || core.getStatus().state !== 'running') {
    return [];
  }

  const call = (method: 'pauseBackground' | 'resumeBackground', params: { minutes: number | null } | Record<string, never>) => core
    .invoke(method, params as never).catch((error: unknown) => console.error(`${method}: ${(error as Error).message}`));

  return attachments.paused
    ? [{ label: 'Resume the background AI work', click: () => call('resumeBackground', {}) }]
    : [{ label: 'Pause the background AI work for an hour', click: () => call('pauseBackground', { minutes: 60 }) }];
};

// Each AI server's background queue on or off (Settings → AI models): another server takes the work of one turned off
const backgroundServerItem = (): Electron.MenuItemConstructorOptions[] => {
  const ai = coreStatus?.ai;

  // The servers with a model for some of the background work, their queue on or off
  const servers = ai?.lanes.filter((lane) => lane.takes.length > 0) ?? [];

  if (!servers.length || core.getStatus().state !== 'running') {
    return [];
  }

  return [{
    label: 'Background AI queue',
    submenu: servers.map((lane) => ({
      label: `${lane.name}${lane.reachable === false ? ' (not reached)' : ''}`,
      type: 'checkbox' as const,
      checked: lane.queue,
      click: () => core.invoke('setServerQueue', { server: lane.id, queue: !lane.queue })
        .catch((error: unknown) => console.error(`setServerQueue: ${(error as Error).message}`)),
    })),
  }];
};

// Starting at login is set in the tray, where the app stays. Only a packaged app starts at login: the dev build's
// executable is Electron's own
const startAtLoginItem = (): Electron.MenuItemConstructorOptions => ({
  label: app.isPackaged ? 'Start at login' : 'Start at login (the installed app only)',
  type: 'checkbox',
  checked: Boolean(startAtLogin),
  enabled: app.isPackaged && startAtLogin !== null && core.getStatus().state === 'running',
  click: () => {
    core.invoke('getSettings', {})
      .then((settings) => core.invoke('saveSettings', { ...settings, app: { startAtLogin: !settings.app.startAtLogin } }))
      .then((saved) => applyStartAtLogin(saved.app.startAtLogin))
      .catch((error: unknown) => console.error(`Autostart: ${(error as Error).message}`))
      .finally(() => updateTray());
  },
});

let trayKey = '';

const updateTray = (status: ProcessStatus = core.getStatus()) => {
  if (!tray) {
    return;
  }

  // Built again only when it changes: the core's status comes often
  const key = JSON.stringify([describeProcess(status), coreStatus?.attachments.paused, coreStatus?.ai.lanes.map((lane) => [lane.id, lane.name, lane.queue, lane.takes, lane.reachable]), status.state, startAtLogin]);

  if (key === trayKey) {
    return;
  }

  trayKey = key;
  tray.setToolTip(`Stenograma KB: ${describeProcess(status).toLowerCase()}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Stenograma KB', click: showWindow },
    { type: 'separator' },
    { label: describeProcess(status), enabled: false },
    ...imagesItem(),
    ...backgroundServerItem(),
    { type: 'separator' },
    startAtLoginItem(),
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]));
};

// A notification when a reply draft is ready (F9): how many, never the message, which shows on the screen of a computer
// others may see. A click opens the drafts
let draftsReady: number | null = null;

const notifyDrafts = (status: CoreStatus) => {
  const { ready } = status.drafts;

  if (draftsReady !== null && ready > draftsReady && Notification.isSupported()) {
    const notification = new Notification({
      title: 'Stenograma KB',
      body: ready === 1 ? 'A reply draft is ready to review' : `${ready} reply drafts are ready to review`,
      icon: windowIconPath,
    });
    notification.on('click', () => {
      showWindow();
      sendToRenderer({ type: 'navigate', page: 'drafts' });
    });
    notification.show();
  }

  draftsReady = ready;
};

const core = createCoreSupervisor({
  entry: coreHostPath,
  onEvent: (event) => {
    if (event.type === 'status') {
      notifyDrafts(event.status);
      coreStatus = event.status;
      sendToRenderer({ type: 'status', status: appStatus() });
      updateTray();
    } else {
      sendToRenderer(event);
    }
  },
  onProcessStatus: (status) => {
    // Once per exit: the update that schedules the restart
    if (status.error && status.retryAt) {
      console.error(`core: ${status.error}; starting it again in ${Math.round((status.retryAt - Date.now()) / 1000)} s`);
    }

    // The settings are the core's: the main process imports nothing of it, as the core's process is a bundle of its own
    if (status.state === 'running') {
      core.invoke('getSettings', {})
        .then((settings) => {
          applyStartAtLogin(settings.app.startAtLogin);
          updateTray();
        })
        .catch((error: unknown) => console.error(`Autostart: ${(error as Error).message}`));
    }

    updateTray(status);
    sendToRenderer({ type: 'status', status: appStatus() });
  },
});

const applyStartAtLogin = (enabled: boolean) => {
  startAtLogin = enabled;

  if (app.isPackaged) {
    syncAutostart(enabled, process.env.APPIMAGE ?? process.execPath);
  }
};

function createWindow(show: boolean) {
  // The screen's work area, should the window manager not maximize it
  const { workArea } = screen.getPrimaryDisplay();
  const window = new BrowserWindow({
    ...workArea,
    minWidth: 720,
    minHeight: 480,
    show: false,
    autoHideMenuBar: true,
    icon: windowIconPath,
    backgroundColor: '#202124',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      // The renderer will show emails and messages written by other people, so it gets no Node access
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  mainWindow = window;

  if (show) {
    window.once('ready-to-show', () => {
      shownOnce = true;
      maximizeWhenShown(window);
      window.show();
    });
  }

  // Closing the window keeps the app in the tray, syncing; Quit in the tray's menu stops it
  window.on('close', (event) => {
    if (!quitting) {
      event.preventDefault();
      window.hide();
    }
  });

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
}

// window.kb's calls, checked (app/main/ipc.ts), from the app's own window only
ipcMain.handle('kb:call', async (event, method: unknown, params: unknown) => {
  if (!mainWindow || event.sender !== mainWindow.webContents) {
    throw new Error('Not allowed');
  }

  const call = checkCall(method, params);

  switch (call.method) {
    case 'status':
      return appStatus();
    case 'restartCore':
      core.restartNow();

      return null;
    case 'openInStenograma':
      openExternally(await core.invoke('stenogramaLink', call.params));

      return null;
    case 'openInChat':
      openExternally(await core.invoke('chatLink', call.params));

      return null;
    case 'openDraftInChat':
      openExternally(await core.invoke('draftLink', call.params));

      return null;
    case 'saveSettings': {
      // Starting at login is the tray's: the Settings page's copy may be older than a change there
      const current = await core.invoke('getSettings', {});

      return core.invoke('saveSettings', { ...call.params, app: current.app });
    }
    default:
      return core.invoke(call.method as keyof CoreMethods, call.params as never);
  }
});

// One instance: starting the app again shows the running one's window
if (app.requestSingleInstanceLock()) {
  app.on('second-instance', showWindow);

  // The window only hides, so this comes only when it's gone some other way: the app stays in the tray
  app.on('window-all-closed', () => undefined);

  // The core closes the API and the database and releases the lock before the app exits
  app.on('before-quit', (event) => {
    if (quitting) {
      return;
    }

    quitting = true;
    event.preventDefault();
    core.stop().finally(() => app.quit());
  });

  app.whenReady().then(() => {
    tray = new Tray(nativeImage.createFromPath(trayIconPath));
    tray.on('click', showWindow);
    updateTray(core.getStatus());

    core.start();
    createWindow(!process.argv.includes(HIDDEN_ARG));
  });
} else {
  app.quit();
}
