/**
 * ASCII glyph/color registry — the only place glyphs and colors exist, in the
 * biome renderer's tradition: the legend is generated from these tables, so it
 * cannot drift from what the grid actually draws. `colorToken` must be a key
 * of `DRACULA_COLORS` (rendered from the `--dracula-<token>` CSS variable,
 * with the hex here as fallback).
 *
 * Wa-Tor's world is all ocean: an empty cell is water, and the two species'
 * glyphs differ in shape as well as color, so color is never the only
 * distinction.
 */

export const DRACULA_COLORS = Object.freeze({
  'background': '#282A36',
  'current-line': '#6272A4',
  'selection': '#44475A',
  'foreground': '#F8F8F2',
  'comment': '#6272A4',
  'red': '#FF5555',
  'orange': '#FFB86C',
  'yellow': '#F1FA8C',
  'green': '#50FA7B',
  'cyan': '#8BE9FD',
  'purple': '#BD93F9',
  'pink': '#FF79C6',
  'background-lighter': '#424450',
  'background-light': '#343746',
  'background-dark': '#21222C',
  'background-darker': '#191A21',
  'bright-red': '#FF6E6E',
  'bright-green': '#69FF94',
  'bright-yellow': '#FFFFA5',
  'bright-purple': '#D6ACFF',
  'bright-pink': '#FF92DF',
  'bright-cyan': '#A4FFFF',
  'bright-white': '#FFFFFF',
});

/** Wa-Tor species codes, matching @sim/refsim's EMPTY/FISH/SHARK. */
export const EMPTY = 0;
export const FISH = 1;
export const SHARK = 2;

/**
 * Keyed by the protocol's species code. To reskin the sim, edit these entries
 * — nothing in the grid-rendering algorithm changes.
 */
export const SPECIES_APPEARANCE = Object.freeze({
  [FISH]: Object.freeze({ glyph: 'f', colorToken: 'cyan', label: 'fish' }),
  [SHARK]: Object.freeze({ glyph: 'S', colorToken: 'red', label: 'shark' }),
});

/** An empty cell is open water, drawn dim so the creatures carry the scene. */
export const WATER_APPEARANCE = Object.freeze({ glyph: '~', colorToken: 'comment', label: 'water' });

export const UNKNOWN_APPEARANCE = Object.freeze({ glyph: '?', colorToken: 'foreground', label: 'unknown' });

/**
 * @param {number} species protocol species code
 * @returns {{glyph: string, colorToken: string, label: string}}
 */
export function resolveAppearance(species) {
  if (species === EMPTY) return WATER_APPEARANCE;
  return SPECIES_APPEARANCE[species] ?? UNKNOWN_APPEARANCE;
}
