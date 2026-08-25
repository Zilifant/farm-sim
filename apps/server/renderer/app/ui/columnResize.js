/**
 * Draggable column widths.
 *
 * The three asides — events, population, sidebar — are grid tracks of `#main`
 * whose widths are CSS custom properties, so a drag writes one number on the
 * document root and the grid does the rest. Nothing here touches a panel's own
 * layout, and no panel needs to know it can be resized.
 *
 * ⚠ **The default width is the minimum, not a starting point.** Each column was
 * sized to the narrowest thing it has to show without wrapping (a histogram row,
 * a control row, an event line), so dragging below that would break the panel
 * rather than merely make it small. Dragging only ever makes a column *wider*;
 * double-clicking a handle returns it to the default.
 *
 * The handle sits in the same grid track as the column it resizes, pulled half
 * over the gap by a negative margin, so it overlays the column's inner edge
 * instead of consuming a track of its own — which keeps `#main`'s template one
 * entry per visible column.
 *
 * Widths are renderer-owned presentation state, so they live in `localStorage`
 * beside the collapsed-panel set and the inspector's open sections rather than
 * in the store.
 */

const STORAGE_KEY = 'farm.columnWidths.v1';

/** How far one arrow key moves a column edge, and how far Shift+arrow does. */
const KEY_STEP_PX = 16;
const KEY_STEP_FAST_PX = 64;

/**
 * How wide a column may get, as a fraction of the window. A column dragged over
 * the whole window would leave no grid to look at and no handle to drag back.
 */
const MAX_FRACTION = 0.5;

/**
 * The resizable columns, in DOM order. `cssVar` is the custom property `#main`
 * reads for that track and `min` is both the minimum and the default — see the
 * note above. `edge` says which side of the column the handle lives on: the
 * events column grows rightward from its right edge, the two right-hand columns
 * grow leftward from their left edge.
 *
 * ⚠ Keep `min` in step with the fallbacks in `renderer.css`. They are stated in
 * both places because CSS has to lay the page out before this module runs, and a
 * disagreement shows up as a column that jumps on first drag.
 */
export const RESIZABLE_COLUMNS = Object.freeze([
  Object.freeze({ id: 'events-column', cssVar: '--events-width', min: 260, edge: 'end', label: 'Event log width' }),
  Object.freeze({ id: 'population-column', cssVar: '--population-width', min: 300, edge: 'start', label: 'Population width' }),
  Object.freeze({ id: 'sidebar', cssVar: '--sidebar-width', min: 300, edge: 'start', label: 'Sidebar width' }),
]);

/**
 * Clamp a requested width to what the column can actually be: never below its
 * default (which is its minimum), never past half the window.
 * @param {number} width
 * @param {number} min
 * @param {number} windowWidth
 * @returns {number}
 */
export function clampColumnWidth(width, min, windowWidth) {
  if (!Number.isFinite(width)) return min;
  return Math.min(maxColumnWidth(min, windowWidth), Math.max(min, Math.round(width)));
}

/**
 * The widest a column may be right now. Never below `min`, so a window narrower
 * than twice the minimum still gets a column it can use rather than one clamped
 * out of existence.
 * @param {number} min
 * @param {number} windowWidth
 * @returns {number}
 */
export function maxColumnWidth(min, windowWidth) {
  return Math.max(min, Math.round(windowWidth * MAX_FRACTION));
}

/** Remembered widths by column id, or an empty object when storage is unreadable. */
function loadWidths() {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/** @param {Record<string, number>} widths */
function saveWidths(widths) {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(widths));
  } catch {
    // Remembering is a convenience; failing to remember is not an error.
  }
}

/**
 * Wire every `.col-resizer` handle in the document to the column it names, and
 * re-apply whatever widths were remembered.
 *
 * @param {object} [options]
 * @param {() => void} [options.onResize] called after a width changes, so the
 *        canvas can be re-fitted (the grid does not fire a window `resize`)
 * @param {Document | HTMLElement} [options.root] where to look for handles
 * @returns {void}
 */
export function makeColumnsResizable({ onResize = () => {}, root = document } = {}) {
  const widths = loadWidths();
  const style = document.documentElement.style;
  /** @type {Map<string, HTMLElement>} column id → its handle, for the ARIA values */
  const handles = new Map();

  const apply = (column, width, remember) => {
    const clamped = clampColumnWidth(width, column.min, window.innerWidth);
    style.setProperty(column.cssVar, `${clamped}px`);
    // The handle is a real widget, so it states where it is: a separator that
    // can be moved has to report its value, or it is a control only a mouse can
    // discover.
    const handle = handles.get(column.id);
    if (handle) {
      handle.setAttribute('aria-valuenow', String(clamped));
      handle.setAttribute('aria-valuemin', String(column.min));
      handle.setAttribute('aria-valuemax', String(maxColumnWidth(column.min, window.innerWidth)));
    }
    if (remember) {
      if (clamped === column.min) delete widths[column.id];
      else widths[column.id] = clamped;
      saveWidths(widths);
    }
    onResize();
    return clamped;
  };

  for (const column of RESIZABLE_COLUMNS) {
    const handle = root.querySelector?.(`.col-resizer[data-resize="${column.id}"]`);
    if (!handle) continue;
    handles.set(column.id, handle);
    handle.setAttribute('aria-label', column.label);
    apply(column, widths[column.id] ?? column.min, false);

    /** @type {{pointerId: number, startX: number, startWidth: number} | null} */
    let drag = null;

    handle.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      const element = document.getElementById(column.id);
      if (!element) return;
      // Measure what the column *is* rather than what was last stored: a
      // remembered width clamped by a since-narrowed window would otherwise make
      // the first pixel of the drag jump.
      drag = { pointerId: event.pointerId, startX: event.clientX, startWidth: element.getBoundingClientRect().width };
      handle.setPointerCapture(event.pointerId);
      handle.classList.add('dragging');
      // A drag across the grid must not also pan it, and a drag across text must
      // not select it.
      event.preventDefault();
    });

    handle.addEventListener('pointermove', (event) => {
      if (!drag || event.pointerId !== drag.pointerId) return;
      const delta = event.clientX - drag.startX;
      apply(column, drag.startWidth + (column.edge === 'end' ? delta : -delta), false);
    });

    const end = (event) => {
      if (!drag || event.pointerId !== drag.pointerId) return;
      const element = document.getElementById(column.id);
      drag = null;
      handle.classList.remove('dragging');
      if (handle.hasPointerCapture?.(event.pointerId)) handle.releasePointerCapture(event.pointerId);
      // Persist once, at the end: a write per pointer move is a write per frame.
      if (element) apply(column, element.getBoundingClientRect().width, true);
    };
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);

    // Back to the default, which is also the minimum — the one width that is
    // always usable, and hard to hit by dragging.
    handle.addEventListener('dblclick', () => apply(column, column.min, true));

    // Every other control in this renderer has a keyboard path — panning,
    // zooming, speed, follow — so a column edge that only a mouse can move
    // would be the exception. Left and right move the *edge*, which is why the
    // sign depends on which side of its column the handle sits.
    handle.addEventListener('keydown', (event) => {
      const step = event.shiftKey ? KEY_STEP_FAST_PX : KEY_STEP_PX;
      const towardEnd = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
      const element = document.getElementById(column.id);
      if (!element) return;
      if (towardEnd !== 0) {
        const delta = towardEnd * step * (column.edge === 'end' ? 1 : -1);
        apply(column, element.getBoundingClientRect().width + delta, true);
      } else if (event.key === 'Home') {
        apply(column, column.min, true);
      } else {
        return;
      }
      event.preventDefault();
    });
  }

  // A remembered width can exceed half of a window that has since been made
  // narrower, so the clamp is re-applied on resize. ⚠ Re-applied from the
  // *remembered* width rather than the rendered one, or a column squeezed by a
  // narrow window would stay squeezed after the window widened again.
  window.addEventListener('resize', () => {
    for (const column of RESIZABLE_COLUMNS) {
      apply(column, widths[column.id] ?? column.min, false);
    }
  });
}
