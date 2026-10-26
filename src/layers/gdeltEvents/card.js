import { CONFLICT_FAMILIES, safeHttpUrl } from '../../data/conflictEvents.js';
import { formatNumber, t } from '../../i18n/index.js';
import { FAMILY_LABELS } from './families.js';

const SOURCE_LABELS = Object.freeze({
  'gdelt-cloud': 'GDELT Cloud', // i18n-ignore: provider product name
  'gdelt-project': 'GDELT Project', // i18n-ignore: provider product name
});

function el(doc, tag, className, text) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

/**
 * A small detail card for the selected event. Event text comes from news
 * feeds, so everything is inserted with textContent and links are limited to
 * http(s) and opened with rel=noopener.
 */
export function createEventCard({ doc = globalThis.document, onClose } = {}) {
  const root = el(doc, 'aside', 'gdelt-event-card');
  root.hidden = true;
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', t('Conflict event'));
  doc.body.appendChild(root);

  function show(event) {
    root.replaceChildren();
    const family = CONFLICT_FAMILIES[event.family];
    const head = el(doc, 'div', 'gdelt-event-card__head');
    const dot = el(doc, 'span', 'gdelt-event-card__dot');
    dot.style.background = family?.color || '#8d8d8d';
    head.append(
      dot,
      el(
        doc,
        'span',
        'gdelt-event-card__family',
        FAMILY_LABELS[event.family] ? t(FAMILY_LABELS[event.family]) : '',
      ),
    );
    const close = el(doc, 'button', 'gdelt-event-card__close', '×');
    close.type = 'button';
    close.setAttribute('aria-label', t('Close'));
    close.addEventListener('click', () => onClose?.());
    head.appendChild(close);
    root.appendChild(head);

    root.appendChild(
      el(
        doc,
        'div',
        'gdelt-event-card__title',
        event.title || event.category || '',
      ),
    );
    const where = [event.place, event.admin1, event.country]
      .filter(Boolean)
      .filter((v, i, all) => all.indexOf(v) === i)
      .join(', ');
    const meta = [where, event.date].filter(Boolean).join(' · ');
    if (meta) root.appendChild(el(doc, 'div', 'gdelt-event-card__meta', meta));
    if (event.subcategory)
      root.appendChild(
        el(doc, 'div', 'gdelt-event-card__meta', event.subcategory),
      );
    if (event.fatalities)
      root.appendChild(
        el(
          doc,
          'div',
          'gdelt-event-card__fatalities',
          t('Reported fatalities: {count}', {
            count: formatNumber(event.fatalities),
          }),
        ),
      );
    if (event.summary)
      root.appendChild(
        el(doc, 'p', 'gdelt-event-card__summary', event.summary),
      );

    const records = [event, ...(event.merged || [])];
    const sources = el(doc, 'div', 'gdelt-event-card__sources');
    for (const record of records) {
      const label = SOURCE_LABELS[record.source] || record.source;
      const href = safeHttpUrl(record.url);
      const detail =
        record.source === 'gdelt-project' && record.mentions
          ? ` · ${t('{count} mentions', { count: formatNumber(record.mentions) })}`
          : '';
      if (href) {
        const a = el(
          doc,
          'a',
          'gdelt-event-card__source',
          `${label}${detail} ↗`,
        );
        a.href = href;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        sources.appendChild(a);
      } else {
        sources.appendChild(
          el(doc, 'span', 'gdelt-event-card__source', `${label}${detail}`),
        );
      }
    }
    root.appendChild(sources);
    root.hidden = false;
  }

  return {
    show,
    hide() {
      root.hidden = true;
    },
    isShowing: () => !root.hidden,
    destroy() {
      root.remove();
    },
  };
}
