const { app, BrowserWindow, globalShortcut, Tray, Menu, ipcMain, dialog, nativeImage, shell } = require('electron')
const path = require('path')
const fs = require('fs')
const { spawn } = require('child_process')
const { autoUpdater } = require('electron-updater')

let mainWindow, tray
let isQuitting = false

// Single instance
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) mainWindow.show()
  })
}

// Alias commands for quick launch
const aliasMap = {
  notepad: 'notepad',
  // open Google directly in the default browser
  google: 'https://www.google.com',
  whatsapp: 'shell:AppsFolder\\5319275A.WhatsAppDesktop_cv1g1gvanyjgm!App',
  word: 'winword',
  // NEW: Windows Settings
  settings: 'ms-settings:',
  // NEW: convenience alias to launch Chrome if available in PATH
  chrome: 'chrome'
}
// NEW: built-in shortcuts (skip if user defines same combo)
const BUILT_IN_SHORTCUTS = [
  { combo: 'Ctrl+Alt+W', action: { alias: 'whatsapp' } },
  { combo: 'Ctrl+Alt+G', action: { alias: 'google' } }
]

// Ensure cache/userData are writable to fix "Unable to create cache"
const appDataRoot = process.env.APPDATA || path.join(process.env.USERPROFILE || process.env.HOME || '', 'AppData', 'Roaming')
const USER_DATA_DIR = path.join(appDataRoot, 'Shortcut Launcher')
const CACHE_DIR = path.join(USER_DATA_DIR, 'Cache')
try {
  fs.mkdirSync(USER_DATA_DIR, { recursive: true })
  fs.mkdirSync(CACHE_DIR, { recursive: true })
} catch {}
app.setPath('userData', USER_DATA_DIR)
app.setPath('cache', CACHE_DIR)
// Direct Chromium to our cache dir and disable shader disk cache
app.commandLine.appendSwitch('disk-cache-dir', CACHE_DIR)
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache')

// Catch unhandled promise rejections to avoid noisy warnings
process.on('unhandledRejection', (reason) => {
  console.error('UnhandledRejection:', reason)
})

// ----------------- Create Dashboard Window -----------------
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 800,
    height: 800,
    show: false, // keep false to avoid white flash
    resizable: false,
    webPreferences: { 
      nodeIntegration: true,
      contextIsolation: false,
      partition: 'persist:shortcut-launcher' // isolated session/cache
    }
  })
  // NEW: ensure it appears on taskbar and shows when ready
  try { mainWindow.setSkipTaskbar(false) } catch {}
  mainWindow.once('ready-to-show', () => {
    try { mainWindow.show(); mainWindow.focus() } catch {}
  })

  mainWindow.loadFile(path.join(__dirname, 'renderer/index.html'))
  mainWindow.on('close', (e) => { 
    if (!isQuitting) {
      e.preventDefault(); 
      mainWindow.hide() 
    }
  })
}

// ----------------- Launch Apps Safely -----------------
function runAction(action) {
  try {
    // NEW: support structured action with { kind, value } and simple fields
    let target
    let forceKind

    if (action && typeof action === 'object') {
      // NEW: accept simple fields so users don't need to browse executables
      const simple =
        ('alias' in action) ? { kind: 'alias', value: action.alias } :
        ('url' in action) ? { kind: 'url', value: action.url } :
        ('shell' in action) ? { kind: 'shell', value: action.shell } :
        ('protocol' in action) ? { kind: 'protocol', value: action.protocol } :
        ('path' in action) ? { kind: 'path', value: action.path } : null

      const kind = String((simple?.kind ?? action.kind ?? action.type) || '').toLowerCase()
      const value = (simple?.value ?? action.value ?? action.target ?? action.action)

      if (kind === 'alias') {
        const alias = aliasMap[String(value).toLowerCase()]
        target = alias || String(value)
      } else {
        target = String(value)
        forceKind = kind // 'url' | 'shell' | 'protocol' | 'path'
      }
    } else {
      const alias = typeof action === 'string' ? aliasMap[action.toLowerCase()] : undefined
      target = alias || action
    }

    const isUrl = forceKind === 'url' || (typeof target === 'string' && /^https?:\/\//i.test(target))
    const isShell = forceKind === 'shell' || (typeof target === 'string' && /^shell:/i.test(target))
    const isProtocol = forceKind === 'protocol' ||
      (typeof target === 'string' &&
       /^[a-zA-Z][\w+.-]*:/.test(target) &&
       !/^[a-zA-Z]:[\\/]/.test(target))
    const looksPath = forceKind === 'path' || (typeof target === 'string' && /[\\\/]/.test(target))
    const exists = looksPath ? fs.existsSync(target) : false
    const ext = exists ? path.extname(target).toLowerCase() : ''

    const launchWithCmd = (arg, quote = true) => {
      const t = quote ? `"${arg}"` : arg
      const child = spawn('cmd.exe', ['/c', 'start', '""', t], {
        windowsVerbatimArguments: true,
        detached: true,
        stdio: 'ignore'
      })
      child.on('error', (err) => {
        console.error('Launch error:', arg, err)
        if (mainWindow) mainWindow.webContents.send('action-error', { action: arg, error: err.message })
      })
      try { child.unref() } catch {}
    }

    if (isUrl) { launchWithCmd(target, true); return }
    if (isShell || isProtocol) { launchWithCmd(target, false); return }
    if (exists) {
      switch (ext) {
        case '.exe': case '.lnk': case '.url': case '.appref-ms': case '.bat': case '.cmd':
          launchWithCmd(target, true); return
        case '.ps1': {
          const ps = spawn('powershell.exe', [
            '-NoProfile', '-ExecutionPolicy', 'Bypass',
            '-Command', `Start-Process -FilePath '${String(target).replace(/'/g, "''")}'`
          ], { detached: true, stdio: 'ignore' })
          ps.on('error', (err) => {
            console.error('PowerShell launch error:', target, err)
            if (mainWindow) mainWindow.webContents.send('action-error', { action: target, error: err.message })
          })
          try { ps.unref() } catch {}
          return
        }
        default: launchWithCmd(target, true); return
      }
    }

    if (looksPath) { launchWithCmd(target, true); return }
    launchWithCmd(String(target), false)
  } catch (e) {
    console.error('runAction error:', e)
    if (mainWindow) mainWindow.webContents.send('action-error', { action, error: e.message })
  }
}

// ----------------- Shortcut Parsing & Chords -----------------
const MODIFIERS = new Set(['Ctrl','Command','CmdOrCtrl','Alt','Shift','Super'])

function parseAccelerator(acc) {
  const tokens = acc.split('+').filter(Boolean)
  const mods = tokens.filter(t => MODIFIERS.has(t))
  const keys = tokens.filter(t => !MODIFIERS.has(t))
  return { mods, keys }
}

function makeAccel(mods, key) {
  return mods.length ? `${mods.join('+')}+${key}` : key
}

const activeChords = new Map()
function startChord(acc2, action) {
  try { globalShortcut.unregister(acc2) } catch {}
  const ok2 = globalShortcut.register(acc2, () => {
    runAction(action)
    endChord(acc2)
  })
  if (!ok2) { console.warn('Chord second-stage failed:', acc2, '→', action); return }
  const timer = setTimeout(() => endChord(acc2), 1000)
  activeChords.set(acc2, timer)
}

function endChord(acc2) {
  try { globalShortcut.unregister(acc2) } catch {}
  const t = activeChords.get(acc2)
  if (t) clearTimeout(t)
  activeChords.delete(acc2)
}

function registerShortcuts(shortcuts) {
  globalShortcut.unregisterAll()
  const failures = []
  shortcuts.forEach(s => {
    const { mods, keys } = parseAccelerator(s.combo)
    if (keys.length === 1) {
      try {
        const ok = globalShortcut.register(s.combo, () => runAction(s.action))
        if (!ok) failures.push({ combo: s.combo, action: s.action })
      } catch (e) { failures.push({ combo: s.combo, action: s.action }) }
    } else if (keys.length === 2 && mods.length >= 1) {
      const acc1 = makeAccel(mods, keys[0])
      const acc2 = makeAccel(mods, keys[1])
      try {
        const ok1 = globalShortcut.register(acc1, () => startChord(acc2, s.action))
        if (!ok1) failures.push({ combo: s.combo, action: s.action })
      } catch (e) { failures.push({ combo: s.combo, action: s.action }) }
    } else { failures.push({ combo: s.combo, action: s.action }) }
  })
  if (failures.length && mainWindow) mainWindow.webContents.send('shortcut-registration-errors', failures)
}

// NEW: register built-in shortcuts unless user overrides the same combo
function registerBuiltInShortcuts(userShortcuts = []) {
  const userCombos = new Set((userShortcuts || []).map(s => String(s.combo)))
  const failures = []
  BUILT_IN_SHORTCUTS.forEach(bs => {
    if (userCombos.has(bs.combo)) return
    try {
      const ok = globalShortcut.register(bs.combo, () => runAction(bs.action))
      if (!ok) failures.push({ combo: bs.combo, action: bs.action })
    } catch (e) {
      failures.push({ combo: bs.combo, action: bs.action })
    }
  })
  if (failures.length && mainWindow) mainWindow.webContents.send('shortcut-registration-errors', failures)
}

// NEW: apply both user and built-in shortcuts
function applyShortcuts(shortcuts) {
  registerShortcuts(shortcuts)
  registerBuiltInShortcuts(shortcuts)
}

// ----------------- IPC -----------------
ipcMain.on('update-shortcuts', (_event, shortcuts) => applyShortcuts(shortcuts))
ipcMain.handle('get-shortcut-file', async () => getShortcutPath())
// NEW: optional alias listing for UI convenience
ipcMain.handle('get-aliases', async () => Object.keys(aliasMap))
// NEW: open shortcuts.json from renderer if needed
ipcMain.handle('open-shortcuts-editor', async () => { openShortcutEditor(); return true })

// ----------------- Start Menu App Indexing -----------------
// Re-added to fix "scanStartMenu is not defined"
let appIndex = []
let lastScan = 0
const START_MENU_DIRS = [
  path.join(process.env.ProgramData || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
  path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs')
]
const ALLOWED_EXT = new Set(['.lnk', '.url', '.appref-ms'])

function safeStat(p) { try { return fs.statSync(p) } catch { return null } }
function walk(dir, out) {
  const st = safeStat(dir)
  if (!st || !st.isDirectory()) return
  let entries = []
  try { entries = fs.readdirSync(dir) } catch { return }
  entries.forEach(name => {
    const full = path.join(dir, name)
    const s = safeStat(full)
    if (!s) return
    if (s.isDirectory()) walk(full, out)
    else if (ALLOWED_EXT.has(path.extname(name).toLowerCase())) {
      out.push({ name: path.basename(name, path.extname(name)), path: full })
    }
  })
}

function scanStartMenu() {
  const out = []
  START_MENU_DIRS.forEach(d => walk(d, out))
  appIndex = out
  lastScan = Date.now()
}

ipcMain.handle('search-apps', async (_evt, query) => {
  if (!lastScan || Date.now() - lastScan > 5 * 60 * 1000) scanStartMenu()
  const q = (query || '').toLowerCase()
  return appIndex.filter(it => it.name.toLowerCase().includes(q)).slice(0, 15)
})

ipcMain.handle('browse-app', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [
      { name: 'Executables and Shortcuts', extensions: ['exe', 'bat', 'cmd', 'lnk', 'appref-ms', 'url'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  })
  if (res.canceled || !res.filePaths?.length) return null
  return res.filePaths[0]
})

// ----------------- Shortcut JSON File -----------------
function getShortcutPath() {
  return path.join(app.getPath('userData'), 'shortcuts.json')
}

function ensureShortcutStoreFile() {
  try {
    const p = getShortcutPath()
    if (!fs.existsSync(p)) {
      // Seed with examples so you can see and use the new "kind" field
      const sample = [
        { combo: 'Ctrl+G', action: { kind: 'url', value: 'https://google.com' } },
        { combo: 'Ctrl+W', action: { kind: 'alias', value: 'whatsapp' } },
        { combo: 'Ctrl+N', action: 'notepad' } // backwards compatible string
      ]
      fs.writeFileSync(p, JSON.stringify(sample, null, 2))
    } else {
      const raw = fs.readFileSync(p, 'utf8')
      if (raw.trim().length === 0) fs.writeFileSync(p, JSON.stringify([], null, 2))
      else JSON.parse(raw)
    }
  } catch { fs.writeFileSync(getShortcutPath(), JSON.stringify([], null, 2)) }
}

// Open shortcuts.json in the default editor
function openShortcutEditor() {
  const p = getShortcutPath()
  try { fs.mkdirSync(path.dirname(p), { recursive: true }) } catch {}
  shell.openPath(p)
}

// Reload shortcuts when the file changes
function watchShortcutFile() {
  const p = getShortcutPath()
  try {
    fs.watch(p, { persistent: true }, () => {
      try {
        const shortcuts = JSON.parse(fs.readFileSync(p, 'utf8'))
        applyShortcuts(shortcuts) // CHANGED: include built-ins
        if (mainWindow) mainWindow.webContents.send('shortcut-registration-success', { count: shortcuts.length })
      } catch (e) {
        if (mainWindow) mainWindow.webContents.send('shortcut-registration-errors', [{ combo: 'file parse', action: 'N/A', error: e.message }])
      }
    })
  } catch {}
}

// ----------------- About Dialog -----------------
// Show a simple About dialog with version info
function showAbout() {
  const msg = `Shortcut Launcher\nVersion: ${app.getVersion()}\n\n© YOUR_COMPANY`
  try {
    dialog.showMessageBox(mainWindow || null, {
      type: 'info',
      title: 'About Shortcut Launcher',
      message: msg
    })
  } catch {}
}

// ----------------- App Ready -----------------
app.whenReady().then(() => {
  createWindow()
  // NEW: fallback – if ready-to-show didn’t fire (renderer error), show anyway
  setTimeout(() => {
    try {
      if (mainWindow && !mainWindow.isVisible()) { mainWindow.show(); mainWindow.focus() }
    } catch {}
  }, 3000)

  // ===== TRAY =====
  const iconPath = path.join(__dirname, 'assets', 'icon.ico') // use a .png on mac/linux if available
  const trayIcon = nativeImage.createFromPath(iconPath)
  tray = new Tray(trayIcon)
  tray.setToolTip('Shortcut Launcher')
  const trayMenu = Menu.buildFromTemplate([
    { label: 'Open', click: () => mainWindow.show() },
    // Add manual update and about entries
    { label: 'Check for Updates', click: () => {
        try {
          if (app.isPackaged) {
            autoUpdater.checkForUpdatesAndNotify()
          } else {
            dialog.showMessageBox(mainWindow || null, { type: 'info', message: 'Updates run in packaged builds.' })
          }
        } catch {}
      }
    },
    { label: 'About', click: () => showAbout() },
    { type: 'separator' },
    { label: 'Edit Shortcuts...', click: () => openShortcutEditor() },
    { type: 'separator' },
    { label: 'Exit', click: () => { isQuitting = true; app.quit() } }
  ])
  tray.setContextMenu(trayMenu)

  // toggle dashboard on tray click
  tray.on('click', () => {
    if (mainWindow.isVisible()) mainWindow.hide()
    else { mainWindow.show(); mainWindow.focus() }
  })

  // ===== SHORTCUTS =====
  ensureShortcutStoreFile()
  const shortcuts = JSON.parse(fs.readFileSync(getShortcutPath(), 'utf8'))
  applyShortcuts(shortcuts) // CHANGED: include built-ins
  watchShortcutFile() // NEW: auto-reload on save

  // ===== START MENU INDEX =====
  scanStartMenu()

  // ===== AUTO START =====
  app.setLoginItemSettings({ openAtLogin: true, path: app.getPath('exe'), args: [] })

  // ===== AUTO UPDATES =====
  // NEW: only run auto-updater in packaged builds to avoid dev-time errors
  if (app.isPackaged) {
    autoUpdater.autoDownload = true
    autoUpdater.checkForUpdatesAndNotify()

    autoUpdater.on('update-available', () => {
      if (mainWindow) mainWindow.webContents.send('update-status', 'update-available')
    })
    autoUpdater.on('update-downloaded', () => {
      if (mainWindow) mainWindow.webContents.send('update-status', 'update-downloaded')
      autoUpdater.quitAndInstall()
    })
    autoUpdater.on('error', (err) => {
      if (mainWindow) mainWindow.webContents.send('update-status', `error: ${err.message}`)
    })
  }
})

// ----------------- Cleanup -----------------
app.on('will-quit', () => globalShortcut.unregisterAll())
