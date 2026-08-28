/**
 * ASCII glyph/color registry — the only place glyphs and colors exist, in the
 * biome renderer's tradition: the legend is generated from these tables, so it
 * cannot drift from what the grid actually draws. `colorToken` must be a key
 * of `DRACULA_COLORS` (rendered from the `--dracula-<token>` CSS variable,
 * with the hex here as fallback).
 *
 * The farm map is terrain plus crop cells. Each (crop, growth bucket) pair
 * has its own protocol code; glyph shape tracks growth (dot → sprout → leafy
 * lowercase → full-height capital) and color tracks the crop, so neither
 * color nor shape is ever the only distinction.
 *
 * The numeric codes restate `@sim/farm`'s layout constants — the renderer
 * imports nothing from any package; it speaks the protocol as data.
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

/** Terrain codes, matching @sim/farm's layout constants. */
export const CELL_GRASS = 0;
export const CELL_FARMSTEAD = 1;
export const CELL_FOR_SALE = 2;
export const CELL_FALLOW = 3;
/** Crop cells: code = CROP_CODE_BASE + (crop - 1) * BUCKETS_PER_CROP + bucket. */
export const CROP_CODE_BASE = 8;
export const BUCKETS_PER_CROP = 4;

/** Growth buckets within a crop's code block. */
export const BUCKET_PLANTED = 0;
export const BUCKET_GERMINATING = 1;
export const BUCKET_GROWING = 2;
export const BUCKET_MATURE = 3;

/**
 * Crop presentation, keyed by protocol crop code (1..6). `letter` draws the
 * growing stage (lowercase) and mature stage (uppercase, bright color).
 */
export const CROP_APPEARANCE = Object.freeze({
  1: Object.freeze({ key: 'corn', label: 'corn', letter: 'c', colorToken: 'yellow', matureToken: 'bright-yellow' }),
  2: Object.freeze({ key: 'soybeans', label: 'soybeans', letter: 's', colorToken: 'green', matureToken: 'bright-green' }),
  3: Object.freeze({ key: 'wheat', label: 'wheat', letter: 'w', colorToken: 'orange', matureToken: 'yellow' }),
  4: Object.freeze({ key: 'potatoes', label: 'potatoes', letter: 'p', colorToken: 'purple', matureToken: 'bright-purple' }),
  5: Object.freeze({ key: 'hay', label: 'hay / alfalfa', letter: 'h', colorToken: 'cyan', matureToken: 'bright-cyan' }),
  6: Object.freeze({ key: 'tomatoes', label: 'tomatoes', letter: 't', colorToken: 'pink', matureToken: 'bright-pink' }),
});

export const TERRAIN_APPEARANCE = Object.freeze({
  [CELL_GRASS]: Object.freeze({ glyph: '.', colorToken: 'comment', label: 'grass / lane' }),
  [CELL_FARMSTEAD]: Object.freeze({ glyph: '#', colorToken: 'orange', label: 'farmstead' }),
  [CELL_FOR_SALE]: Object.freeze({ glyph: '$', colorToken: 'current-line', label: 'parcel for sale' }),
  [CELL_FALLOW]: Object.freeze({ glyph: '~', colorToken: 'comment', label: 'fallow field' }),
});

export const UNKNOWN_APPEARANCE = Object.freeze({ glyph: '?', colorToken: 'foreground', label: 'unknown' });

/** Stage glyph within a crop block: dot → sprout → leafy → full height. */
function cropGlyph(crop, bucket) {
  switch (bucket) {
    case BUCKET_PLANTED: return '.';
    case BUCKET_GERMINATING: return ',';
    case BUCKET_GROWING: return crop.letter;
    default: return crop.letter.toUpperCase();
  }
}

export const BUCKET_LABELS = Object.freeze(['planted', 'germinating', 'growing', 'mature']);

/**
 * @param {number} code protocol cell code
 * @returns {{glyph: string, colorToken: string, label: string}}
 */
export function resolveAppearance(code) {
  const terrain = TERRAIN_APPEARANCE[code];
  if (terrain) return terrain;
  if (code >= CROP_CODE_BASE) {
    const cropCode = Math.floor((code - CROP_CODE_BASE) / BUCKETS_PER_CROP) + 1;
    const bucket = (code - CROP_CODE_BASE) % BUCKETS_PER_CROP;
    const crop = CROP_APPEARANCE[cropCode];
    if (crop) {
      return {
        glyph: cropGlyph(crop, bucket),
        colorToken: bucket === BUCKET_MATURE ? crop.matureToken : crop.colorToken,
        label: `${crop.label} (${BUCKET_LABELS[bucket]})`,
      };
    }
  }
  return UNKNOWN_APPEARANCE;
}

/** The mature-stage appearance for a crop key — panel rows lead with it. */
export function cropAppearanceByKey(key) {
  const crop = Object.values(CROP_APPEARANCE).find((c) => c.key === key);
  if (!crop) return UNKNOWN_APPEARANCE;
  return { glyph: crop.letter.toUpperCase(), colorToken: crop.colorToken, label: crop.label };
}
