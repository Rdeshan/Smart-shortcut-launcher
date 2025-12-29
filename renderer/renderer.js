const fs = require('fs')
const path = require('path')
// const shortcutFile = path.join(__dirname, '../shortcuts.json')
let shortcutFile = null

const comboInput = document.getElementById('combo')
const addBtn = document.getElementById('addBtn')
const updateBtn = document.getElementById('updateBtn')
const cancelEditBtn = document.getElementById('cancelEditBtn')
const editHint = document.getElementById('editHint')
const shortcutList = document.getElementById('shortcutList')
const { ipcRenderer } = require('electron')
const statusEl = document.getElementById('status')
const browseBtn = document.getElementById('browseBtn')
const selectedActionLabel = document.getElementById('selectedActionLabel')

// Add missing state vars
let editIndex = null
let msgTimer = null
let currentAction = ''  // selected action path

function ensureShortcutFile() {
  if (!shortcutFile) return
  try {
    if (!fs.existsSync(shortcutFile)) {
      fs.writeFileSync(shortcutFile, JSON.stringify([], null, 2))
      showMessage('Initialized shortcuts file', 'success')
    } else {
      JSON.parse(fs.readFileSync(shortcutFile, 'utf8'))
    }
  } catch {
    fs.writeFileSync(shortcutFile, JSON.stringify([], null, 2))
    showMessage('Shortcuts file was invalid and reset', 'error')
  }
}

function showMessage(text, type = 'success') {
  if (!statusEl) return
  statusEl.textContent = text
  statusEl.className = `status show ${type}`
  clearTimeout(msgTimer)
  msgTimer = setTimeout(() => {
    statusEl.classList.remove('show')
  }, 2000)
}

function normalizeCombo(str) {
  if (!str) return ''
  const modMap = {
    ctrl: 'Ctrl', control: 'Ctrl',
    cmd: 'Command', command: 'Command',
    cmdorctrl: 'CmdOrCtrl',
    alt: 'Alt', option: 'Alt',
    shift: 'Shift',
    super: 'Super', win: 'Super'
  }
  return str.split('+')
    .map(p => p.trim())
    .filter(Boolean)
    .map(p => {
      const key = p.toLowerCase()
      if (modMap[key]) return modMap[key]
      if (/^f\d{1,2}$/i.test(p)) return p.toUpperCase() // F1..F24
      if (p.length === 1) return p.toUpperCase() // letters/digits
      // common named keys
      const named = {
        enter: 'Enter', return: 'Enter', space: 'Space', tab: 'Tab',
        up: 'Up', down: 'Down', left: 'Left', right: 'Right',
        escape: 'Escape', esc: 'Escape', backspace: 'Backspace', delete: 'Delete',
      }
      return named[key] || (p[0].toUpperCase() + p.slice(1))
    })
    .join('+')
}

// Validate: allow 1 key (modifiers + 1 key) or chord (modifiers + 2 keys: e.g., Alt+V+S)
function validateCombo(str) {
  const norm = normalizeCombo(str)
  const tokens = norm.split('+').filter(Boolean)
  const modifiers = new Set(['Ctrl','Command','CmdOrCtrl','Alt','Shift','Super'])
  const nonMods = tokens.filter(t => !modifiers.has(t))
  const modCount = tokens.length - nonMods.length

  if (tokens.length < 2 || tokens.length > 3) {
    return { valid: false, reason: 'Use 1 or 2 "+" only (e.g., Alt+O, Ctrl+Shift+G, or Alt+V+S).' }
  }
  if (nonMods.length === 1) {
    return { valid: true, norm }
  }
  if (nonMods.length === 2 && modCount >= 1) {
    return { valid: true, norm } // chord supported
  }
  return { valid: false, reason: 'Use modifiers + one or two keys (e.g., Alt+O or Alt+V+S).' }
}

// Browse → select file and set current action
browseBtn?.addEventListener('click', async () => {
  try {
    const selected = await ipcRenderer.invoke('browse-app')
    if (selected) {
      currentAction = selected
      selectedActionLabel.textContent = selected
      selectedActionLabel.style.display = 'inline-block'
      showMessage('File selected', 'success')
    }
  } catch {
    showMessage('Browse failed', 'error')
  }
})

function setModeEditing(index, item) {
  editIndex = index
  comboInput.value = item.combo
  currentAction = item.action
  selectedActionLabel.textContent = currentAction
  selectedActionLabel.style.display = 'inline-block'
  addBtn.disabled = true
  updateBtn.disabled = false
  cancelEditBtn.style.display = 'inline-block'
  editHint.style.display = 'inline'
  editHint.textContent = `Editing "${item.combo}"`
}

function setModeIdle() {
  editIndex = null
  addBtn.disabled = false
  updateBtn.disabled = true
  cancelEditBtn.style.display = 'none'
  editHint.style.display = 'none'
  comboInput.value = ''
  currentAction = ''
  selectedActionLabel.style.display = 'none'
  selectedActionLabel.textContent = ''
}

// Load shortcuts from JSON
function loadShortcuts() {
  ensureShortcutFile()
  shortcutList.innerHTML = ''
  let data = []
  try {
    data = JSON.parse(fs.readFileSync(shortcutFile, 'utf8'))
  } catch {
    data = []
    fs.writeFileSync(shortcutFile, JSON.stringify(data, null, 2))
    showMessage('Failed to read shortcuts. Reset to empty.', 'error')
  }
  data.forEach((item, index) => {
    const li = document.createElement('li')
    li.className = 'list-item'

    const content = document.createElement('div')
    content.className = 'item-content'
    content.innerHTML = `<span class="pill combo">${item.combo}</span><span class="arrow">→</span><span class="pill action">${item.action}</span>`

    const actions = document.createElement('div')
    actions.className = 'item-actions'

    const editBtn = document.createElement('button')
    editBtn.className = 'btn small outline'
    editBtn.textContent = 'Edit'
    editBtn.onclick = () => setModeEditing(index, item)

    const delBtn = document.createElement('button')
    delBtn.className = 'btn small danger'
    delBtn.textContent = 'Delete'
    delBtn.onclick = () => deleteShortcut(index)

    actions.appendChild(editBtn)
    actions.appendChild(delBtn)

    li.appendChild(content)
    li.appendChild(actions)
    shortcutList.appendChild(li)
  })
}

// Add (new only)
addBtn.onclick = () => {
  const combo = comboInput.value.trim()
  if (!combo || !currentAction) return alert('Select a combo and browse an action file')

  const v = validateCombo(combo)
  if (!v.valid) return alert(v.reason)
  const comboNorm = v.norm

  ensureShortcutFile()
  let data = JSON.parse(fs.readFileSync(shortcutFile, 'utf8'))
  if (data.some(s => normalizeCombo(s.combo) === comboNorm)) {
    return alert('Shortcut already exists. Use Edit.')
  }
  data.push({ combo: comboNorm, action: currentAction })

  try {
    fs.writeFileSync(shortcutFile, JSON.stringify(data, null, 2))
    ipcRenderer.send('update-shortcuts', data)
    loadShortcuts()
    setModeIdle()
    showMessage('Shortcut added', 'success')
  } catch {
    showMessage('Failed to add shortcut', 'error')
  }
}

// Update existing
updateBtn.onclick = () => {
  if (editIndex == null) return
  const combo = comboInput.value.trim()
  if (!combo || !currentAction) return alert('Select a combo and browse an action file')

  const v = validateCombo(combo)
  if (!v.valid) return alert(v.reason)
  const comboNorm = v.norm

  ensureShortcutFile()
  let data = JSON.parse(fs.readFileSync(shortcutFile, 'utf8'))
  const dupIdx = data.findIndex((s, i) => i !== editIndex && normalizeCombo(s.combo) === comboNorm)
  if (dupIdx >= 0) return alert('Another shortcut uses this combo.')

  data[editIndex] = { combo: comboNorm, action: currentAction }
  try {
    fs.writeFileSync(shortcutFile, JSON.stringify(data, null, 2))
    ipcRenderer.send('update-shortcuts', data)
    loadShortcuts()
    setModeIdle()
    showMessage('Shortcut updated', 'success')
  } catch {
    showMessage('Failed to update shortcut', 'error')
  }
}

// Cancel edit
cancelEditBtn.onclick = () => setModeIdle()

// Delete shortcut
function deleteShortcut(index) {
  ensureShortcutFile()
  let data = JSON.parse(fs.readFileSync(shortcutFile, 'utf8'))
  data.splice(index, 1)
  try {
    fs.writeFileSync(shortcutFile, JSON.stringify(data, null, 2))
    ipcRenderer.send('update-shortcuts', data)
    loadShortcuts()
    if (editIndex === index) setModeIdle()
    showMessage('Shortcut deleted', 'success')
  } catch {
    showMessage('Failed to delete shortcut', 'error')
  }
}

// Report action errors from main process
ipcRenderer.on('action-error', (_event, payload) => {
  const msg = payload?.action ? `Failed to launch: ${payload.action}` : 'Failed to launch selected app'
  showMessage(msg, 'error')
})

// initial load
;(async function init() {
  try {
    shortcutFile = await ipcRenderer.invoke('get-shortcut-file')
    ensureShortcutFile()
    loadShortcuts()
  } catch {
    showMessage('Failed to init storage', 'error')
  }
})()
