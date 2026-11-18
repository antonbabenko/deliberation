// Search dialog behaviour (markup: components/Search.astro). The Pagefind script and its
// index are loaded from this site the first time the dialog opens, never before.
const dialog = document.querySelector('[data-search]')
if (dialog && typeof dialog.showModal === 'function') {
  const input = dialog.querySelector('input')
  const status = dialog.querySelector('.search-status')
  const list = dialog.querySelector('.search-results')
  const MAX = 8
  let engine = null
  let opener = null

  const load = () => {
    engine ??= import(/* @vite-ignore */ dialog.dataset.index).then((pagefind) => {
      pagefind.init()
      return pagefind
    })
    return engine
  }
  const say = (text) => (status.textContent = text)
  const el = (tag, className, html) => {
    const node = document.createElement(tag)
    if (className) node.className = className
    // Pagefind excerpts are HTML-escaped page text with <mark> around the matches.
    if (html) node.innerHTML = html
    return node
  }
  const row = (page) => {
    const item = el('li')
    const link = el('a')
    link.href = page.url
    link.append(el('b', '', page.meta.title || page.url), el('span', 'search-ex', page.excerpt))
    item.append(link)
    // Sections of the page that match, each a link to its heading.
    const parts = (page.sub_results || []).filter((s) => s.url !== page.url).slice(0, 3)
    if (parts.length > 0) {
      const sub = el('ul')
      for (const s of parts) {
        const a = el('a')
        a.href = s.url
        a.append(el('b', '', s.title), el('span', 'search-ex', s.excerpt))
        const li = el('li')
        li.append(a)
        sub.append(li)
      }
      item.append(sub)
    }
    return item
  }

  const run = async () => {
    const query = input.value.trim()
    if (!query) {
      list.replaceChildren()
      return say('Type to search the site.')
    }
    let found
    try {
      found = await (await load()).debouncedSearch(query, {}, 160)
    } catch {
      engine = null
      list.replaceChildren()
      return say('Search is not available here. The index is written by the site build.')
    }
    // null: a newer keystroke replaced this search.
    if (found === null || query !== input.value.trim()) return
    const pages = await Promise.all(found.results.slice(0, MAX).map((r) => r.data()))
    if (query !== input.value.trim()) return
    list.replaceChildren(...pages.map(row))
    const total = found.results.length
    say(total === 0 ? `No page mentions "${query}".` : total > MAX ? `${total} pages for "${query}". The first ${MAX} are listed.` : `${total} ${total === 1 ? 'page' : 'pages'} for "${query}".`)
  }

  const open = () => {
    if (dialog.open) return input.focus()
    opener = document.activeElement
    dialog.showModal()
    input.select()
    load().catch(() => (engine = null))
  }
  dialog.addEventListener('close', () => {
    if (opener instanceof HTMLElement) opener.focus()
    opener = null
  })
  input.addEventListener('input', run)
  // A click on the backdrop lands on the dialog itself.
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog || e.target.closest('[data-search-close]')) dialog.close()
  })
  dialog.querySelector('form').addEventListener('submit', (e) => {
    // Enter in the field opens the first result.
    e.preventDefault()
    list.querySelector('a')?.click()
  })
  dialog.addEventListener('keydown', (e) => {
    // In a search field the browser spends the first Escape on clearing the text.
    if (e.key === 'Escape') {
      e.preventDefault()
      return dialog.close()
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    const links = [...list.querySelectorAll('a')]
    if (links.length === 0) return
    e.preventDefault()
    const at = links.indexOf(document.activeElement)
    const next = e.key === 'ArrowDown' ? at + 1 : at - 1
    if (next < 0) return input.focus()
    links[Math.min(next, links.length - 1)].focus()
  })

  document.addEventListener('click', (e) => {
    if (e.target.closest('[data-search-open]')) open()
  })
  document.addEventListener('keydown', (e) => {
    const typing = e.target instanceof HTMLElement && (e.target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName))
    const combo = (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k'
    const slash = e.key === '/' && !e.metaKey && !e.ctrlKey && !e.altKey && !typing
    if (!combo && !slash) return
    e.preventDefault()
    open()
  })
}
