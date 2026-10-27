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
  events: {
    members: (n) => tn(n, '{count} conflict event', '{count} conflict events', { count: formatNumber(n) }),
    composition: [{ key: 'country', line: msg('Mostly in {value} ({count})') }],
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

/** English family labels, kept here so describe.js stays free of layer imports. */
const EVENT_FAMILY_LABELS = Object.freeze({
  battles: msg('Battles'),
  explosions: msg('Explosions / remote violence'),
  civilians: msg('Violence against civilians'),
  riots: msg('Riots'),
  protests: msg('Protests'),
  strategic: msg('Strategic developments'),
});

function eventLines(s) {
  const e = s.events;
  if (!e) return [];
  const lines = [];
  const top = s.composition?.family?.[0];
  if (top && EVENT_FAMILY_LABELS[top.value])
    lines.push(t('Mostly {value} ({count})', { value: t(EVENT_FAMILY_LABELS[top.value]), count: formatNumber(top.count) }));
  if (finite(e.fatalities_total) && e.fatalities_total > 0)
    lines.push(t('Reported fatalities: {count}', { count: formatNumber(e.fatalities_total) }));
  if (finite(e.mentions_total) && e.mentions_total > 0)
    lines.push(t('{count} news mentions', { count: formatNumber(e.mentions_total) }));
  if (finite(e.corroborated) && e.corroborated > 0)
    lines.push(t('{count} reported by both GDELT sources', { count: formatNumber(e.corroborated) }));
  if (finite(e.last_date))
    lines.push(t('Latest event {date}', { date: formatDate(e.last_date * 1000, { dateStyle: 'medium', timeZone: 'UTC' }) }));
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
  const lines = [spreadLine(s), heightLine(s), motionLine(s), ...fireLines(s), ...eventLines(s), ...gnssLines(s)];
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

/** Satellites named on one card line before "+N". */
const NAMES_SHOWN = 3;

function names(list) {
  const shown = list.slice(0, NAMES_SHOWN).join(', ');
  const more = list.length - NAMES_SHOWN;
  return more > 0 ? `${shown} +${formatNumber(more)}` : shown;
}

const minutesUntil = (t, nowSec) => formatNumber(Math.max(1, Math.round((t - nowSec) / 60)));
const satName = (satellites, id) => satellites[id]?.name || `NORAD ${id}`;

/**
 * Each relation's card lines take:
 * @typedef {object} ObservationContext
 * @property {string} kind Target cluster kind (vessels, fires, …).
 * @property {{now: Array<[string, number]>, counts: Object<string, number>, next: Object<string, {t: number, sat: string, day: boolean}>, pdop?: number, pdop_gps?: number}} place
 * @property {Object<string, {name: string, kinds: string[]}>} satellites By NORAD id.
 * @property {Array<{name: string, kinds: string[]}>} overhead Drawn satellites observing it right now.
 * @property {number} horizonS How far ahead passes were searched.
 * @property {number} nowSec
 */

/** @param {ObservationContext} o */
export function describeImaging({ place, satellites, overhead, horizonS, nowSec }) {
  const lines = [];
  const optical = overhead.filter((s) => s.kinds.includes('optical')).map((s) => s.name);
  const radar = overhead.filter((s) => s.kinds.includes('radar')).map((s) => s.name);
  if (optical.length) lines.push(t('Optical satellites overhead: {names}', { names: names(optical) }));
  if (radar.length) lines.push(t('Radar satellites overhead: {names}', { names: names(radar) }));
  const hours = round(horizonS / 3600, 1);
  const nextOptical = place.next?.optical;
  if (nextOptical && nextOptical.t > nowSec)
    lines.push(t('Next daylight optical pass in {minutes} min · {name}', {
      minutes: minutesUntil(nextOptical.t, nowSec), name: satName(satellites, nextOptical.sat),
    }));
  else if (!nextOptical && !optical.length) lines.push(t('No daylight optical pass in the next {hours} h', { hours }));
  const nextRadar = place.next?.radar;
  if (nextRadar && nextRadar.t > nowSec)
    lines.push(t('Next radar pass in {minutes} min · {name}', {
      minutes: minutesUntil(nextRadar.t, nowSec), name: satName(satellites, nextRadar.sat),
    }));
  else if (!nextRadar && !radar.length) lines.push(t('No radar pass in the next {hours} h', { hours }));
  return lines;
}

/** @param {ObservationContext} o */
export function describeFireSatellites({ place, satellites, overhead, horizonS, nowSec }) {
  const lines = [];
  if (overhead.length)
    lines.push(t('Fire-detecting satellites overhead: {names}', { names: names(overhead.map((s) => s.name)) }));
  const next = place.next?.fire;
  if (next && next.t > nowSec)
    lines.push(t('Next fire-detection overpass in {minutes} min · {name}', {
      minutes: minutesUntil(next.t, nowSec), name: satName(satellites, next.sat),
    }));
  else if (!next && !overhead.length)
    lines.push(t('No fire-detection overpass in the next {hours} h', { hours: round(horizonS / 3600, 1) }));
  return lines;
}

/** @param {ObservationContext} o */
export function describeWeather({ place, satellites }) {
  const count = place.counts?.weather || 0;
  if (!count) return [t('No weather satellite in view')];
  const [best, elevation] = place.now?.[0] || [];
  return [tn(count, '{count} weather satellite in view · highest {name} ({elevation}°)',
    '{count} weather satellites in view · highest {name} ({elevation}°)', {
      count: formatNumber(count), name: satName(satellites, best), elevation: round(elevation),
    })];
}

/** @param {ObservationContext} o */
export function describeReceivers({ kind, place, satellites, nowSec }) {
  const lines = [];
  const receiver = kind === 'vessels' ? 'ais' : 'adsb';
  const count = place.counts?.[receiver] || 0;
  const next = place.next?.[receiver];
  if (count)
    lines.push(receiver === 'ais'
      ? tn(count, '{count} space AIS receiver in reach', '{count} space AIS receivers in reach', { count: formatNumber(count) })
      : tn(count, '{count} space ADS-B receiver in reach', '{count} space ADS-B receivers in reach', { count: formatNumber(count) }));
  else if (next && next.t > nowSec) {
    const values = { minutes: minutesUntil(next.t, nowSec), name: satName(satellites, next.sat) };
    lines.push(receiver === 'ais'
      ? t('No space AIS receiver in reach · next in {minutes} min · {name}', values)
      : t('No space ADS-B receiver in reach · next in {minutes} min · {name}', values));
  } else
    lines.push(receiver === 'ais' ? t('No space AIS receiver in reach') : t('No space ADS-B receiver in reach'));
  const sar = place.counts?.sar || 0;
  if (sar)
    lines.push(tn(sar, '{count} search-and-rescue satellite in reach', '{count} search-and-rescue satellites in reach', {
      count: formatNumber(sar),
    }));
  return lines;
}

/** @param {ObservationContext} o */
export function describeNavigation({ place }) {
  const c = place.counts || {};
  const lines = [t('In view: {gps} GPS · {galileo} Galileo · {glonass} GLONASS', {
    gps: formatNumber(c.gps || 0), galileo: formatNumber(c.galileo || 0), glonass: formatNumber(c.glonass || 0),
  })];
  if (finite(place.pdop))
    lines.push(finite(place.pdop_gps)
      ? t('Satellite geometry: PDOP {pdop} all · {gps} GPS alone (lower is better)', {
          pdop: round(place.pdop, 1), gps: round(place.pdop_gps, 1),
        })
      : t('Satellite geometry: PDOP {pdop} all · too few GPS satellites alone', { pdop: round(place.pdop, 1) }));
  return lines;
}

/** "5 h ago" under two days, else "4 days ago". */
export function ago(seconds) {
  const hours = seconds / 3600;
  return hours < 48
    ? t('{hours} h ago', { hours: formatNumber(Math.max(1, Math.round(hours))) })
    : t('{days} days ago', { days: formatNumber(Math.round(hours / 24)) });
}

/**
 * Which scenes actually covered the cluster (NASA HLS), not geometry.
 * @param {ObservationContext & {place: {pending?: boolean, latest?: object, latest_clear?: object}, meta?: object}} o
 */
export function describeImaged({ place, satellites, nowSec }) {
  if (place.pending) return [t('Recent images: still being checked')];
  const image = (fact) => ({
    name: satName(satellites, fact.sat) === `NORAD ${fact.sat}` ? fact.platform : satName(satellites, fact.sat),
    ago: ago(nowSec - fact.t),
    cloud: fact.cloud === null || fact.cloud === undefined ? '?' : round(fact.cloud),
  });
  if (!place.latest) return [t('No image in the last days')];
  const lines = [t('Last image: {name} · {ago} · {cloud}% cloud', image(place.latest))];
  if (!place.latest_clear) lines.push(t('No clear image (at most 20% cloud) in the last days'));
  else if (place.latest_clear.t !== place.latest.t)
    lines.push(t('Last clear image: {name} · {ago} · {cloud}% cloud', image(place.latest_clear)));
  return lines;
}

/** Ground and air observers: the edges list each observer once, closest or most recent first. */
const observerNames = (place, satellites) => place.now.map(([id]) => satellites[id]?.name).filter(Boolean);

/** @param {ObservationContext} o */
export function describeCameras({ place, satellites }) {
  const cams = observerNames(place, satellites);
  if (!cams.length) return [];
  return [tn(cams.length, 'Watched by {count} public camera: {names}', 'Watched by {count} public cameras: {names}', {
    count: formatNumber(cams.length), names: names(cams),
  })];
}

/** @param {ObservationContext} o */
export function describePlateReaders({ place }) {
  const count = place.now.length;
  if (!count) return [];
  return [tn(count, '{count} plate reader within 100 m · nearest {distance} m', '{count} plate readers within 100 m · nearest {distance} m', {
    count: formatNumber(count), distance: round(place.now[0][1]),
  })];
}

/** @param {ObservationContext} o */
export function describeStreetImagery({ place }) {
  const count = place.now.length;
  if (!count) return [];
  return [tn(count, 'Street imagery: {count} capture drive passed · latest {ago}', 'Street imagery: {count} capture drives passed · latest {ago}', {
    count: formatNumber(count), ago: ago(place.now[0][1] * 3600),
  })];
}

/** @param {ObservationContext} o */
export function describeOverflights({ place, satellites }) {
  const lines = [];
  const military = place.now.filter(([id]) => satellites[id]?.kinds?.includes('military'));
  const civil = place.now.filter(([id]) => !satellites[id]?.kinds?.includes('military'));
  if (civil.length)
    lines.push(tn(civil.length, 'Overflown now by {count} aircraft cluster · lowest {altitude} m', 'Overflown now by {count} aircraft clusters · lowest {altitude} m', {
      count: formatNumber(civil.length), altitude: round(Math.min(...civil.map(([, v]) => v))),
    }));
  if (military.length)
    lines.push(tn(military.length, 'Overflown now by {count} military aircraft cluster · lowest {altitude} m', 'Overflown now by {count} military aircraft clusters · lowest {altitude} m', {
      count: formatNumber(military.length), altitude: round(Math.min(...military.map(([, v]) => v))),
    }));
  return lines;
}

/** The nearest of a place's edges, in metres, and how many there are. */
const nearest = (place) => ({
  count: formatNumber(place.now.length),
  distance: round(Math.min(...place.now.map(([, v]) => v))),
});

/** @param {ObservationContext} o */
export function describeFiresNear({ place }) {
  if (!place.now.length) return [];
  return [tn(place.now.length, 'Fire cluster within 5 km · nearest {distance} m', '{count} fire clusters within 5 km · nearest {distance} m', nearest(place))];
}

/** @param {ObservationContext} o */
export function describeVesselsNear({ place }) {
  if (!place.now.length) return [];
  return [tn(place.now.length, 'Ship cluster within 3 km · nearest {distance} m', '{count} ship clusters within 3 km · nearest {distance} m', nearest(place))];
}

/** @param {ObservationContext} o */
export function describeMilitaryOver({ place }) {
  if (!place.now.length) return [];
  return [tn(place.now.length, 'Military aircraft cluster within 10 km · nearest {distance} m', '{count} military aircraft clusters within 10 km · nearest {distance} m', nearest(place))];
}

/** Events sit on city centroids, so this is a weak link. @param {ObservationContext} o */
export function describeFiresEvents({ place }) {
  if (!place.now.length) return [];
  return [tn(place.now.length, 'Fire cluster within 25 km (event positions are approximate) · nearest {distance} m', '{count} fire clusters within 25 km (event positions are approximate) · nearest {distance} m', nearest(place))];
}

/** Inside degraded GNSS zones: how many, and the worst share of aircraft affected. */
export function describeGnssAffects({ place }) {
  if (!place.now.length) return [];
  const percent = round(Math.max(...place.now.map(([, v]) => v)));
  return [tn(place.now.length, 'Inside {count} degraded GNSS zone · up to {percent}% of aircraft affected', 'Inside {count} degraded GNSS zones · up to {percent}% of aircraft affected', {
    count: formatNumber(place.now.length), percent,
  })];
}

/** Cyclones and earthquakes reaching a cluster: how many, and the closest. */
export function describeHazards({ place }) {
  if (!place.now.length) return [];
  const closest = Math.min(...place.now.map(([, v]) => v));
  return [tn(place.now.length, 'Within reach of {count} hazard · closest {km} km', 'Within reach of {count} hazards · closest {km} km', {
    count: formatNumber(place.now.length), km: formatNumber(Math.round(closest / 1000)),
  })];
}
