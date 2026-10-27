// Node sprites of the intelligence-layer graph: canvas-drawn billboards with a
// soft glow, a crisp rim and a lit core, in the style of GEV's own glow
// markers (FIRMS `glowSprite`). One sprite per (style, colour, state, size
// bucket), cached as a data URL so Cesium's texture atlas holds each once.

/** Sprite styles: a cluster node, one member contact, an observer (satellite), a past observer place. */
export const SPRITE_STYLES = Object.freeze(['node', 'member', 'observer', 'past']);

/** The sprite is this much wider than the core, so the glow has room. */
export const GLOW_FACTOR = 2.4;
/** Selected nodes grow by this much (core diameter). */
export const SELECTED_GROWTH = 1.3;
/** Canvas pixels per screen pixel: drawn at twice the size, sampled down crisp. */
const SCALE = 2;
const KEYLINE = 'rgba(5,8,14,0.78)';

/** Core diameter bucketed to even pixels in [4, 40]: few sprites, steady sizes. */
export function coreBucket(px) {
  const n = Number(px);
  if (!Number.isFinite(n)) return 8;
  return Math.max(4, Math.min(40, Math.round(n / 2) * 2));
}

/**
 * The cache key and billboard size of one sprite.
 * @param {{css: string, style?: string, selected?: boolean, corePx: number}} spec
 * @returns {{key: string, core: number, size: number}}
 */
export function spriteSpec({ css, style = 'node', selected = false, corePx }) {
  const kind = SPRITE_STYLES.includes(style) ? style : 'node';
  const core = coreBucket(selected ? corePx * SELECTED_GROWTH : corePx);
  // Selected sprites leave room for the outer ring and the brighter glow.
  const size = 2 * Math.round((core * (selected ? GLOW_FACTOR + 0.5 : GLOW_FACTOR)) / 2);
  return { key: `${kind}|${String(css).trim().toLowerCase()}|${selected ? 1 : 0}|${core}`, core, size };
}

/** [r, g, b] (0-255) of a CSS hex colour; other forms fall back to the GEV accent. */
export function rgbOf(css) {
  const hex = String(css).trim().replace(/^#/, '');
  const full = hex.length === 3 ? [...hex].map((c) => c + c).join('') : hex.slice(0, 6);
  if (!/^[0-9a-f]{6}$/i.test(full)) return [0, 212, 255];
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
}

/** Mix towards white (t > 0) or black (t < 0). */
export function shade([r, g, b], t) {
  const to = t > 0 ? 255 : 0;
  const k = Math.abs(t);
  return [r, g, b].map((v) => Math.round(v + (to - v) * k));
}

const rgba = (rgb, a) => `rgba(${rgb.join(',')},${a})`;
const _cache = new Map();

/**
 * The sprite image (a cached PNG data URL) and its billboard size in screen
 * pixels, or null where there is no canvas (tests).
 * @param {{css: string, style?: string, selected?: boolean, corePx: number}} spec
 * @returns {{image: string, size: number}|null}
 */
export function nodeSprite(spec) {
  const { key, core, size } = spriteSpec(spec);
  const hit = _cache.get(key);
  if (hit) return hit;
  const doc = globalThis.document;
  if (!doc?.createElement) return null;
  const canvas = doc.createElement('canvas');
  canvas.width = canvas.height = size * SCALE;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  draw(ctx, key.split('|')[0], rgbOf(spec.css), Boolean(spec.selected), core * SCALE, size * SCALE);
  const sprite = { image: canvas.toDataURL('image/png'), size };
  _cache.set(key, sprite);
  return sprite;
}

function circle(ctx, c, r) {
  ctx.beginPath();
  ctx.arc(c, c, r, 0, Math.PI * 2);
}

function draw(ctx, style, rgb, selected, corePx, sizePx) {
  const c = sizePx / 2;
  const r = corePx / 2;
  const s = SCALE;
  if (style === 'past') ctx.globalAlpha = 0.6;

  // Soft glow, strongest at the rim of the core.
  const glow = ctx.createRadialGradient(c, c, r * 0.7, c, c, c);
  const strength = selected ? 0.85 : style === 'member' ? 0.35 : 0.62;
  glow.addColorStop(0, rgba(rgb, strength));
  glow.addColorStop(0.4, rgba(rgb, strength * 0.35));
  glow.addColorStop(1, rgba(rgb, 0));
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, sizePx, sizePx);

  // Dark keyline under the core: it reads over bright imagery and neighbours.
  circle(ctx, c, r + 1.1 * s);
  ctx.fillStyle = KEYLINE;
  ctx.fill();

  if (style === 'observer' || style === 'past') {
    // Observers are hollow: a dark lens, a coloured rim and a bright pip.
    circle(ctx, c, r);
    ctx.fillStyle = 'rgba(8,14,24,0.88)';
    ctx.fill();
    circle(ctx, c, r - 0.9 * s);
    ctx.lineWidth = 1.6 * s;
    ctx.strokeStyle = rgba(shade(rgb, 0.2), 1);
    ctx.stroke();
    circle(ctx, c, Math.max(1.2 * s, r * 0.32));
    ctx.fillStyle = rgba(shade(rgb, 0.55), 1);
    ctx.fill();
  } else {
    // Lit core: lighter towards the upper left, the colour at its body, deeper at the rim.
    const body = ctx.createRadialGradient(c - r * 0.35, c - r * 0.4, r * 0.05, c, c, r);
    body.addColorStop(0, rgba(shade(rgb, 0.35), 1));
    body.addColorStop(0.6, rgba(rgb, 1));
    body.addColorStop(1, rgba(shade(rgb, -0.2), 1));
    circle(ctx, c, r);
    ctx.fillStyle = body;
    ctx.fill();
    // Crisp inner rim.
    circle(ctx, c, r - 0.6 * s);
    ctx.lineWidth = (style === 'member' ? 0.9 : 1.1) * s;
    ctx.strokeStyle = rgba(shade(rgb, 0.6), style === 'member' ? 0.7 : 0.9);
    ctx.stroke();
    if (style === 'node' && !selected) {
      // A thin outer ring past the keyline: the instrument "target" look.
      circle(ctx, c, r + 2.2 * s);
      ctx.lineWidth = 1 * s;
      ctx.strokeStyle = rgba(shade(rgb, 0.25), 0.85);
      ctx.stroke();
    }
  }

  if (selected) {
    // A white ring clear of the core, and a thin coloured halo outside it.
    circle(ctx, c, r + 2.6 * s);
    ctx.lineWidth = 1.6 * s;
    ctx.strokeStyle = 'rgba(255,255,255,0.95)';
    ctx.stroke();
    circle(ctx, c, r + 5.2 * s);
    ctx.lineWidth = 1 * s;
    ctx.strokeStyle = rgba(shade(rgb, 0.3), 0.7);
    ctx.stroke();
  }
}

/** Billboard options for one node sprite (spread into `BillboardCollection.add`). */
export function spriteBillboard(spec) {
  const sprite = nodeSprite(spec);
  const { size } = spriteSpec(spec);
  return sprite ? { image: sprite.image, width: size, height: size } : { width: size, height: size };
}
