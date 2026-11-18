// Page behaviour: host memory, copy keys, and the capture's run selector and inspector.
// No network, no dependency. Every page reads completely without this file.

// Host switcher: remember the choice locally; #host-<id> selects a tab.
const HOST_KEY = 'deliberation-host'
const pickHost = (id) => {
  for (const input of document.querySelectorAll('.hosts input')) if (input.value === id) input.checked = true
}
const fromHash = (location.hash.match(/^#host-([a-z-]+)$/) || [])[1]
let saved = null
try {
  saved = localStorage.getItem(HOST_KEY)
} catch {
  // storage blocked: the tabs still work
}
if (fromHash || saved) pickHost(fromHash || saved)
document.addEventListener('change', (e) => {
  if (!e.target.closest('.hosts')) return
  pickHost(e.target.value)
  try {
    localStorage.setItem(HOST_KEY, e.target.value)
  } catch {
    // same
  }
})

document.addEventListener('click', (e) => {
  const key = e.target.closest('[data-copy]')
  if (!key) return
  const text = key.parentNode.querySelector('code').textContent
  const done = (word) => {
    const was = key.textContent
    key.textContent = word
    setTimeout(() => (key.textContent = was), 1600)
  }
  if (!navigator.clipboard) return done('Select and copy')
  navigator.clipboard.writeText(text).then(
    () => done('Copied'),
    () => done('Select and copy'),
  )
})

// Capture: one run shown at a time, one inspector panel open at a time. The page ships
// the first run; any other is a same-origin HTML fragment fetched when it is picked.
for (const capture of document.querySelectorAll('[data-capture]')) {
  const status = capture.querySelector('.cap-status')
  let openers = []
  const arm = () => {
    openers = [...capture.querySelectorAll('[data-panel]')]
    for (const b of openers) b.disabled = false
  }
  arm()
  let opener = null
  const boxOf = (id) => [...capture.querySelectorAll('[data-run]')].find((box) => box.dataset.run === id)
  const say = (text, link) => {
    status.textContent = text
    if (link) status.append(' ', Object.assign(document.createElement('a'), { href: link, textContent: 'Read it on the sample runs page' }))
    status.hidden = !text
  }
  const show = (id) => {
    for (const box of capture.querySelectorAll('[data-run]')) box.hidden = box.dataset.run !== id
  }
  const pick = async (input) => {
    const id = input.value
    say('')
    if (boxOf(id)) return show(id)
    say('Loading the recorded run.')
    try {
      const res = await fetch(input.dataset.src)
      if (!res.ok) throw new Error(String(res.status))
      const html = await res.text()
      // A slow answer must not replace the run picked after it, or add a run twice.
      if (!boxOf(id)) capture.insertAdjacentHTML('beforeend', html)
      if (!boxOf(id)) throw new Error('no run in the file')
      boxOf(id).hidden = true
      arm()
      if (!input.checked) return
      say('')
      show(id)
    } catch {
      if (input.checked) say('This run could not be loaded.', input.dataset.more)
    }
  }

  const close = (refocus) => {
    for (const insp of capture.querySelectorAll('.insp')) insp.hidden = true
    for (const b of openers) b.setAttribute('aria-expanded', 'false')
    if (refocus && opener) opener.focus()
    opener = null
  }

  const open = (button) => {
    const id = button.dataset.panel
    const panel = document.getElementById(id)
    if (!panel) return
    const insp = panel.closest('.insp')
    for (const p of insp.querySelectorAll('.insp-panel')) p.hidden = p !== panel
    for (const b of openers) b.setAttribute('aria-expanded', String(b.dataset.panel === id))
    insp.hidden = false
    opener = button
    capture.dataset.used = '' // the hint pulse has done its job
    insp.focus({ preventScroll: true })
    insp.scrollIntoView({ block: 'nearest' })
  }

  capture.addEventListener('click', (e) => {
    const button = e.target.closest('[data-panel]')
    if (button) return button.getAttribute('aria-expanded') === 'true' ? close(true) : open(button)
    if (e.target.closest('[data-close]')) close(true)
  })
  capture.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && opener) close(true)
  })
  capture.addEventListener('change', (e) => {
    if (e.target.name !== 'run') return
    close(false)
    pick(e.target)
  })
}

// Top bar menus: a button opens a list of links. Escape closes it and returns focus,
// a click or focus outside closes it, and the arrow keys walk the list.
const menus = [...document.querySelectorAll('.nav .menu')]
const shut = (menu, refocus) => {
  const button = menu.querySelector('button')
  if (button.getAttribute('aria-expanded') !== 'true') return
  button.setAttribute('aria-expanded', 'false')
  menu.querySelector('.menu-list').hidden = true
  if (refocus) button.focus()
}
for (const menu of menus) {
  const button = menu.querySelector('button')
  const list = menu.querySelector('.menu-list')
  const links = [...list.querySelectorAll('a')]
  const spread = (focusFirst) => {
    for (const other of menus) if (other !== menu) shut(other, false)
    button.setAttribute('aria-expanded', 'true')
    list.hidden = false
    if (focusFirst) links[0].focus()
  }
  button.addEventListener('click', () => (button.getAttribute('aria-expanded') === 'true' ? shut(menu, false) : spread(false)))
  menu.addEventListener('keydown', (e) => {
    const at = links.indexOf(document.activeElement)
    if (e.key === 'Escape') return shut(menu, true)
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return
    e.preventDefault()
    if (list.hidden) return spread(true)
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? links.length - 1 : (at + (e.key === 'ArrowDown' ? 1 : -1) + links.length) % links.length
    links[next].focus()
  })
  menu.addEventListener('focusout', (e) => {
    if (e.relatedTarget && !menu.contains(e.relatedTarget)) shut(menu, false)
  })
}
document.addEventListener('pointerdown', (e) => {
  for (const menu of menus) if (!menu.contains(e.target)) shut(menu, false)
})
