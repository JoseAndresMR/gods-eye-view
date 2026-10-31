/**
 * Polygon selection for Areas of interest: click to add corners, double-click
 * or Enter to finish, Backspace removes the last corner, Esc cancels. Claims
 * the pointer like the imagery box tool and borrows (then returns) the
 * viewer's own click actions.
 */
import * as Cesium from 'cesium';
import { pickWorldFromScreen } from '../annotations/annotationResolver.js';
import { claimPointer, pointerOwner, releasePointer } from '../data/inputOwnership.js';

/**
 * @param {{ viewer: object, ownerId: string, onPolygon: (points: number[][]) => void, onCancel?: (reason: string, message?: string) => void, onActive?: (active: boolean) => void, onChange?: (count: number) => void, pickWorld?: Function, documentRef?: object }} deps
 * @returns {{ start: () => boolean, finish: () => void, cancel: (reason?: string) => void, isActive: () => boolean, destroy: () => void } | null}
 */
export function initPolygonTool({
  viewer,
  ownerId,
  onPolygon,
  onCancel,
  onActive,
  onChange,
  pickWorld = pickWorldFromScreen,
  documentRef = globalThis.document,
} = {}) {
  if (!viewer?.scene || typeof onPolygon !== 'function') return null;
  let active = false;
  let destroyed = false;
  let points = [];
  let cursor = null;
  let handler = null;
  let lease = null;
  let savedSingle = null;
  let savedDouble = null;

  const dataSource = new Cesium.CustomDataSource('gev-il-area-polygon');
  const attaching = Promise.resolve(viewer.dataSources.add(dataSource)).catch(() => null);
  const stroke = Cesium.Color.fromCssColorString('#8be9ff');
  const trace = () => {
    const path = [...points, ...(cursor && points.length ? [cursor] : []), ...(points.length ? [points[0]] : [])];
    return path.length < 2 ? [] : Cesium.Cartesian3.fromDegreesArray(path.flat());
  };
  const line = dataSource.entities.add({
    show: false,
    polyline: {
      positions: new Cesium.CallbackProperty(trace, false),
      width: 2,
      clampToGround: true,
      classificationType: Cesium.ClassificationType.BOTH,
      material: new Cesium.PolylineDashMaterialProperty({ color: stroke.withAlpha(0.95), dashLength: 12 }),
    },
  });
  const requestRender = () => viewer.scene.requestRender?.();

  const worldAt = (position) => {
    if (!position) return null;
    const canvas = viewer.scene.canvas;
    const w = canvas?.clientWidth || canvas?.width || 1;
    const h = canvas?.clientHeight || canvas?.height || 1;
    const point = pickWorld(viewer, position.x / w, position.y / h);
    const lon = Number(point?.lon);
    const lat = Number(point?.lat);
    return Number.isFinite(lon) && Number.isFinite(lat) ? [lon, lat] : null;
  };

  const onClick = (event) => {
    if (!active) return;
    const p = worldAt(event.position);
    if (!p) return onCancel?.('sky', 'Click on the ground, not the sky');
    points.push(p);
    line.show = true;
    onChange?.(points.length);
    requestRender();
  };
  const onMove = (event) => {
    if (!active || !points.length) return;
    cursor = worldAt(event.endPosition) || cursor;
    requestRender();
  };
  function finish() {
    if (!active || destroyed) return;
    // The double-click's two clicks usually land on one spot: drop the repeat.
    const last = points[points.length - 1];
    const prev = points[points.length - 2];
    if (last && prev && Math.abs(last[0] - prev[0]) < 1e-6 && Math.abs(last[1] - prev[1]) < 1e-6) points.pop();
    const done = points;
    setActive(false);
    onPolygon(done);
  }
  const onKey = (event) => {
    if (!active || destroyed) return;
    if (event.key === 'Escape') {
      event.preventDefault?.();
      event.stopImmediatePropagation?.();
      cancel('escape');
    } else if (event.key === 'Enter') {
      event.preventDefault?.();
      finish();
    } else if (event.key === 'Backspace' && points.length) {
      event.preventDefault?.();
      points.pop();
      onChange?.(points.length);
      requestRender();
    }
  };

  function setActive(next) {
    if (next === active) return active;
    if (next) {
      lease = claimPointer(ownerId);
      if (!lease) {
        onCancel?.('pointer-busy', `${pointerOwner()} is using the pointer — close it first`);
        return active;
      }
      active = true;
      points = [];
      cursor = null;
      handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
      handler.setInputAction(onClick, Cesium.ScreenSpaceEventType.LEFT_CLICK);
      handler.setInputAction(finish, Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK);
      handler.setInputAction(onMove, Cesium.ScreenSpaceEventType.MOUSE_MOVE);
      const stock = viewer.screenSpaceEventHandler;
      if (stock) {
        savedSingle = stock.getInputAction(Cesium.ScreenSpaceEventType.LEFT_CLICK) || null;
        savedDouble = stock.getInputAction(Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK) || null;
        stock.removeInputAction(Cesium.ScreenSpaceEventType.LEFT_CLICK);
        stock.removeInputAction(Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK);
      }
      documentRef?.addEventListener?.('keydown', onKey, true);
    } else {
      handler?.destroy();
      handler = null;
      const stock = viewer.screenSpaceEventHandler;
      if (stock && savedSingle) stock.setInputAction(savedSingle, Cesium.ScreenSpaceEventType.LEFT_CLICK);
      if (stock && savedDouble) stock.setInputAction(savedDouble, Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK);
      savedSingle = null;
      savedDouble = null;
      documentRef?.removeEventListener?.('keydown', onKey, true);
      line.show = false;
      points = [];
      cursor = null;
      releasePointer(lease);
      lease = null;
      active = false;
      requestRender();
    }
    onActive?.(active);
    return active;
  }

  function cancel(reason = 'cancel') {
    if (!active || destroyed) return;
    setActive(false);
    onCancel?.(reason);
  }

  return {
    start: () => !destroyed && setActive(true),
    finish,
    cancel,
    isActive: () => active,
    destroy() {
      if (active) setActive(false);
      destroyed = true;
      dataSource.entities.removeAll();
      attaching.then(() => {
        try {
          viewer.dataSources.remove(dataSource, true);
        } catch {
          /* viewer already disposed */
        }
      });
    },
  };
}
