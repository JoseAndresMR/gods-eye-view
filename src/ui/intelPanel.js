/**
 * INTELLIGENCE panel (right rail): the synthesized summary of every cluster
 * the enabled intelligence-layer overlays show, largest first, one card each.
 * Clicking a card opens it, selects that cluster (its members and edges show
 * on the map) and flies the camera over it; a selected satellite gets a card
 * of its own at the top. The layers' own rows (toggle, chips) are placed
 * above by LayerPanel.
 */
import { formatNumber, t } from '../i18n/index.js';
import { localizeLayerName } from './layerNames.js';
import { clearSelection, getSelection, subscribeSelection } from '../layers/ilClusters/selection.js';

/** Cards listed per layer; the rest are counted in the section note. */
export const MAX_CARDS_PER_LAYER = 8;

/**
 * @param {object} options
 * @param {HTMLElement|null} options.container `#intel-clusters`
 * @param {HTMLElement|null} [options.count] `#intel-panel-count`
 * @param {object[]} options.layers IL layer modules (getClusterSummaries, subscribeClusters, focusCluster).
 * @returns {() => void} Unmount.
 */
export function mountIntelPanel({ container, count = null, layers }) {
  if (!container) return () => {};
  const open = new Set();
  let frame = null;

  function card(layer, cluster) {
    const key = `${layer.id}:${cluster.id}`;
    const el = container.ownerDocument.createElement('button');
    el.type = 'button';
    if (cluster.selected) open.add(key);
    el.className = `rail-card intel-cluster${open.has(key) ? ' is-open' : ''}${cluster.selected ? ' is-selected' : ''}`;
    el.dataset.layerId = layer.id;
    el.dataset.clusterId = cluster.id;
    el.setAttribute('aria-expanded', String(open.has(key)));
    el.title = t('Show this cluster on the map');

    const heading = container.ownerDocument.createElement('span');
    heading.className = 'rail-card-heading';
    const swatch = container.ownerDocument.createElement('span');
    swatch.className = 'intel-cluster-swatch';
    swatch.style.borderColor = cluster.color;
    swatch.setAttribute('aria-hidden', 'true');
    const title = container.ownerDocument.createElement('span');
    title.className = 'rail-card-title rail-card-nowrap';
    title.textContent = cluster.title;
    heading.append(swatch, title);

    const lines = container.ownerDocument.createElement('span');
    lines.className = 'rail-card-lines';
    for (const text of open.has(key) ? cluster.lines : cluster.lines.slice(0, 2)) {
      const line = container.ownerDocument.createElement('span');
      line.className = 'rail-card-line';
      line.textContent = text;
      lines.appendChild(line);
    }
    el.append(heading, lines);
    return el;
  }

  /** The selected satellite, as the relation layers that know it describe it. */
  function satelliteCard(doc, satId) {
    const parts = layers.map((layer) => layer.describeSatellite?.(satId)).filter(Boolean);
    if (!parts.length) return null;
    const heading = doc.createElement('h3');
    heading.className = 'data-layer-group-heading';
    heading.textContent = t('Selected satellite');
    const el = doc.createElement('button');
    el.type = 'button';
    el.className = 'rail-card intel-cluster is-open is-selected';
    el.dataset.satelliteId = satId;
    el.title = t('Clear the selection (Esc)');
    const title = doc.createElement('span');
    title.className = 'rail-card-title rail-card-nowrap';
    title.textContent = parts[0].name;
    const lines = doc.createElement('span');
    lines.className = 'rail-card-lines';
    for (const text of [...new Set(parts.flatMap((part) => part.lines))]) {
      const line = doc.createElement('span');
      line.className = 'rail-card-line';
      line.textContent = text;
      lines.appendChild(line);
    }
    el.append(title, lines);
    return [heading, el];
  }

  function render() {
    frame = null;
    const doc = container.ownerDocument;
    container.textContent = '';
    let total = 0;
    const selection = getSelection();
    if (selection?.type === 'satellite') container.append(...(satelliteCard(doc, selection.satId) || []));
    for (const layer of layers) {
      let clusters = [];
      try {
        clusters = layer.getClusterSummaries?.() || [];
      } catch (error) {
        console.warn(`[Data:IL] ${layer.id} summaries failed:`, error);
      }
      if (!clusters.length) continue;
      total += clusters.length;
      const heading = doc.createElement('h3');
      heading.className = 'data-layer-group-heading';
      heading.textContent = localizeLayerName(layer.name);
      container.appendChild(heading);
      const note = doc.createElement('div');
      note.className = 'intel-clusters-note';
      note.textContent = t('{shown} of {total} clusters · largest first', {
        shown: formatNumber(Math.min(clusters.length, MAX_CARDS_PER_LAYER)),
        total: formatNumber(clusters.length),
      });
      container.appendChild(note);
      const listed = clusters.slice(0, MAX_CARDS_PER_LAYER);
      // The selected cluster always has its card, even when it isn't among the largest.
      const selected = clusters.find((c) => c.selected);
      if (selected && !listed.includes(selected)) listed.unshift(selected);
      for (const cluster of listed) container.appendChild(card(layer, cluster));
    }
    if (!total) {
      const empty = doc.createElement('div');
      empty.className = 'intel-clusters-note';
      empty.textContent = t('Turn on an intelligence layer overlay above to list its clusters');
      container.appendChild(empty);
    }
    if (count) count.textContent = total ? formatNumber(total) : '';
  }

  function schedule() {
    if (frame !== null) return;
    frame = requestAnimationFrame(render);
  }

  function onClick(event) {
    const el = event.target?.closest?.('.intel-cluster');
    if (!el || !container.contains(el)) return;
    if (el.dataset.satelliteId) {
      clearSelection();
      return;
    }
    const key = `${el.dataset.layerId}:${el.dataset.clusterId}`;
    // A selected card closes and clears the selection; any other opens, selects and flies.
    if (el.classList.contains('is-selected')) {
      open.delete(key);
      clearSelection();
    } else {
      open.add(key);
      layers.find((l) => l.id === el.dataset.layerId)?.focusCluster?.(el.dataset.clusterId);
    }
    schedule();
  }

  container.addEventListener('click', onClick);
  const unsubscribers = [
    ...layers.map((layer) => layer.subscribeClusters?.(schedule) || (() => {})),
    subscribeSelection(schedule),
  ];
  render();
  return () => {
    if (frame !== null) cancelAnimationFrame(frame);
    container.removeEventListener('click', onClick);
    for (const unsubscribe of unsubscribers) unsubscribe();
  };
}
