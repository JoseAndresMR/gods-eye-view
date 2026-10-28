/**
 * General IL settings in the INTELLIGENCE panel. For now one feature: "Show
 * lone members" (clusters of one member), a global switch plus one per feed.
 * A feed's row says "follows default" until it is switched against the global
 * switch; switching it back, or "Reset", returns it to following. Every change
 * saves the whole document at once (unknown keys are kept); the trackers read
 * it on their next tick, and the IL layers that are on re-read their feed.
 */
import { msg, t } from '../i18n/index.js';
import { layerNameForId } from './layerNames.js';
import {
  DEFAULT_SETTINGS,
  SETTINGS_FEEDS,
  loadSettings,
  loneClusters,
  loneEffective,
  saveSettings,
  setLoneDefault,
  setLoneOverride,
} from '../layers/ilClusters/settings.js';

/**
 * @param {object} options
 * @param {HTMLElement|null} options.container `#intel-settings`
 * @param {Array<{id: string, update?: Function}>} [options.layers] IL layers to refresh after a save
 * @param {Function} [options.fetchImpl]
 * @returns {() => void} Unmount.
 */
export function mountIntelSettings({ container, layers = [], fetchImpl = globalThis.fetch }) {
  if (!container) return () => {};
  const doc = container.ownerDocument;
  let state = { ...DEFAULT_SETTINGS };
  let status = '';
  let loaded = false;
  let destroyed = false;

  async function commit(next) {
    const previous = state;
    state = next;
    status = '';
    render();
    try {
      state = await saveSettings(next, fetchImpl);
      for (const layer of layers) layer?.update?.();
    } catch (error) {
      state = previous;
      status = t('Could not save settings: {error}', { error: error?.message || '' });
    }
    if (!destroyed) render();
  }

  function switchButton(on, title, onClick) {
    const b = doc.createElement('button');
    b.type = 'button';
    b.className = `data-toggle-btn intel-switch${on ? ' active feed-nominal' : ''}`;
    b.textContent = on ? t('ON') : t('OFF');
    b.title = title;
    b.setAttribute('aria-pressed', String(on));
    b.disabled = !loaded;
    b.addEventListener('click', onClick);
    return b;
  }

  function row(nameEl, ...controls) {
    const r = doc.createElement('div');
    r.className = 'intel-area-row intel-setting-row';
    r.append(nameEl, ...controls);
    return r;
  }

  function label(text, className = 'intel-area-name') {
    const s = doc.createElement('span');
    s.className = className;
    s.textContent = text;
    return s;
  }

  function render() {
    if (destroyed) return;
    container.textContent = '';
    const lone = loneClusters(state);
    container.appendChild(row(
      label(t('Show lone members')),
      switchButton(lone.default, t('Show clusters of one member in every feed, unless a feed says otherwise'), () =>
        commit(setLoneDefault(state, !lone.default)),
      ),
    ));
    const hint = label(t('A cluster of one member is a node with no count tag.'), 'intel-clusters-note');
    container.appendChild(hint);

    for (const [kind, layerId] of SETTINGS_FEEDS) {
      const overridden = typeof lone.overrides[kind] === 'boolean';
      const effective = loneEffective(state, kind);
      const reset = doc.createElement('button');
      reset.type = 'button';
      reset.className = 'intel-setting-state';
      reset.textContent = overridden ? t('Reset') : t('follows default');
      reset.disabled = !overridden || !loaded;
      reset.title = overridden ? t('Follow the default again') : t('This feed follows the default');
      reset.addEventListener('click', () => commit(setLoneOverride(state, kind, null)));
      container.appendChild(row(
        label(layerNameForId(layerId) || kind),
        reset,
        switchButton(effective, t('Show lone members in this feed'), () => {
          const next = !effective;
          commit(setLoneOverride(state, kind, next === lone.default ? null : next));
        }),
      ));
    }

    const note = doc.createElement('div');
    note.className = 'intel-clusters-note';
    note.setAttribute('role', 'status');
    note.textContent = status || (loaded ? t('Changes apply on the next update of each feed') : t('Loading settings'));
    container.appendChild(note);
  }

  render();
  loadSettings(fetchImpl)
    .then((result) => {
      state = result;
      loaded = true;
      render();
    })
    .catch((error) => {
      status = t('Could not load settings: {error}', { error: error?.message || msg('Intelligence layer unavailable') });
      render();
    });

  return () => {
    destroyed = true;
  };
}
