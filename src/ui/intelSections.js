/**
 * INTELLIGENCE panel sections: every level of the panel (Areas, Single-layer
 * and its groups, Cross-layer and its relation families) is a disclosure. Its
 * header shows how many of the toggles inside are on. A section the user has
 * never opened or closed follows its content (open while something inside is
 * on); once toggled, the choice is remembered in this browser.
 */
import { formatNumber, t } from '../i18n/index.js';

export const STORAGE_KEY = 'gev.il.panelSections';

/** Whether a section is open: the user's choice, else open while something inside is on. */
export function sectionOpen(stored, activeCount) {
  return typeof stored === 'boolean' ? stored : activeCount > 0;
}

/** The remembered open/closed choices, or {} when storage is unavailable or garbled. */
export function readSectionState(storage = globalThis.localStorage) {
  try {
    const parsed = JSON.parse(storage?.getItem?.(STORAGE_KEY) || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter(([, v]) => typeof v === 'boolean'));
  } catch {
    return {};
  }
}

export function writeSectionState(state, storage = globalThis.localStorage) {
  try {
    storage?.setItem?.(STORAGE_KEY, JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {HTMLElement|null} root `#intel-panel-body`
 * @returns {() => void} Unmount.
 */
export function mountIntelSections(root, { storage = globalThis.localStorage } = {}) {
  if (!root) return () => {};
  const state = readSectionState(storage);
  const sections = [...root.querySelectorAll('[data-intel-section]')].map((el) => ({
    id: el.dataset.intelSection,
    el,
    button: el.querySelector(':scope > .intel-disclosure'),
    body: el.querySelector(':scope > .intel-disclosure-body'),
    count: el.querySelector(':scope > .intel-disclosure .intel-disclosure-count'),
  })).filter((s) => s.button && s.body);
  let frame = null;

  function sync() {
    frame = null;
    for (const s of sections) {
      const toggles = s.body.querySelectorAll('.data-toggle-btn:not(.intel-switch)');
      const active = s.body.querySelectorAll('.data-toggle-btn.active:not(.intel-switch)').length;
      const open = sectionOpen(state[s.id], active);
      if (s.button.getAttribute('aria-expanded') !== String(open)) s.button.setAttribute('aria-expanded', String(open));
      if (s.body.hidden === open) s.body.hidden = !open;
      s.el.classList.toggle('is-open', open);
      s.el.classList.toggle('has-active', active > 0);
      const text = toggles.length ? `${formatNumber(active)}/${formatNumber(toggles.length)}` : '';
      if (s.count && s.count.textContent !== text) {
        s.count.textContent = text;
        s.count.title = t('{active} of {total} on', { active: formatNumber(active), total: formatNumber(toggles.length) });
      }
    }
  }
  const schedule = () => {
    if (frame === null) frame = requestAnimationFrame(sync);
  };

  function onClick(event) {
    const button = event.target?.closest?.('.intel-disclosure');
    const s = button && sections.find((x) => x.button === button);
    if (!s) return;
    state[s.id] = s.button.getAttribute('aria-expanded') !== 'true';
    writeSectionState(state, storage);
    sync();
  }

  root.addEventListener('click', onClick);
  // Rows are rendered and switched on by other modules: follow them.
  const observer = typeof MutationObserver === 'function' ? new MutationObserver(schedule) : null;
  observer?.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] });
  sync();
  return () => {
    if (frame !== null) cancelAnimationFrame(frame);
    observer?.disconnect();
    root.removeEventListener('click', onClick);
  };
}
