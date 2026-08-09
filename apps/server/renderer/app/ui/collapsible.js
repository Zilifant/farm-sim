/**
 * Minimizable panels. Each top-level panel renders an `<h2>` header as the
 * first child of its `<section>`; clicking that header toggles a `collapsed`
 * class on the section, and CSS hides everything but the header. The open-set is
 * remembered in localStorage, keyed by section id.
 *
 * A delegated listener on the (stable) section element is used rather than one
 * on the `<h2>`, because some panels rewrite their whole innerHTML on every
 * render (MetricsPanel, EventLog) — a listener on the header would be lost, but
 * the class on the section, and the listener attached to it, survive. The
 * Legend collapses on its own (it is a `<details>`), so it is not passed here.
 */

const STORAGE_KEY = 'wator.collapsedSections.v1';

function loadCollapsed() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return new Set(raw ? JSON.parse(raw) : []);
  } catch {
    return new Set();
  }
}

function saveCollapsed(ids) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...ids]));
  } catch {
    // A private-mode browser with no storage still gets working toggles, just
    // no persistence — not worth failing the panel over.
  }
}

/**
 * Wire click-to-collapse on each given panel section. Sections without an id are
 * skipped (there would be nowhere to remember their state).
 * @param {Array<HTMLElement | null>} sections
 */
export function makeSectionsCollapsible(sections) {
  const collapsed = loadCollapsed();
  for (const section of sections) {
    if (!section || !section.id) continue;
    if (collapsed.has(section.id)) section.classList.add('collapsed');
    section.addEventListener('click', (event) => {
      // Only a click on this section's own header toggles it — not a click on a
      // button, an input, or a nested collapsible inside the panel body.
      const target = event.target;
      if (!(target instanceof Element)) return;
      const header = target.closest('h2');
      if (!header || header.parentElement !== section) return;
      const nowCollapsed = section.classList.toggle('collapsed');
      if (nowCollapsed) collapsed.add(section.id);
      else collapsed.delete(section.id);
      saveCollapsed(collapsed);
    });
  }
}
