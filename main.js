const { app, BrowserWindow, WebContentsView, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');

let mainWindow = null;
let accounts = []; // { id, name, view, loaded }
let activeAccountId = null;
let navbarMode = 'sidebar';

const WINDOW_BAR_HEIGHT = 34;
const SIDEBAR_WIDTH = 44;
const DATA_FILE = path.join(app.getPath('userData'), 'tab_sessions.json');
const SETTINGS_FILE = path.join(app.getPath('userData'), 'app_settings.json');
let settingsWindow = null;

function loadSavedSessions() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const data = fs.readFileSync(DATA_FILE, 'utf8');
      return JSON.parse(data); // Returns Array of { id, name }
    }
  } catch (err) {
    console.error('Failed to load session state:', err);
  }
  return [];
}

function saveSessions() {
  try {
    const sessionData = accounts.map(a => ({ id: a.id, name: a.name }));
    fs.writeFileSync(DATA_FILE, JSON.stringify(sessionData, null, 2), 'utf8');
  } catch (err) {
    console.error('Failed to save session state:', err);
  }
}

function loadAppSettings() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const settings = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
      if (settings.navbarMode === 'top' || settings.navbarMode === 'sidebar') {
        navbarMode = settings.navbarMode;
      }
    }
  } catch (err) {
    console.error('Failed to load app settings:', err);
  }
}

function saveAppSettings() {
  try {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify({ navbarMode }, null, 2), 'utf8');
  } catch (err) {
    console.error('Failed to save app settings:', err);
  }
}

function createWindow() {
  loadAppSettings();
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    icon: path.join(__dirname, 'favicon-256.png'),
    backgroundColor: '#22262c',
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#22262c',
      symbolColor: '#dbdee1',
      height: WINDOW_BAR_HEIGHT
    },
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  mainWindow.maximize();
  mainWindow.loadFile('index.html');
  mainWindow.on('resize', updateViewBounds);
  mainWindow.on('move', positionSettingsWindow);
  mainWindow.on('minimize', () => {
    if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.hide();
  });

  mainWindow.webContents.once('did-finish-load', () => {
    const savedTabs = loadSavedSessions();
    
    if (savedTabs.length > 0) {
      savedTabs.forEach(tab => createAccountView(tab.id, tab.name));
      switchTab(savedTabs[0].id);
    } else {
      addAccount('Discord 1');
    }
  });
}

function getCalculatedBounds() {
  if (!mainWindow) return { x: 0, y: WINDOW_BAR_HEIGHT, width: 0, height: 0 };
  const bounds = mainWindow.getContentBounds();
  if (navbarMode === 'sidebar') {
    return {
      x: SIDEBAR_WIDTH,
      y: WINDOW_BAR_HEIGHT,
      width: Math.max(0, bounds.width - SIDEBAR_WIDTH),
      height: Math.max(0, bounds.height - WINDOW_BAR_HEIGHT)
    };
  }
  return {
    x: 0,
    y: WINDOW_BAR_HEIGHT,
    width: Math.max(0, bounds.width),
    height: Math.max(0, bounds.height - WINDOW_BAR_HEIGHT)
  };
}

function openSettingsWindow() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    if (settingsWindow.isVisible()) {
      settingsWindow.hide();
    } else {
      positionSettingsWindow();
      settingsWindow.show();
      settingsWindow.focus();
    }
    return;
  }

  settingsWindow = new BrowserWindow({
    width: 280,
    height: 260,
    parent: mainWindow,
    frame: false,
    resizable: false,
    show: false,
    backgroundColor: '#22262c',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  positionSettingsWindow();
  settingsWindow.loadFile('settings.html');
  settingsWindow.once('ready-to-show', () => {
    settingsWindow.webContents.send('settings-state', { navbarMode });
    settingsWindow.show();
  });
  settingsWindow.on('closed', () => {
    settingsWindow = null;
  });
  settingsWindow.on('blur', () => settingsWindow.close());
}

function positionSettingsWindow() {
  if (!mainWindow || !settingsWindow || settingsWindow.isDestroyed()) return;
  const mainBounds = mainWindow.getBounds();
  const x = navbarMode === 'sidebar' ? mainBounds.x + SIDEBAR_WIDTH + 8 : mainBounds.x + 12;
  const y = mainBounds.y + WINDOW_BAR_HEIGHT + 8;
  settingsWindow.setPosition(x, y);
}

function createAccountView(id, name) {
  const view = new WebContentsView({
    webPreferences: {
      partition: `persist:${id}`, // Securely retains cookies/tokens per account on disk
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: true // Lowers CPU/RAM usage for hidden tabs
    }
  });

  const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
  view.webContents.setUserAgent(userAgent);

  const account = { id, name, view, loaded: false, avatarUrl: null };
  accounts.push(account);

  view.webContents.on('did-finish-load', () => {
    refreshAccountAvatar(account);
    [1500, 4000, 8000].forEach(delay => {
      setTimeout(() => refreshAccountAvatar(account), delay);
    });
  });
}

function refreshAccountAvatar(account) {
  if (!account || account.view.webContents.isDestroyed()) return;

  account.view.webContents.executeJavaScript(`(() => {
    const isDiscordAsset = source => /^https:\/\/(?:cdn|media)\\.discord(?:app)?\\.com\\//i.test(source || '')
      && /(?:avatars|embed|user)/i.test(source || '');
    const imageCandidates = [...document.images]
      .filter(image => image.complete && image.naturalWidth > 0)
      .map(image => ({
        src: image.currentSrc || image.src,
        element: image,
        priority: /avatar|user-avatar|profile/i.test(image.className || '') ? 2 : 1
      }));
    const backgroundCandidates = [...document.querySelectorAll('[style*="background-image"], [class*="avatar"], [class*="Avatar"]')]
      .map(element => ({
        src: getComputedStyle(element).backgroundImage.match(/url\\(["']?([^"')]+)["']?\\)/i)?.[1],
        element,
        priority: 3
      }));
    const candidates = [...imageCandidates, ...backgroundCandidates]
      .filter(candidate => isDiscordAsset(candidate.src))
      .map(candidate => ({ src: candidate.src, priority: candidate.priority, bottom: candidate.element.getBoundingClientRect().bottom }))
      .filter(image => image.bottom > 0)
      .sort((first, second) => second.priority - first.priority || second.bottom - first.bottom);
    return candidates[0]?.src || null;
  })()`, true).then(avatarUrl => {
    if (!avatarUrl || !/^https:\/\/(?:cdn|media)\.discord(?:app)?\.com\//i.test(avatarUrl)) return;
    if (account.avatarUrl !== avatarUrl) {
      account.avatarUrl = avatarUrl;
      notifyUI();
    }
  }).catch(() => {});
}

function addAccount(name) {
  try {
    const id = 'acc_' + Date.now();
    createAccountView(id, name);
    saveSessions();
    switchTab(id);
  } catch (err) {
    if (mainWindow) {
      mainWindow.webContents.send('app-error', 'Error creating tab: ' + err.message);
    }
  }
}

function switchTab(id) {
  try {
    if (activeAccountId) {
      const currentAcc = accounts.find(a => a.id === activeAccountId);
      if (currentAcc && mainWindow.contentView.children.includes(currentAcc.view)) {
        mainWindow.contentView.removeChildView(currentAcc.view);
      }
    }

    const targetAcc = accounts.find(a => a.id === id);
    if (targetAcc) {
      activeAccountId = id;

      targetAcc.view.setBounds(getCalculatedBounds());
      mainWindow.contentView.addChildView(targetAcc.view);

      if (!targetAcc.loaded) {
        targetAcc.view.webContents.loadURL('https://discord.com/app');
        targetAcc.loaded = true;
      }
    }

    notifyUI();
  } catch (err) {
    if (mainWindow) {
      mainWindow.webContents.send('app-error', 'Error switching tabs: ' + err.message);
    }
  }
}

function removeAccount(id) {
  const index = accounts.findIndex(a => a.id === id);
  if (index !== -1) {
    const [removed] = accounts.splice(index, 1);
    
    if (activeAccountId === id) {
      if (mainWindow.contentView.children.includes(removed.view)) {
        mainWindow.contentView.removeChildView(removed.view);
      }
      activeAccountId = null;
    }

    removed.view.webContents.close();
    saveSessions();

    if (accounts.length > 0) {
      switchTab(accounts[0].id);
    } else {
      notifyUI();
    }
  }
}

function renameAccount(id, newName) {
  const targetAcc = accounts.find(a => a.id === id);
  if (targetAcc) {
    targetAcc.name = newName;
    saveSessions();
    notifyUI();
  }
}

function updateViewBounds() {
  if (!activeAccountId || !mainWindow) return;
  const targetAcc = accounts.find(a => a.id === activeAccountId);
  if (targetAcc) {
    targetAcc.view.setBounds(getCalculatedBounds());
  }
}

function notifyUI() {
  if (!mainWindow) return;
  const tabData = accounts.map(a => ({ id: a.id, name: a.name, avatarUrl: a.avatarUrl }));
  mainWindow.webContents.send('render-tabs', { accounts: tabData, activeId: activeAccountId, navbarMode });
}

ipcMain.on('add-tab', () => {
  const nextNum = accounts.length + 1;
  addAccount(`Account ${nextNum}`);
});

ipcMain.on('switch-tab', (e, id) => switchTab(id));
ipcMain.on('remove-tab', (e, id) => removeAccount(id));
ipcMain.on('rename-tab', (e, { id, name }) => renameAccount(id, name));
ipcMain.on('close-all-tabs', () => {
  accounts.forEach(account => {
    if (mainWindow.contentView.children.includes(account.view)) {
      mainWindow.contentView.removeChildView(account.view);
    }
    account.view.webContents.close();
  });
  accounts = [];
  activeAccountId = null;
  saveSessions();
  notifyUI();
});

ipcMain.on('set-navbar-mode', (e, mode) => {
  if (mode !== 'top' && mode !== 'sidebar') return;
  navbarMode = mode;
  saveAppSettings();
  updateViewBounds();
  notifyUI();
});

ipcMain.on('open-settings', openSettingsWindow);
ipcMain.on('close-settings', () => {
  if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.close();
});

ipcMain.on('open-github', () => {
  shell.openExternal('https://github.com/SoulDevOfficial/SwitchCord');
});

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});