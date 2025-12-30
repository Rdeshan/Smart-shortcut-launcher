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
const addUrlBtn = document.getElementById('addUrlBtn')
const urlModal = document.getElementById('urlModal')
const urlInput = document.getElementById('urlInput')
const confirmUrl = document.getElementById('confirmUrl')
const cancelUrl = document.getElementById('cancelUrl')
const closeModal = document.getElementById('closeModal')
const welcomeCard = document.getElementById('welcomeCard')
const dismissWelcome = document.getElementById('dismissWelcome')
const emptyState = document.getElementById('emptyState')

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

// NEW: Check for chord conflicts - FIXED to check first key only
function checkChordConflict(newCombo, existingShortcuts, editIndex = null) {
  const newTokens = newCombo.split('+').filter(Boolean)
  const modifiers = new Set(['Ctrl','Command','CmdOrCtrl','Alt','Shift','Super'])
  const newMods = newTokens.filter(t => modifiers.has(t))
  const newKeys = newTokens.filter(t => !modifiers.has(t))

  if (newKeys.length === 0) return null

  // Create the "first part" - modifiers + first key
  const newFirstPart = [...newMods, newKeys[0]].join('+')

  for (let i = 0; i < existingShortcuts.length; i++) {
    if (i === editIndex) continue // Skip the shortcut being edited

    const existing = existingShortcuts[i].combo
    const existingTokens = existing.split('+').filter(Boolean)
    const existingMods = existingTokens.filter(t => modifiers.has(t))
    const existingKeys = existingTokens.filter(t => !modifiers.has(t))

    if (existingKeys.length === 0) continue

    const existingFirstPart = [...existingMods, existingKeys[0]].join('+')

    // Check if first parts match (Alt+C matches Alt+C)
    if (existingFirstPart === newFirstPart) {
      // Conflict if: one is single key and other is chord, OR both are chords with different second keys
      const newIsSingle = newKeys.length === 0
      const existingIsSingle = existingKeys.length === 1
      
      if (newIsSingle && !existingIsSingle) {
        // New is Alt+C, existing is Alt+C+E
        return {
          conflict: true,
          existing: existingShortcuts[i],
          firstPart: newFirstPart
        }
      } else if (!newIsSingle && existingIsSingle) {
        // New is Alt+C+E, existing is Alt+C
        return {
          conflict: true,
          existing: existingShortcuts[i],
          firstPart: newFirstPart
        }
      } else if (!newIsSingle && !existingIsSingle) {
        // Both are chords (Alt+C+E vs Alt+C+X)
        if (newKeys[1] !== existingKeys[1]) {
          return {
            conflict: true,
            existing: existingShortcuts[i],
            firstPart: newFirstPart
          }
        }
      }
    }
  }

  return null
}

// Browse → select file and set current action
browseBtn?.addEventListener('click', async () => {
  try {
    const selected = await ipcRenderer.invoke('browse-app')
    if (selected) {
      currentAction = selected
      selectedActionLabel.textContent = getActionDisplayName(selected)
      selectedActionLabel.style.display = 'inline-block'
      showMessage('File selected', 'success')
    }
  } catch {
    showMessage('Browse failed', 'error')
  }
})

// NEW: Add URL/Command button
addUrlBtn?.addEventListener('click', () => {
  urlModal.style.display = 'flex'
  urlInput.value = ''
  urlInput.focus()
})

// NEW: Close modal handlers
const closeUrlModal = () => {
  urlModal.style.display = 'none'
  urlInput.value = ''
}

closeModal?.addEventListener('click', closeUrlModal)
cancelUrl?.addEventListener('click', closeUrlModal)

// Close modal when clicking outside
urlModal?.addEventListener('click', (e) => {
  if (e.target === urlModal) closeUrlModal()
})

// Close modal on Escape key
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && urlModal.style.display === 'flex') {
    closeUrlModal()
  }
})

// NEW: Confirm URL/Command
confirmUrl?.addEventListener('click', () => {
  const value = urlInput.value.trim()
  if (!value) {
    alert('Please enter a URL or command')
    return
  }

  currentAction = value
  selectedActionLabel.textContent = getActionDisplayName(value)
  selectedActionLabel.style.display = 'inline-block'
  closeUrlModal()
  showMessage('URL/Command added', 'success')
})

// NEW: Enter key in URL input
urlInput?.addEventListener('keypress', (e) => {
  if (e.key === 'Enter') {
    confirmUrl.click()
  }
})

// NEW: Quick link buttons
document.querySelectorAll('.btn-quick').forEach(btn => {
  btn.addEventListener('click', () => {
    const url = btn.dataset.url
    urlInput.value = url
    confirmUrl.click()
  })
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

  // NEW: Show welcome card on first launch
  const hasSeenWelcome = localStorage.getItem('hasSeenWelcome')
  if (!hasSeenWelcome && data.length === 0) {
    welcomeCard.style.display = 'block'
  }

  // NEW: Show empty state if no shortcuts
  if (data.length === 0) {
    emptyState.style.display = 'flex'
    return
  } else {
    emptyState.style.display = 'none'
  }

  data.forEach((item, index) => {
    const li = document.createElement('li')
    li.className = 'list-item'

    const displayName = getActionDisplayName(item.action)

    li.innerHTML = `
      <div class="item-content">
        <span class="pill combo">${item.combo}</span>
        <span class="arrow">→</span>
        <span class="pill action" title="${typeof item.action === 'object' ? JSON.stringify(item.action) : item.action}">${displayName}</span>
      </div>
      <div class="item-actions">
        <button class="btn outline small edit-btn" data-index="${index}">Edit</button>
        <button class="btn danger small delete-btn" data-index="${index}">Delete</button>
      </div>
    `
    shortcutList.appendChild(li)
  })

  // Attach event listeners
  document.querySelectorAll('.edit-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const idx = parseInt(e.target.dataset.index)
      setModeEditing(idx, data[idx])
    })
  })

  document.querySelectorAll('.delete-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const idx = parseInt(e.target.dataset.index)
      deleteShortcut(idx)
    })
  })
}

// Extract a friendly display name from action
function getActionDisplayName(action) {
  if (!action) return 'Unknown'
  
  // Handle string actions (legacy or simple)
  if (typeof action === 'string') {
    // Check if it's a URL
    if (/^https?:\/\//i.test(action)) {
      try {
        const url = new URL(action)
        return url.hostname.replace(/^www\./, '')
      } catch {
        return action
      }
    }
    // Extract filename from path
    if (action.includes('\\') || action.includes('/')) {
      return path.basename(action, path.extname(action))
    }
    return action
  }

  // Handle object actions with different fields
  const value = action.value || action.target || action.action || action.alias || action.url || action.shell || action.protocol || action.path

  if (!value) return 'Unknown'

  const kind = (action.kind || action.type || '').toLowerCase()

  // Handle URLs
  if (kind === 'url' || /^https?:\/\//i.test(value)) {
    try {
      const url = new URL(value)
      return url.hostname.replace(/^www\./, '')
    } catch {
      return value
    }
  }

  // Handle shell commands and protocols
  if (kind === 'shell' || kind === 'protocol') {
    if (value.includes('WhatsApp')) return 'WhatsApp'
    if (value.includes('ms-settings')) return 'Settings'
    return value
  }

  // Handle aliases
  if (kind === 'alias') {
    return value.charAt(0).toUpperCase() + value.slice(1)
  }

  // Handle paths - extract just the filename
  if (kind === 'path' || value.includes('\\') || value.includes('/')) {
    return path.basename(value, path.extname(value))
  }

  return value
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

  // NEW: Check for chord conflicts
  const conflict = checkChordConflict(comboNorm, data)
  if (conflict) {
    return alert(conflict.message)
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

  // NEW: Check for chord conflicts
  const conflict = checkChordConflict(comboNorm, data, editIndex)
  if (conflict) {
    return alert(conflict.message)
  }

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

// NEW: Dismiss welcome card
dismissWelcome?.addEventListener('click', () => {
  welcomeCard.style.display = 'none'
  localStorage.setItem('hasSeenWelcome', 'true')
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

// NEW: List of commonly blocked shortcuts by Windows/IDEs
const BLOCKED_SHORTCUTS = new Set([
  'Ctrl+C', 'Ctrl+V', 'Ctrl+X', 'Ctrl+A', 'Ctrl+Z', 'Ctrl+Y', // System clipboard
  'Ctrl+S', 'Ctrl+O', 'Ctrl+N', 'Ctrl+W', 'Ctrl+T', 'Ctrl+P', // File operations
  'Alt+Tab', 'Alt+F4', 'Ctrl+Alt+Delete', 'Ctrl+Shift+Esc', // System shortcuts
  'Ctrl+Esc', 'Win+L', 'Win+D', 'Win+E', // Windows shortcuts
])

const IDE_SHORTCUTS = {
  'vscode': new Set(['Ctrl+K', 'Ctrl+P', 'Ctrl+Shift+P', 'Ctrl+B', 'Ctrl+`', 'Ctrl+J']),
  'intellij': new Set(['Ctrl+Shift+A', 'Ctrl+Shift+F', 'Ctrl+Shift+N', 'Ctrl+F12']),
  'visualstudio': new Set(['Ctrl+K', 'Ctrl+M', 'Ctrl+R', 'Ctrl+Shift+B']),
  'eclipse': new Set(['Ctrl+Shift+R', 'Ctrl+Shift+T', 'Ctrl+3']),
}

// NEW: Check if shortcut is blocked by system or IDE
function checkBlockedShortcut(combo) {
  const norm = normalizeCombo(combo)
  
  // Check system-blocked shortcuts
  if (BLOCKED_SHORTCUTS.has(norm)) {
    return {
      blocked: true,
      reason: 'system',
      message: `${norm} is reserved by Windows and cannot be overridden globally.`
    }
  }
  
  // Check IDE shortcuts
  for (const [ide, shortcuts] of Object.entries(IDE_SHORTCUTS)) {
    if (shortcuts.has(norm)) {
      return {
        blocked: true,
        reason: 'ide',
        ide: ide,
        message: `${norm} is commonly used by ${ide.toUpperCase()} and may not work globally when the IDE is active.`
      }
    }
  }
  
  return null
}

// NEW: Real-time chord conflict check as user types
comboInput?.addEventListener('input', (e) => {
  const value = e.target.value.trim()
  
  // Remove any existing warning
  const existingWarning = document.querySelector('.chord-warning')
  if (existingWarning) existingWarning.remove()
  
  if (!value) {
    // Re-enable buttons when input is cleared
    if (editIndex === null && currentAction) {
      addBtn.disabled = false
    } else if (editIndex !== null && currentAction) {
      updateBtn.disabled = false
    }
    return
  }

  // Normalize and check
  try {
    const norm = normalizeCombo(value)
    const tokens = norm.split('+').filter(Boolean)
    const modifiers = new Set(['Ctrl','Command','CmdOrCtrl','Alt','Shift','Super'])
    const mods = tokens.filter(t => modifiers.has(t))
    const keys = tokens.filter(t => !modifiers.has(t))

    // NEW: Check for blocked shortcuts first
    const blocked = checkBlockedShortcut(norm)
    if (blocked) {
      const warning = document.createElement('div')
      warning.className = 'chord-warning'
      
      let warningContent = ''
      if (blocked.reason === 'system') {
        warningContent = `
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10"></circle>
            <line x1="15" y1="9" x2="9" y2="15"></line>
            <line x1="9" y1="9" x2="15" y2="15"></line>
          </svg>
          <div class="chord-warning-content">
            <strong>🚫 System-Reserved Shortcut</strong>
            <p>${blocked.message}</p>
            <p class="suggestion">💡 Try using Alt or Ctrl+Alt combinations instead (e.g., Alt+${keys[0] || 'G'} or Ctrl+Alt+${keys[0] || 'G'})</p>
          </div>
        `
      } else {
        warningContent = `
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"></path>
            <line x1="12" y1="9" x2="12" y2="13"></line>
            <line x1="12" y1="17" x2="12.01" y2="17"></line>
          </svg>
          <div class="chord-warning-content">
            <strong>⚠️ IDE Conflict Warning</strong>
            <p>${blocked.message}</p>
            <p class="suggestion">💡 Consider using Alt+${keys[0] || 'G'} or Ctrl+Shift+${keys[0] || 'G'} instead</p>
          </div>
        `
      }
      
      warning.innerHTML = warningContent
      comboInput.parentElement.insertAdjacentElement('afterend', warning)
      
      // Disable buttons for system-reserved, warn for IDE
      if (blocked.reason === 'system') {
        addBtn.disabled = true
        if (editIndex !== null) updateBtn.disabled = true
      }
      
      return
    }

    // Check for any combo (single key OR chord) with at least one modifier
    if (keys.length >= 1 && mods.length >= 1) {
      ensureShortcutFile()
      const data = JSON.parse(fs.readFileSync(shortcutFile, 'utf8'))
      const conflict = checkChordConflict(norm, data, editIndex)
      
      if (conflict) {
        // Show inline warning popup
        const warning = document.createElement('div')
        warning.className = 'chord-warning'
        
        const existingCombo = conflict.existing.combo
        const existingName = getActionDisplayName(conflict.existing.action)
        
        warning.innerHTML = `
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"></path>
            <line x1="12" y1="9" x2="12" y2="13"></line>
            <line x1="12" y1="17" x2="12.01" y2="17"></line>
          </svg>
          <div class="chord-warning-content">
            <strong>⚠️ Shortcut Conflict!</strong>
            <p>You already have <code>${existingCombo}</code> for <strong>${existingName}</strong></p>
            <p>Both use <code>${conflict.firstPart}</code> as the starting keys - only one will work!</p>
            <p class="suggestion">💡 Try: ${generateAlternative(norm, data)}</p>
          </div>
        `
        
        // Insert warning after the combo input
        comboInput.parentElement.insertAdjacentElement('afterend', warning)
        
        // Disable add/update buttons
        addBtn.disabled = true
        if (editIndex !== null) updateBtn.disabled = true
      } else {
        // Re-enable buttons if no conflict and action is selected
        if (editIndex === null && currentAction) {
          addBtn.disabled = false
        } else if (editIndex !== null && currentAction) {
          updateBtn.disabled = false
        }
      }
    }
  } catch (err) {
    console.error('Validation error:', err)
  }
})

// NEW: Generate alternative shortcut suggestions
function generateAlternative(currentCombo, existingShortcuts) {
  const tokens = currentCombo.split('+').filter(Boolean)
  const modifiers = new Set(['Ctrl','Command','CmdOrCtrl','Alt','Shift','Super'])
  const mods = tokens.filter(t => modifiers.has(t))
  const keys = tokens.filter(t => !modifiers.has(t))
  
  if (keys.length === 0) return currentCombo
  
  const alternatives = []
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')
  
  // If it's a chord, suggest using different first key
  if (keys.length === 2) {
    for (const letter of alphabet) {
      if (letter === keys[0]) continue
      const alternative = [...mods, letter, keys[1]].join('+')
      const conflict = checkChordConflict(alternative, existingShortcuts, null)
      if (!conflict) {
        alternatives.push(alternative)
        if (alternatives.length >= 3) break
      }
    }
  } else {
    // If it's a single key, suggest adding a second key
    for (const letter of alphabet) {
      const alternative = [...mods, keys[0], letter].join('+')
      const conflict = checkChordConflict(alternative, existingShortcuts, null)
      if (!conflict) {
        alternatives.push(alternative)
        if (alternatives.length >= 3) break
      }
    }
  }
  
  return alternatives.length > 0 
    ? alternatives.join(' <span style="color:#64748b">or</span> ') 
    : 'use a different key combination'
}
