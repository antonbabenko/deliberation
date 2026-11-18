// Scrollspy for every "On this page" list marked `data-spy` (the features page and the
// doc pages). The link of the section being read gets aria-current="location". Its style
// changes colour and underline only, so nothing moves. No dependency, no network.
//
// The observer's root is everything above a line under the top bar, so a callback fires
// each time a target crosses that line, also on a jump. The section being read is then
// the last target that starts above the line.
const LINE = 168 // px from the top: just below where a followed #link puts its heading
const ABOVE = 1e6 // px: how far above the window the root reaches

// A heading id with a literal % is not valid percent-encoding; use it as written.
const idOf = (hash) => {
  try {
    return decodeURIComponent(hash)
  } catch {
    return hash
  }
}

for (const nav of document.querySelectorAll('[data-spy]')) {
  if (!('IntersectionObserver' in window)) break
  const pairs = [...nav.querySelectorAll('a[href^="#"]')]
    .map((link) => ({ link, target: document.getElementById(idOf(link.hash.slice(1))) }))
    .filter((p) => p.target)
  if (pairs.length === 0) continue
  const calm = matchMedia('(prefers-reduced-motion: reduce)').matches
  let current = null

  // The list scrolls sideways on a phone and the column scrolls down when it is long:
  // keep the current entry inside whichever of the two is scrolling.
  const reveal = (link) => {
    const behavior = calm ? 'auto' : 'smooth'
    const strip = link.closest('ol')
    if (strip.scrollWidth > strip.clientWidth) strip.scrollTo({ left: link.offsetLeft - strip.offsetLeft - 16, behavior })
    const column = nav.closest('.side')
    if (!column || column.scrollHeight <= column.clientHeight) return
    const box = column.getBoundingClientRect()
    const at = link.getBoundingClientRect()
    if (at.top < box.top + 24 || at.bottom > box.bottom - 24) column.scrollBy({ top: at.top - box.top - column.clientHeight / 3, behavior })
  }

  const mark = () => {
    let now = pairs[0]
    for (const p of pairs) if (p.target.getBoundingClientRect().top <= LINE) now = p
    // At the end of the page a short last section never reaches the line.
    if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2) {
      const named = pairs.find((p) => p.link.hash === location.hash)
      now = named && named.target.getBoundingClientRect().top > LINE ? named : pairs[pairs.length - 1]
    }
    if (now === current) return
    if (current) current.link.removeAttribute('aria-current')
    now.link.setAttribute('aria-current', 'location')
    current = now
    reveal(now.link)
  }

  let io = null
  const watch = () => {
    if (io) io.disconnect()
    io = new IntersectionObserver(mark, { rootMargin: `${ABOVE}px 0px -${Math.max(0, window.innerHeight - LINE)}px 0px` })
    for (const p of pairs) io.observe(p.target)
    mark()
  }
  watch()
  // The line is set in pixels from the bottom edge, so a new window height moves it.
  window.addEventListener('resize', watch)
  window.addEventListener('hashchange', () => requestAnimationFrame(mark))
}
