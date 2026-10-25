// Human-readable synthesis of one intelligence-layer cluster summary.
import { formatDate, formatNumber, msg, t, tn } from '../../i18n/index.js';

const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const MPS_KMH = 3.6;
/** Below this mean speed a cluster reads as not moving. */
const STILL_MPS = 0.5;
/** Members this aligned (1 = all the same way) read as moving together. */
const TOGETHER_ALIGNMENT = 0.8;

const round = (v, digits = 0) => formatNumber(v, { maximumFractionDigits: digits });

/**
 * What each feed calls one member, and which summary composition entries
 * (`summary.composition[key]`) are worth a line.
 */
export const CLUSTER_KINDS = Object.freeze({
  aircraft: {
    members: (n) => tn(n, '{count} aircraft', '{count} aircraft', { count: formatNumber(n) }),
    composition: [
      { key: 'country', line: msg('Mostly registered in {value} ({count})') },
      { key: 'category', line: msg('Mostly {value} ({count})') },
    ],
  },
  military: {
    members: (n) => tn(n, '{count} military aircraft', '{count} military aircraft', { count: formatNumber(n) }),
    composition: [
      { key: 'type', line: msg('Mostly type {value} ({count})') },
      { key: 'callsign_prefix', line: msg('Callsigns mostly {value} ({count})') },
    ],
  },
  vessels: {
    members: (n) => tn(n, '{count} vessel', '{count} vessels', { count: formatNumber(n) }),
    composition: [
      { key: 'type', line: msg('Mostly {value} ({count})') },
      { key: 'destination', line: msg('Mostly bound for {value} ({count})') },
    ],
  },
  satellites: {
    members: (n) => tn(n, '{count} satellite', '{count} satellites', { count: formatNumber(n) }),
    composition: [{ key: 'constellation', line: msg('Mostly {value} ({count})') }],
  },
  fires: {
    members: (n) => tn(n, '{count} fire detection', '{count} fire detections', { count: formatNumber(n) }),
    composition: [],
  },
  gnss: {
    members: (n) => tn(n, '{count} low-accuracy cell', '{count} low-accuracy cells', { count: formatNumber(n) }),
    composition: [],
  },
  'military-areas': {
    members: (n) => tn(n, '{count} military area', '{count} military areas', { count: formatNumber(n) }),
    composition: [{ key: 'class', line: msg('Mostly {value} ({count})') }],
  },
  datacenters: {
    members: (n) => tn(n, '{count} data centre', '{count} data centres', { count: formatNumber(n) }),
    composition: [{ key: 'operator', line: msg('Mostly operated by {value} ({count})') }],
  },
  dams: {
    members: (n) => tn(n, '{count} dam', '{count} dams', { count: formatNumber(n) }),
    composition: [],
  },
  landings: {
    members: (n) => tn(n, '{count} cable landing', '{count} cable landings', { count: formatNumber(n) }),
    composition: [],
  },
  cameras: {
    members: (n) => tn(n, '{count} camera', '{count} cameras', { count: formatNumber(n) }),
    composition: [{ key: 'city', line: msg('Mostly {value} ({count})') }],
  },
});

function spreadLine(s) {
  if (!finite(s.radius_km) || !(s.size > 1)) return null;
  if (s.radius_km < 0.05) return t('Members share one position');
  return t('Within {radius} km of its centre', { radius: round(s.radius_km, s.radius_km < 10 ? 1 : 0) });
}

function heightLine(s) {
  const band = s.alt_m;
  if (!band || !finite(band.min) || !finite(band.max)) return null;
  if (band.min > 20000)
    return t('Altitude {min}–{max} km', { min: round(band.min / 1000), max: round(band.max / 1000) });
  return t('Height {min}–{max} m', { min: round(band.min), max: round(band.max) });
}

function motionLine(s) {
  const m = s.motion;
  if (!m || !m.reporting) return null;
  if (m.mean_speed_mps < STILL_MPS) return t('Not moving');
  if (m.alignment >= TOGETHER_ALIGNMENT)
    return t('Moving together · heading {heading}° · {speed} km/h', {
      heading: round(m.group_track_deg),
      speed: round(m.group_speed_mps * MPS_KMH),
    });
  return t('Moving in different directions');
}

function fireLines(s) {
  const f = s.fire;
  if (!f) return [];
  const lines = [];
  if (finite(f.frp_total_mw))
    lines.push(t('{total} MW radiative power · peak {peak} MW', {
      total: round(f.frp_total_mw),
      peak: round(f.frp_max_mw ?? 0),
    }));
  if (finite(f.last_detected))
    lines.push(t('Last detected {time} UTC', {
      time: formatDate(f.last_detected * 1000, { dateStyle: 'short', timeStyle: 'short', timeZone: 'UTC' }),
    }));
  return lines;
}

function gnssLines(s) {
  const g = s.gnss;
  if (!g) return [];
  return [
    t('{degraded} of {aircraft} aircraft reported low navigation accuracy', {
      degraded: formatNumber(g.degraded),
      aircraft: formatNumber(g.aircraft),
    }),
  ];
}

function ageLine(cluster) {
  const age = cluster?.age_s;
  if (!finite(age)) return null;
  if (age < 60) return t('Just formed');
  if (age < 3600) return t('Together for {minutes} min', { minutes: formatNumber(Math.round(age / 60)) });
  return t('Together for {hours} h', { hours: round(age / 3600, 1) });
}

/**
 * Title and lines describing one cluster, from the IL's `summary`.
 * @param {object} cluster IL cluster record with `id`, `size`, `age_s`, `summary`.
 * @param {keyof CLUSTER_KINDS} kind
 * @returns {{title: string, lines: string[]}}
 */
export function describeCluster(cluster, kind) {
  const spec = CLUSTER_KINDS[kind] || CLUSTER_KINDS.aircraft;
  const s = cluster?.summary || {};
  const size = finite(s.size) ? s.size : cluster?.size || 0;
  const lines = [spreadLine(s), heightLine(s), motionLine(s), ...fireLines(s), ...gnssLines(s)];
  for (const { key, line } of spec.composition) {
    const top = s.composition?.[key]?.[0];
    if (top && top.count > 1) lines.push(t(line, { value: String(top.value), count: formatNumber(top.count) }));
  }
  if (finite(s.area_km2_total))
    lines.push(t('{area} km² of mapped military land', { area: round(s.area_km2_total) }));
  // Named members (satellites, fixed sites), largest first where it matters.
  if (Array.isArray(s.names) && s.names.length)
    lines.push(s.names.slice(0, 3).join(', ') + (s.names.length > 3 ? '…' : ''));
  lines.push(ageLine(cluster));
  return { title: `${cluster?.id ?? ''} · ${spec.members(size)}`, lines: lines.filter(Boolean) };
}

/** Imaging satellites named on one card line before "+N". */
const OVERHEAD_NAMES = 3;

/**
 * Card lines on which satellites observe a cluster.
 * @param {object} o
 * @param {string[]} o.overhead Imaging satellites above their threshold right now.
 * @param {{t: number, name: string, day: boolean}|null} o.next Next imaging pass (Unix s).
 * @param {number} o.weather Weather satellites in view.
 * @param {number} o.horizonS How far ahead passes were searched.
 * @param {number} o.nowSec
 * @returns {string[]}
 */
export function describeObservation({ overhead, next, weather, horizonS, nowSec }) {
  const lines = [];
  if (overhead.length) {
    const shown = overhead.slice(0, OVERHEAD_NAMES).join(', ');
    const more = overhead.length - OVERHEAD_NAMES;
    lines.push(t('Imaging satellites overhead: {names}', {
      names: more > 0 ? `${shown} +${formatNumber(more)}` : shown,
    }));
  }
  if (next && next.t > nowSec) {
    const minutes = Math.max(1, Math.round((next.t - nowSec) / 60));
    lines.push(next.day
      ? t('Next imaging pass in {minutes} min · {name} · daylight', { minutes: formatNumber(minutes), name: next.name })
      : t('Next imaging pass in {minutes} min · {name} · night', { minutes: formatNumber(minutes), name: next.name }));
  } else if (!overhead.length && !next) {
    lines.push(t('No imaging pass in the next {hours} h', { hours: round(horizonS / 3600, 1) }));
  }
  if (weather > 0)
    lines.push(tn(weather, '{count} weather satellite in view', '{count} weather satellites in view', {
      count: formatNumber(weather),
    }));
  return lines;
}
