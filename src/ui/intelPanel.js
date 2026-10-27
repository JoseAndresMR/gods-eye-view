/**
 * INTELLIGENCE panel (right rail): the synthesized summary of every cluster
 * the enabled intelligence-layer overlays show, largest first, one card each.
 * Clicking a card opens it, selects that cluster (its members and edges show
 * on the map) and flies the camera over it; a selected satellite gets a card
 * of its own at the top, and so does a selected member (the raw element it
 * stands for, also opened in the GEV layer that owns it). The layers' own rows (toggle, chips) are placed
 * above by LayerPanel.
 */
import { formatNumber, t } from '../i18n/index.js';
import { layerNameForId, localizeLayerName } from './layerNames.js';
import { clearSelection, clusterOfSelection, getSelection, select, subscribeSelection } from '../layers/ilClusters/selection.js';

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

  /** The × that clears the selection, on the selected card. */
  function clearControl(doc) {
    const el = doc.createElement('span');
    el.className = 'intel-cluster-clear';
    el.textContent = '×';
    el.title = t('Clear selection');
    el.setAttribute('aria-label', t('Clear selection'));
    return el;
  }

  function card(layer, cluster) {
    const key = `${layer.id}:${cluster.id}`;
    const el = container.ownerDocument.createElement('button');
    el.type = 'button';
    if (cluster.selected) open.add(key);
    el.className = `rail-card intel-cluster${open.has(key) ? ' is-open' : ''}${cluster.selected ? ' is-selected' : ''}`;
    el.dataset.layerId = layer.id;
    el.dataset.clusterId = cluster.id;
    el.setAttribute('aria-expanded', String(open.has(key)));
    el.style.setProperty('--cluster', cluster.color);
    el.title = cluster.selected ? t('Clear the selection (Esc)') : t('Show this cluster on the map');

    const doc = container.ownerDocument;
    const heading = doc.createElement('span');
    heading.className = 'rail-card-heading';
    const swatch = doc.createElement('span');
    swatch.className = 'intel-cluster-swatch';
    swatch.setAttribute('aria-hidden', 'true');
    // The title reads "<id> · <members>": the members lead, the id is a tag.
    const prefix = `${cluster.id} · `;
    const title = doc.createElement('span');
    title.className = 'rail-card-title rail-card-nowrap';
    title.textContent = cluster.title.startsWith(prefix) ? cluster.title.slice(prefix.length) : cluster.title;
    const tag = doc.createElement('span');
    tag.className = 'intel-cluster-id';
    tag.textContent = cluster.id;
    heading.append(swatch, title, tag);
    if (cluster.selected) heading.appendChild(clearControl(doc));

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

  /** The status line of an element card: where in GEV it opened, or how to open it there. */
  function elementStatus(element) {
    const owner = element.owner ? layerNameForId(element.owner.layerId) || element.owner.layerId : null;
    if (element.open?.opened) return t('Opened in {layer}', { layer: owner });
    if (element.open?.reason === 'off') return t('Turn on {layer} to open it there', { layer: owner });
    if (element.open?.reason === 'not-found' || element.open?.reason === 'missing')
      return t('{layer} does not list it now', { layer: owner });
    if (element.firms === false) return t('Turn on {layer} for its time, FRP and confidence', { layer: layerNameForId('local-firms') });
    return null;
  }

  /**
   * The selected member: the raw element behind it, with its feed fields, a
   * way back to its cluster and the × that clears.
   */
  function elementCard(doc, selection) {
    const layer = layers.find((l) => l.id === selection.layerId);
    let element = null;
    try {
      element = layer?.describeElement?.(selection.nodeId) || null;
    } catch (error) {
      console.warn(`[Data:IL] ${selection.layerId} element failed:`, error);
    }
    if (!element) return null;
    const heading = doc.createElement('h3');
    heading.className = 'data-layer-group-heading';
    heading.textContent = t('Selected element');
    const el = doc.createElement('div');
    el.className = 'rail-card intel-cluster intel-element is-open is-selected';
    el.dataset.elementOf = selection.layerId;
    el.style.setProperty('--cluster', element.color);
    const head = doc.createElement('span');
    head.className = 'rail-card-heading';
    const swatch = doc.createElement('span');
    swatch.className = 'intel-cluster-swatch is-member';
    swatch.setAttribute('aria-hidden', 'true');
    const title = doc.createElement('span');
    title.className = 'rail-card-title rail-card-nowrap';
    title.textContent = element.title;
    const back = doc.createElement('button');
    back.type = 'button';
    back.className = 'intel-cluster-clear intel-element-back';
    back.textContent = '↩';
    back.title = t('Back to the cluster');
    back.setAttribute('aria-label', t('Back to the cluster'));
    const clear = doc.createElement('button');
    clear.type = 'button';
    clear.className = 'intel-cluster-clear';
    clear.textContent = '×';
    clear.title = t('Clear selection');
    clear.setAttribute('aria-label', t('Clear selection'));
    head.append(swatch, title, back, clear);
    const lines = doc.createElement('span');
    lines.className = 'rail-card-lines';
    const status = elementStatus(element);
    if (status) {
      const line = doc.createElement('span');
      line.className = 'rail-card-line intel-element-status';
      line.textContent = status;
      lines.appendChild(line);
    }
    for (const [key, value] of element.fields) {
      const line = doc.createElement('span');
      line.className = 'rail-card-line intel-element-field';
      const k = doc.createElement('span');
      k.className = 'intel-element-key';
      k.textContent = key;
      const v = doc.createElement('span');
      v.className = 'intel-element-value';
      v.textContent = value;
      line.append(k, v);
      lines.appendChild(line);
    }
    el.append(head, lines);
    return [heading, el];
  }

  /** The selected satellite, as the relation layers that know it describe it. */
  function satelliteCard(doc, satId) {
    const parts = layers.map((layer) => layer.describeSatellite?.(satId)).filter(Boolean);
    if (!parts.length) return null;
    const heading = doc.createElement('h3');
    heading.className = 'data-layer-group-heading';
    heading.textContent = parts[0].heading || t('Selected satellite');
    const el = doc.createElement('button');
    el.type = 'button';
    el.className = 'rail-card intel-cluster is-open is-selected';
    el.dataset.satelliteId = satId;
    el.title = t('Clear the selection (Esc)');
    const head = doc.createElement('span');
    head.className = 'rail-card-heading';
    const swatch = doc.createElement('span');
    swatch.className = 'intel-cluster-swatch is-observer';
    swatch.setAttribute('aria-hidden', 'true');
    const title = doc.createElement('span');
    title.className = 'rail-card-title rail-card-nowrap';
    title.textContent = parts[0].name;
    head.append(swatch, title, clearControl(doc));
    const lines = doc.createElement('span');
    lines.className = 'rail-card-lines';
    for (const text of [...new Set(parts.flatMap((part) => part.lines))]) {
      const line = doc.createElement('span');
      line.className = 'rail-card-line';
      line.textContent = text;
      lines.appendChild(line);
    }
    el.append(head, lines);
    return [heading, el];
  }

  function render() {
    frame = null;
    const doc = container.ownerDocument;
    container.textContent = '';
    let total = 0;
    const selection = getSelection();
    if (selection?.type === 'satellite') container.append(...(satelliteCard(doc, selection.satId) || []));
    if (selection?.type === 'member') container.append(...(elementCard(doc, selection) || []));
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
    if (event.target?.closest?.('.intel-element-back')) {
      select(clusterOfSelection());
      return;
    }
    if (event.target?.closest?.('.intel-element')) {
      if (event.target.closest('.intel-cluster-clear')) clearSelection();
      return;
    }
    const el = event.target?.closest?.('.intel-cluster');
    if (!el || !container.contains(el)) return;
    if (el.dataset.satelliteId || event.target.closest('.intel-cluster-clear')) {
      if (el.dataset.clusterId) open.delete(`${el.dataset.layerId}:${el.dataset.clusterId}`);
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
