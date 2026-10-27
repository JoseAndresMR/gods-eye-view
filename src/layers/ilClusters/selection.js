// The one selected node of the intelligence-layer graph: a cluster or a satellite.
import * as Cesium from 'cesium';
import { isPointerFree } from '../../data/inputOwnership.js';
import { registerPickOwner, resolvePickId, unregisterPickOwner } from '../../data/pickRegistry.js';

/** Pick ids of IL cluster nodes: `il-node|<layer id>|<cluster id>`. */
const CLUSTER_PREFIX = 'il-node|';
/** Pick ids of satellites drawn by IL relation layers: `il-sat|<NORAD id>`. */
const SATELLITE_PREFIX = 'il-sat|';
const PICK_OWNER = 'intelligence-layer';

/** @typedef {{type: 'cluster', layerId: string, clusterId: string} | {type: 'satellite', satId: string}} IlSelection */

/** @type {IlSelection|null} */
let _selected = null;
const _listeners = new Set();
let _handler = null;
let _users = 0;

export const clusterPickId = (layerId, clusterId) => `${CLUSTER_PREFIX}${layerId}|${clusterId}`;
export const satellitePickId = (satId) => `${SATELLITE_PREFIX}${satId}`;

/** The selection a pick id stands for, or null when it isn't an IL node. */
export function selectionFromPickId(pickId) {
  const id = String(pickId ?? '');
  if (id.startsWith(SATELLITE_PREFIX)) return { type: 'satellite', satId: id.slice(SATELLITE_PREFIX.length) };
  if (id.startsWith(CLUSTER_PREFIX)) {
    const [layerId, ...rest] = id.slice(CLUSTER_PREFIX.length).split('|');
    if (layerId && rest.length) return { type: 'cluster', layerId, clusterId: rest.join('|') };
  }
  return null;
}

/** @returns {IlSelection|null} */
export function getSelection() {
  return _selected;
}

export function isClusterSelected(layerId, clusterId) {
  return _selected?.type === 'cluster' && _selected.layerId === layerId && _selected.clusterId === clusterId;
}

export function isSatelliteSelected(satId) {
  return _selected?.type === 'satellite' && _selected.satId === String(satId);
}

/** @param {IlSelection|null} selection */
export function select(selection) {
  const next = selection ? { ...selection } : null;
  if (JSON.stringify(next) === JSON.stringify(_selected)) return;
  _selected = next;
  for (const listener of _listeners) {
    try {
      listener(_selected);
    } catch (error) {
      console.warn('[Data:IL] selection listener failed:', error);
    }
  }
}

export function clearSelection() {
  select(null);
}

/** @param {(selection: IlSelection|null) => void} listener @returns {() => void} */
export function subscribeSelection(listener) {
  if (typeof listener !== 'function') return () => {};
  _listeners.add(listener);
  return () => _listeners.delete(listener);
}

/**
 * The selection after a globe click on `pickedId` (null when nothing with an
 * id was picked). An IL node selects itself; anything else clears: empty
 * globe, the photoreal 3D tiles (picked as a tile feature without an id) and
 * other GEV objects alike.
 * @param {string|null} pickedId
 * @returns {IlSelection|null}
 */
export function selectionAfterClick(pickedId) {
  return selectionFromPickId(pickedId);
}

function onKeyDown(event) {
  if (event.key === 'Escape' && _selected) clearSelection();
}

/**
 * Clicks on IL nodes select them; any other click on the globe clears the
 * selection. Every enabled IL layer calls this; the handler lives while any
 * of them does (the returned function releases one use).
 * @param {object} viewer Cesium viewer.
 * @returns {() => void}
 */
export function useIlPicking(viewer) {
  if (!viewer?.scene?.canvas) return () => {};
  _users++;
  if (!_handler) {
    registerPickOwner(PICK_OWNER, (pickedId) => selectionFromPickId(pickedId) !== null);
    _handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
    _handler.setInputAction((click) => {
      if (!isPointerFree()) return;
      // The photoreal tileset is always under the pointer, so "picked nothing"
      // never happens over land: every click that isn't on an IL node clears.
      select(selectionAfterClick(resolvePickId(viewer.scene.pick(click.position))));
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
    globalThis.document?.addEventListener?.('keydown', onKeyDown);
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    _users--;
    if (_users > 0 || !_handler) return;
    _handler.destroy();
    _handler = null;
    unregisterPickOwner(PICK_OWNER);
    globalThis.document?.removeEventListener?.('keydown', onKeyDown);
    clearSelection();
  };
}
