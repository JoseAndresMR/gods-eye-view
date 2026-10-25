/**
 * Areas of interest in the INTELLIGENCE panel: where the intelligence layer
 * computes. "Whole world" and each saved box can be turned on or off; "Draw
 * area" drags a new box on the map (the imagery box tool, without its size
 * limit). Saved to the IL, which picks the change up on each tracker's next
 * tick; with nothing on, the trackers idle. While the panel is open the boxes
 * are outlined on the map.
 */
import * as Cesium from 'cesium';
import { formatNumber, msg, t } from '../i18n/index.js';
import { governorRequestRender } from '../renderGovernor.js';
import { initImageryBoxTool } from './imageryBoxTool.js';
import {
  DEFAULT_AREAS,
  MAX_AREAS,
  addArea,
  loadAreas,
  removeArea,
  saveAreas,
  updateArea,
  validateAreaBox,
} from '../layers/ilClusters/areas.js';
import { densifyRing } from '../layers/ilClusters/model.js';

const RENDER_ID = 'il-areas';
const ON_COLOR = Cesium.Color.fromCssColorString('#00d4ff');
const OFF_COLOR = Cesium.Color.fromCssColorString('#9a9a94').withAlpha(0.6);

/**
 * @param {object} options
 * @param {HTMLElement|null} options.container `#intel-areas`
 * @param {HTMLElement|null} options.panel `#intel-panel` (outlines show while it is open)
 * @param {object|null} options.viewer
 * @param {Function} [options.fetchImpl]
 * @returns {() => void} Unmount.
 */
export function mountIntelAreas({ container, panel, viewer, fetchImpl = globalThis.fetch }) {
  if (!container) return () => {};
  const doc = container.ownerDocument;
  let state = { ...DEFAULT_AREAS };
  let status = '';
  let drawing = false;
  let destroyed = false;
  const outlines = viewer?.scene?.primitives?.add(new Cesium.PolylineCollection()) || null;

  const tool = viewer
    ? initImageryBoxTool({
        viewer,
        validate: validateAreaBox,
        ownerId: 'il-area-box',
        onActive: (active) => {
          drawing = active;
          status = active ? t('Drag a box on the map · Esc cancels') : status;
          render();
        },
        onBox: (box) => {
          const next = addArea(state, box, t('Area {n}', { n: formatNumber(state.areas.length + 1) }));
          if (!next) status = t('At most {max} areas', { max: formatNumber(MAX_AREAS) });
          else commit(next);
        },
        onCancel: (_reason, message) => {
          status = message || '';
          render();
        },
      })
    : null;

  async function commit(next) {
    const previous = state;
    state = next;
    status = '';
    render();
    try {
      state = await saveAreas(next, fetchImpl);
    } catch (error) {
      state = previous;
      status = t('Could not save areas: {error}', { error: error?.message || '' });
    }
    if (!destroyed) render();
  }

  function drawOutlines() {
    if (!outlines) return;
    outlines.removeAll();
    outlines.show = Boolean(panel && !panel.classList.contains('collapsed'));
    for (const a of state.areas) {
      const ring = densifyRing(
        [[a.west, a.south], [a.east, a.south], [a.east, a.north], [a.west, a.north]],
        25,
      );
      outlines.add({
        positions: ring.map(([lon, lat]) => Cesium.Cartesian3.fromDegrees(lon, lat, 2000)),
        width: a.enabled ? 2 : 1,
        material: Cesium.Material.fromType('Color', { color: a.enabled ? ON_COLOR : OFF_COLOR }),
      });
    }
    governorRequestRender(RENDER_ID);
  }

  function toggleButton(on, title, onClick) {
    const b = doc.createElement('button');
    b.type = 'button';
    b.className = `data-toggle-btn${on ? ' active feed-nominal' : ''}`;
    b.textContent = on ? t('ON') : t('OFF');
    b.title = title;
    b.setAttribute('aria-pressed', String(on));
    b.addEventListener('click', onClick);
    return b;
  }

  function iconButton(symbol, title, onClick) {
    const b = doc.createElement('button');
    b.type = 'button';
    b.className = 'intel-area-icon';
    b.textContent = symbol;
    b.title = title;
    b.setAttribute('aria-label', title);
    b.addEventListener('click', onClick);
    return b;
  }

  function row(nameEl, ...controls) {
    const r = doc.createElement('div');
    r.className = 'intel-area-row';
    r.append(nameEl, ...controls);
    return r;
  }

  function render() {
    if (destroyed) return;
    container.textContent = '';
    const heading = doc.createElement('h3');
    heading.className = 'data-layer-group-heading';
    heading.textContent = t('Areas of interest');
    container.appendChild(heading);

    const world = doc.createElement('span');
    world.className = 'intel-area-name';
    world.textContent = t('Whole world');
    container.appendChild(row(world, toggleButton(state.global, t('Compute everywhere'), () => commit({ ...state, global: !state.global }))));

    for (const a of state.areas) {
      const name = doc.createElement('input');
      name.className = 'gev-field intel-area-name';
      name.value = a.name;
      name.maxLength = 60;
      name.setAttribute('aria-label', t('Area name'));
      name.addEventListener('change', () => commit(updateArea(state, a.id, { name: name.value.trim() || a.name })));
      container.appendChild(row(
        name,
        iconButton('⌖', t('Show area'), () =>
          viewer?.camera?.flyTo({ destination: Cesium.Rectangle.fromDegrees(a.west, a.south, a.east, a.north), duration: 1.5 }),
        ),
        iconButton('✕', t('Delete area'), () => commit(removeArea(state, a.id))),
        toggleButton(a.enabled, t('Compute in this area'), () => commit(updateArea(state, a.id, { enabled: !a.enabled }))),
      ));
    }

    const draw = doc.createElement('button');
    draw.type = 'button';
    draw.className = 'gev-action-button scene-btn intel-area-draw';
    draw.textContent = drawing ? t('Cancel') : t('Draw area');
    draw.disabled = !tool;
    draw.addEventListener('click', () => (drawing ? tool?.cancel('user') : tool?.start()));
    container.appendChild(draw);

    const note = doc.createElement('div');
    note.className = 'intel-clusters-note';
    note.setAttribute('role', 'status');
    note.textContent =
      status ||
      (state.global
        ? t('Computing worldwide')
        : state.areas.some((a) => a.enabled)
          ? t('Computing only inside the areas that are on')
          : t('Nothing is on: the intelligence layer is paused'));
    container.appendChild(note);
    drawOutlines();
  }

  const observer = panel && typeof MutationObserver === 'function'
    ? new MutationObserver(drawOutlines)
    : null;
  observer?.observe(panel, { attributes: true, attributeFilter: ['class'] });

  render();
  loadAreas(fetchImpl)
    .then((loaded) => {
      state = loaded;
      render();
    })
    .catch((error) => {
      status = t('Could not load areas: {error}', { error: error?.message || msg('Intelligence layer unavailable') });
      render();
    });

  return () => {
    destroyed = true;
    observer?.disconnect();
    tool?.destroy();
    if (outlines) viewer?.scene?.primitives?.remove(outlines);
  };
}
