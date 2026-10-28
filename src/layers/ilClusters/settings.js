// General IL settings: one JSON document the IL API keeps in data/settings.json.
// Pure helpers and the load/save calls; the INTELLIGENCE panel owns the UI.
// Unknown keys are kept: later features add their own sections.
import { IL_SETTINGS_URL } from './model.js';

/** Feed kinds that get their own "Show lone members" switch, in panel order. */
export const SETTINGS_FEEDS = Object.freeze([
  ['aircraft', 'il-aircraft-clusters'],
  ['military', 'il-military-clusters'],
  ['vessels', 'il-vessel-clusters'],
  ['satellites', 'il-satellite-clusters'],
  ['fires', 'il-fire-clusters'],
  ['gnss', 'il-gnss-zones'],
  ['events', 'il-event-clusters'],
  ['power-plants', 'il-power-plant-clusters'],
  ['lng-terminals', 'il-lng-terminal-clusters'],
  ['airports', 'il-airport-clusters'],
  ['ports', 'il-port-clusters'],
  ['military-areas', 'il-military-area-clusters'],
  ['datacenters', 'il-datacenter-clusters'],
  ['dams', 'il-dam-clusters'],
  ['landings', 'il-landing-clusters'],
  ['cameras', 'il-camera-clusters'],
]);

/** What the IL assumes when the file or a key is missing. */
export const DEFAULT_SETTINGS = Object.freeze({ lone_clusters: { default: true, overrides: {} } });

/** The lone-cluster section, with defaults filled in. */
export function loneClusters(doc) {
  const lone = doc?.lone_clusters;
  return {
    default: typeof lone?.default === 'boolean' ? lone.default : true,
    overrides: lone?.overrides && typeof lone.overrides === 'object' ? lone.overrides : {},
  };
}

/** Whether a feed shows lone members: its override, else the global default. */
export function loneEffective(doc, kind) {
  const { default: on, overrides } = loneClusters(doc);
  return typeof overrides[kind] === 'boolean' ? overrides[kind] : on;
}

/** The document with the global switch set; other keys and the overrides are kept. */
export function setLoneDefault(doc, on) {
  const lone = loneClusters(doc);
  return { ...doc, lone_clusters: { ...doc?.lone_clusters, default: Boolean(on), overrides: lone.overrides } };
}

/**
 * The document with a feed's override set to true/false, or removed (null:
 * "follows default"). Other feeds' overrides and unknown keys are kept.
 */
export function setLoneOverride(doc, kind, value) {
  const lone = loneClusters(doc);
  const overrides = { ...lone.overrides };
  if (typeof value === 'boolean') overrides[kind] = value;
  else delete overrides[kind];
  return { ...doc, lone_clusters: { ...doc?.lone_clusters, default: lone.default, overrides } };
}

async function readJson(res) {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`);
  return body;
}

export async function loadSettings(fetchImpl = globalThis.fetch) {
  return readJson(await fetchImpl(IL_SETTINGS_URL, { cache: 'no-store' }));
}

/** Save the whole document; resolves to what the IL stored. */
export async function saveSettings(doc, fetchImpl = globalThis.fetch) {
  return readJson(
    await fetchImpl(IL_SETTINGS_URL, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(doc),
    }),
  );
}
