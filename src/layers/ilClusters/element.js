// The raw element behind one cluster member: which GEV layer owns it (and its
// select API), its title, and its feed fields for the INTELLIGENCE panel's
// element card. Pure, so the per-feed rules are tested.

/**
 * The GEV layer that shows each feed's elements, and the method that selects
 * one. Feeds without an entry (fires, GNSS cells, fixed sites other than
 * cameras) have no select API in GEV: their element card is the IL's own.
 */
export const ELEMENT_OWNERS = Object.freeze({
  aircraft: { layerId: 'flights', method: 'trackById' },
  military: { layerId: 'military', method: 'trackById' },
  vessels: { layerId: 'ais-live-vessels', method: 'selectById' },
  satellites: { layerId: 'satellites', method: 'trackById' },
  cameras: { layerId: 'cctv', method: 'selectCamera' },
  events: { layerId: 'gdelt-events', method: 'selectById' },
});

/** Fields that describe the graph, not the element. */
const INTERNAL = new Set([
  'id',
  'lat',
  'lon',
  'alt_m',
  'cluster_id',
  'degree',
  'component',
  'component_size',
  'tle_line1',
  'tle_line2',
  'west',
  'south',
  'east',
  'north',
]);

/** Fields that hold epoch seconds. */
const EPOCH_FIELDS = /(^|_)(epoch|time_position|last_position_epoch|updated_at|position_epoch|seen_at|last_contact)$/;

/**
 * A hub's member is a site of another feed: `kind` is that feed and `ref` the site's own id
 * (the member's id is `<kind>:<ref>`). Every other feed's member is its own element.
 * @returns {{kind: string, node: object}} the feed and node to open the element by.
 */
export function elementTarget(kind, node) {
  if (kind !== 'hubs' || !node?.kind) return { kind, node };
  return { kind: node.kind, node: { ...node, id: node.ref ?? node.id } };
}

/** The id GEV's owning layer knows the element by. */
export function ownerElementId(kind, node) {
  if (!node) return null;
  if (kind === 'military') return String(node.hex || node.id || '').trim() || null;
  if (kind === 'events') return node.ref || null;
  if (kind === 'satellites') return String(node.norad_id || node.id || '').trim() || null;
  return node.id != null ? String(node.id) : null;
}

/** A short title: the element's name where the feed has one, else its id. */
export function elementTitle(kind, node) {
  if (!node) return '';
  const first = [node.name, node.flight, node.callsign, node.place, node.title, node.r]
    .map((v) => (typeof v === 'string' ? v.trim() : ''))
    .find(Boolean);
  return first || String(ownerElementId(kind, node) ?? node.id ?? '');
}

function display(key, value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    if (EPOCH_FIELDS.test(key) && value > 1e9) return new Date(value * 1000).toISOString().replace('.000Z', 'Z');
    return Number.isInteger(value) ? String(value) : String(Math.round(value * 1000) / 1000);
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'string') return value.trim() || null;
  if (Array.isArray(value)) {
    const items = value.filter((v) => ['string', 'number'].includes(typeof v));
    return items.length && items.length <= 8 ? items.join(', ') : null;
  }
  return null;
}

/**
 * The element's own fields as `[key, text]` pairs (graph bookkeeping left
 * out), then its position.
 * @param {object} node A member node from the IL feed.
 * @param {number} [limit=24]
 */
export function elementFields(node, limit = 24) {
  if (!node) return [];
  const out = [];
  for (const [key, value] of Object.entries(node)) {
    if (INTERNAL.has(key)) continue;
    const text = display(key, value);
    if (text !== null) out.push([key, text.length > 120 ? `${text.slice(0, 117)}…` : text]);
    if (out.length >= limit) break;
  }
  if (Number.isFinite(node.lat) && Number.isFinite(node.lon))
    out.push(['position', `${node.lat.toFixed(5)}, ${node.lon.toFixed(5)}`]);
  if (Number.isFinite(node.alt_m)) out.push(['alt_m', String(Math.round(node.alt_m))]);
  return out;
}

/**
 * Open the element in the GEV layer that owns it, through that layer's own
 * select API.
 * @param {{isEnabled?: Function, layers?: Map}|null} dataManager GEV's layer lifecycle.
 * @returns {{layerId: string|null, opened: boolean, reason: 'none'|'off'|'missing'|'not-found'|null}}
 */
export function openInGev(dataManager, feedKind, feedNode) {
  const { kind, node } = elementTarget(feedKind, feedNode);
  const owner = ELEMENT_OWNERS[kind];
  if (!owner) return { layerId: null, opened: false, reason: 'none' };
  const elementId = ownerElementId(kind, node);
  if (!elementId) return { layerId: owner.layerId, opened: false, reason: 'not-found' };
  if (!dataManager?.isEnabled?.(owner.layerId)) return { layerId: owner.layerId, opened: false, reason: 'off' };
  const module = dataManager.layers?.get?.(owner.layerId)?.module;
  const method = module?.[owner.method];
  if (typeof method !== 'function') return { layerId: owner.layerId, opened: false, reason: 'missing' };
  let ok = false;
  try {
    ok = owner.method === 'selectCamera'
      ? Boolean(method.call(module, elementId, { focus: false }))
      : Boolean(method.call(module, elementId, { origin: 'intelligence-layer' }));
  } catch (error) {
    console.warn(`[Data:IL] opening ${kind} ${elementId} in ${owner.layerId} failed:`, error);
  }
  return { layerId: owner.layerId, opened: ok, reason: ok ? null : 'not-found' };
}

/**
 * The FIRMS record for a fire member: GEV's FIRMS layer (when on) knows the
 * detection's time, FRP, confidence and satellite; the IL's fire tiles carry
 * only its place. Matches the nearest record within ~50 m.
 * @param {object[]} records `getAnalystRecords()` of the FIRMS layer.
 */
export function matchFireRecord(records, node, toleranceDeg = 0.0005) {
  if (!Array.isArray(records) || !Number.isFinite(node?.lat) || !Number.isFinite(node?.lon)) return null;
  let best = null;
  let bestD = toleranceDeg;
  for (const r of records) {
    if (!Number.isFinite(r?.lat) || !Number.isFinite(r?.lon)) continue;
    const d = Math.max(Math.abs(r.lat - node.lat), Math.abs(r.lon - node.lon));
    if (d <= bestD) {
      best = r;
      bestD = d;
    }
  }
  return best;
}
