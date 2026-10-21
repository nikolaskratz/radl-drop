// Radl Drop: MyRadl (Munich bike share) trip planner.
//   Need a bike:  walk to the best bike -> ride -> drop-off station -> walk, minimising the total.
//   On a bike:    fastest drop-off station = min(ride to station + walk to destination).
// Everything runs in the browser against public, CORS-open APIs (no keys):
//   stations  nextbike GBFS (MyRadl system "nextbike_ml", CC0)
//   routing   Valhalla on FOSSGIS servers, OSRM FOSSGIS as fallback
//   search    Photon (komoot), Nominatim on explicit search; map tiles OpenFreeMap

const GBFS = 'https://gbfs.nextbike.net/maps/gbfs/v2/nextbike_ml/de';
const VALHALLA = 'https://valhalla1.openstreetmap.de';
const OSRM = 'https://routing.openstreetmap.de';
const PHOTON = 'https://photon.komoot.io';
const NOMINATIM = 'https://nominatim.openstreetmap.org';
const NOMINATIM_VIEWBOX = '10.8,48.5,12.2,47.75';
const STYLE = 'https://tiles.openfreemap.org/styles/positron';
const MUC = [11.5755, 48.1374];
const BBOX = '10.8,47.75,12.2,48.5';

const MAX_WALK_M = 1500;   // drop-off stations considered around the destination (straight line)
const MAX_CANDS = 40;      // Valhalla allows 100 sources x targets per matrix
const MIN_CANDS = 6;       // always try at least the nearest few, even if further away
const PICKUP_M = 1000;     // pickups considered around the start
const MAX_PICKUPS = 12;
const MIN_PICKUPS = 4;
const TRIP_PICKUPS = 5;    // full trip: 5 pickups x 20 drop-offs = the 100-cell matrix limit
const TRIP_DROPS = 20;
const UNLOCK_S = 60;       // finding the bike + renting it in the app
const PARK_S = 60;         // finding the zone + locking + ending the rental
const INCLUDED_MIN = 30;   // ride time covered by the fixed price
const WALK_HILITE_S = 300; // highlight drop-offs within a 5 min walk of the destination
const BIKE_KMH = { bike: 16, ebike: 20 };
const RECENT_KEY = 'radl-drop.recent';
const PREFS_KEY = 'radl-drop.prefs';
const STATUS_TTL_MS = 60000;

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const min = (s) => Math.max(1, Math.round(s / 60));
const meters = (m) => (m < 950 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1)} km`);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function loadPrefs() {
  try { return JSON.parse(localStorage.getItem(PREFS_KEY)) ?? {}; } catch { return {}; }
}
const prefs = loadPrefs();

const state = {
  stations: [],
  loose: [],         // bikes parked outside any station (rentable)
  vehicleKind: {},   // GBFS vehicle_type_id -> 'bike' | 'ebike'
  statusAt: 0,
  gps: null,         // {lat, lon} from watchPosition
  gpsError: null,
  from: null,        // null = use GPS, else {lat, lon, label}
  to: null,          // {lat, lon, label}
  mode: prefs.mode === 'have' ? 'have' : 'need',            // need a bike | already on one
  type: ['bike', 'ebike'].includes(prefs.type) ? prefs.type : 'any',
  kind: null,        // 'pickup' | 'drop' | 'trip': what state.ranked holds
  ranked: [],        // best first
  sel: 0,
  planSeq: 0,
};

function savePrefs() {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify({ mode: state.mode, type: state.type })); } catch { /* no prefs */ }
}

// ---------- helpers ----------

async function getJSON(url, opts = {}, timeoutMs = 15000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { ...opts, signal: ctl.signal });
    if (!r.ok) throw new Error(`${r.status} ${url.split('?')[0]}`);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

function haversine(a, b) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function decodePolyline6(str) {
  const pts = [];
  let i = 0, lat = 0, lon = 0;
  while (i < str.length) {
    for (const k of [0, 1]) {
      let shift = 0, result = 0, b;
      do { b = str.charCodeAt(i++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
      const d = result & 1 ? ~(result >> 1) : result >> 1;
      if (k === 0) lat += d; else lon += d;
    }
    pts.push([lon / 1e6, lat / 1e6]);
  }
  return pts;
}

const loc = (p) => ({ lat: p.lat, lon: p.lon });
const startPoint = () => state.from ?? (state.gps ? { ...state.gps, label: 'My location', gps: true } : null);

// ---------- bikes ----------

const rideMode = () => (state.type === 'ebike' ? 'ebike' : 'bike');
const avail = (p, type = state.type) => (type === 'any' ? p.n.bike + p.n.ebike : p.n[type]);
const typeWord = () => ({ any: 'bikes', bike: 'normal bikes', ebike: 'e-bikes' }[state.type]);

function availText(p, type = state.type) {
  if (p.loose) return p.battery != null ? `${p.name} · ${p.battery} % battery` : p.name;
  const parts = [];
  if (type !== 'ebike') parts.push(plural(p.n.bike, 'bike'));
  if (type !== 'bike' && (p.n.ebike || type === 'ebike')) {
    const bat = p.n.ebike && p.battery != null ? ` (${p.n.ebike > 1 ? 'best ' : ''}${p.battery} % battery)` : '';
    parts.push(plural(p.n.ebike, 'e-bike') + bat);
  }
  return parts.join(' · ');
}

// ---------- routing ----------

function bikeCosting(mode) {
  return { bicycle: { bicycle_type: 'City', cycling_speed: BIKE_KMH[mode] } };
}

// mode: 'walk' | 'bike' | 'ebike'. Returns matrix[i][j] = {time (s), dist (m)} or null, sources x targets.
async function valhallaMatrix(sources, targets, mode) {
  const body = { sources: sources.map(loc), targets: targets.map(loc), costing: mode === 'walk' ? 'pedestrian' : 'bicycle', units: 'kilometers' };
  if (mode !== 'walk') body.costing_options = bikeCosting(mode);
  const d = await getJSON(`${VALHALLA}/sources_to_targets`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return d.sources_to_targets.map((row) => row.map((c) => (c.time == null ? null : { time: c.time, dist: c.distance * 1000 })));
}

async function osrmMatrix(sources, targets, mode) {
  const pts = [...sources, ...targets];
  const coords = pts.map((p) => `${p.lon.toFixed(6)},${p.lat.toFixed(6)}`).join(';');
  const src = sources.map((_, i) => i).join(';');
  const dst = targets.map((_, j) => sources.length + j).join(';');
  const profile = mode === 'walk' ? 'foot' : 'bike';
  const d = await getJSON(`${OSRM}/routed-${profile}/table/v1/driving/${coords}?sources=${src}&destinations=${dst}&annotations=duration,distance`);
  const scale = mode === 'walk' ? 1 : 15 / BIKE_KMH[mode]; // OSRM's bike profile rides ~15 km/h
  return d.durations.map((row, i) => row.map((t, j) => (t == null ? null : { time: t * scale, dist: d.distances[i][j] })));
}

function crowMatrix(sources, targets, mode) {
  const mps = mode === 'walk' ? 1.4 : BIKE_KMH[mode] / 3.6;
  return sources.map((a) => targets.map((b) => { const dist = haversine(a, b) * 1.3; return { time: dist / mps, dist }; }));
}

async function matrix(sources, targets, mode) {
  try { return { m: await valhallaMatrix(sources, targets, mode), src: 'valhalla' }; }
  catch (e) { console.warn('valhalla matrix', e); }
  try { return { m: await osrmMatrix(sources, targets, mode), src: 'osrm' }; }
  catch (e) { console.warn('osrm matrix', e); }
  return { m: crowMatrix(sources, targets, mode), src: 'estimate' };
}

async function routeLine(a, b, mode) {
  try {
    const body = { locations: [loc(a), loc(b)], costing: mode === 'walk' ? 'pedestrian' : 'bicycle' };
    if (mode !== 'walk') body.costing_options = bikeCosting(mode);
    const d = await getJSON(`${VALHALLA}/route`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return d.trip.legs.flatMap((l) => decodePolyline6(l.shape));
  } catch (e) { console.warn('valhalla route', e); }
  try {
    const d = await getJSON(`${OSRM}/routed-${mode === 'walk' ? 'foot' : 'bike'}/route/v1/driving/${a.lon},${a.lat};${b.lon},${b.lat}?overview=full&geometries=geojson`);
    return d.routes[0].geometry.coordinates;
  } catch (e) { console.warn('osrm route', e); }
  return [[a.lon, a.lat], [b.lon, b.lat]];
}

// ---------- planning ----------

function dropoffs(D) {
  const withDist = state.stations.filter((s) => s.returning).map((s) => ({ s, d: haversine(D, s) }));
  withDist.sort((x, y) => x.d - y.d);
  const near = withDist.filter((x, i) => x.d <= MAX_WALK_M || i < MIN_CANDS).slice(0, MAX_CANDS);
  return near.filter((x) => x.d < 5000).map((x) => x.s);
}

function pickups(S) {
  const pool = [...state.stations.filter((s) => s.renting), ...state.loose].filter((p) => avail(p) > 0)
    .map((p) => ({ p, d: haversine(S, p) })).sort((x, y) => x.d - y.d);
  return pool.filter((x, i) => (x.d <= PICKUP_M || i < MIN_PICKUPS) && x.d < 3000).slice(0, MAX_PICKUPS).map((x) => x.p);
}

const usable = (r) => r.status === 'fulfilled';

// On a bike: ride S -> station, walk station -> D.
async function planDrop(S, D) {
  const cands = dropoffs(D);
  if (!cands.length) return { error: 'No MyRadl station within 5 km of this destination.' };
  // S -> D on foot too (if close), to tell when walking beats riding.
  const walkDirect = haversine(S, D) < 3000;
  const [ride, walk] = await Promise.all([matrix([S], cands, rideMode()), matrix(walkDirect ? [...cands, S] : cands, [D], 'walk')]);
  const ranked = cands
    .map((s, i) => ({ s, ride: ride.m[0][i], walk: walk.m[i][0] }))
    .filter((r) => r.ride && r.walk)
    .map((r) => ({ ...r, total: r.ride.time + r.walk.time + PARK_S }))
    .sort((a, b) => a.total - b.total);
  if (!ranked.length) return { error: 'Could not route to any nearby station.' };
  return {
    kind: 'drop', ranked,
    directWalk: walkDirect ? walk.m[cands.length][0] : null,
    estimated: ride.src === 'estimate' || walk.src === 'estimate',
  };
}

// Need a bike, no destination yet: nearest bikes on foot.
async function planPickup(S) {
  const P = pickups(S);
  if (!P.length) return { error: `No ${typeWord()} available within 3 km.` };
  const walk = await matrix([S], P, 'walk');
  const ranked = P.map((p, i) => ({ p, walkP: walk.m[0][i] })).filter((r) => r.walkP)
    .map((r) => ({ ...r, total: r.walkP.time })).sort((a, b) => a.total - b.total);
  if (!ranked.length) return { error: 'Could not route to any nearby bike.' };
  return { kind: 'pickup', ranked, directWalk: null, estimated: walk.src === 'estimate' };
}

// Need a bike, with destination: walk S -> pickup, ride pickup -> drop-off, walk drop-off -> D.
async function planTrip(S, D) {
  const P = pickups(S), Q = dropoffs(D);
  if (!P.length) return { error: `No ${typeWord()} available within 3 km.` };
  if (!Q.length) return { error: 'No MyRadl station within 5 km of this destination.' };
  const mode = rideMode(), mps = BIKE_KMH[mode] / 3.6;
  const walkDirect = haversine(S, D) < 3000;
  const [wP, wQ] = await Promise.all([matrix([S], P, 'walk'), matrix(walkDirect ? [...Q, S] : Q, [D], 'walk')]);

  // Narrow down to what fits one ride matrix, by walk time + a straight-line ride estimate.
  // The nearest bike and the closest drop-off always stay in, so "faster than the obvious choice" is measured.
  const shortlist = (items, n, guess) => {
    const ok = items.filter((x) => x.w).sort((a, b) => a.w.time + guess(a) - (b.w.time + guess(b)));
    const nearest = ok.reduce((a, b) => (!a || b.w.time < a.w.time ? b : a), null);
    const top = ok.slice(0, n);
    if (nearest && !top.includes(nearest)) top[top.length - 1] = nearest;
    return { top, nearest };
  };
  const ps = shortlist(P.map((p, i) => ({ x: p, w: wP.m[0][i] })), TRIP_PICKUPS, (a) => (haversine(a.x, D) * 1.3) / mps);
  const qs = shortlist(Q.map((q, i) => ({ x: q, w: wQ.m[i][0] })), TRIP_DROPS, (a) => (haversine(S, a.x) * 1.3) / mps);
  if (!ps.top.length || !qs.top.length) return { error: 'Could not route to any nearby bike or station.' };

  const ride = await matrix(ps.top.map((a) => a.x), qs.top.map((b) => b.x), mode);
  const ranked = [];
  ps.top.forEach((a, i) => qs.top.forEach((b, j) => {
    const r = ride.m[i][j];
    if (r) ranked.push({ p: a.x, walkP: a.w, s: b.x, ride: r, walk: b.w, total: a.w.time + UNLOCK_S + r.time + PARK_S + b.w.time });
  }));
  ranked.sort((a, b) => a.total - b.total);
  if (!ranked.length) return { error: 'Could not route between the nearby bikes and stations.' };
  return {
    kind: 'trip', ranked,
    obvious: ranked.find((r) => r.p === ps.nearest?.x && r.s === qs.nearest?.x) ?? null,
    directWalk: walkDirect ? wQ.m[Q.length][0] : null,
    estimated: [wP, wQ, ride].some((m) => m.src === 'estimate'),
  };
}

async function plan() {
  const S = startPoint(), D = state.to;
  if (state.mode === 'have' && !D) {
    clearResults();
    hint('Where are you riding to? Search a destination, or long-press the map.');
    return;
  }
  if (!S) {
    clearResults();
    hint(state.gpsError ? 'Location is blocked. Type a start address above.' : 'Waiting for your location…', !!state.gpsError);
    return;
  }
  if (!state.stations.length) { hint('Loading stations…'); return; }

  const seq = ++state.planSeq;
  hint(state.mode === 'have' ? 'Finding the fastest drop-off…' : D ? 'Finding the fastest bike and drop-off…' : `Finding the nearest ${typeWord()}…`);
  if (state.mode === 'need') await refreshStatus(); // bikes move: counts older than a minute get reloaded
  if (seq !== state.planSeq) return;

  let res;
  try {
    res = state.mode === 'have' ? await planDrop(S, D) : D ? await planTrip(S, D) : await planPickup(S);
  } catch (e) {
    console.error(e);
    res = { error: 'Something went wrong while planning. Try again.' };
  }
  if (seq !== state.planSeq) return;
  if (res.error) { clearResults(); hint(res.error, true); return; }
  Object.assign(state, { obvious: null, ...res });
  renderResults();
  select(0, true);
}

// ---------- UI: results ----------

function hint(text, isErr = false) {
  const h = $('hint');
  h.textContent = text;
  h.classList.toggle('err', isErr);
}

function clearResults() {
  state.ranked = [];
  state.kind = null;
  $('results').innerHTML = '';
  setMapCandidates();
  setRoute([]);
  drawRankMarkers();
  $('replan').hidden = true;
}

const mapsLink = (from, to, mode) => {
  const o = from && !from.gps ? `&origin=${from.lat},${from.lon}` : '';
  return `https://www.google.com/maps/dir/?api=1${o}&destination=${to.lat},${to.lon}&travelmode=${mode}`;
};
const link = (href, text, cls = '') => `<a${cls ? ` class="${cls}"` : ''} href="${esc(href)}" target="_blank" rel="noopener">${text}</a>`;

function cardHTML(r, i, S) {
  const D = state.to;
  const badges = [];
  let name, split, steps = '', actions;
  if (state.kind === 'pickup') {
    name = r.p.name;
    split = `Walk ${min(r.walkP.time)} min (${meters(r.walkP.dist)}) · ${availText(r.p)}`;
    actions = link(mapsLink(S, r.p, 'walking'), 'Walk there', 'primary') + (r.p.uri ? link(r.p.uri, 'Rent in app') : '');
  } else if (state.kind === 'drop') {
    name = r.s.name;
    split = `Ride ${min(r.ride.time)} min · walk ${min(r.walk.time)} min (${meters(r.walk.dist)})`;
    const closest = state.ranked.reduce((a, b) => (b.walk.time < a.walk.time ? b : a));
    if (r === closest) badges.push('<span class="badge">Closest to destination</span>');
    else if (i === 0 && closest.total - r.total >= 30) badges.push(`<span class="badge good">${min(closest.total - r.total)} min faster than the closest station</span>`);
    actions = link(mapsLink(S, r.s, 'bicycling'), 'Ride there', 'primary') + link(mapsLink(r.s, D, 'walking'), 'Walk from there');
  } else {
    name = `${r.p.name} → ${r.s.name}`;
    split = `Walk ${min(r.walkP.time)} · ride ${min(r.ride.time)} · walk ${min(r.walk.time)} min`;
    const o = state.obvious;
    if (i === 0 && o && o !== r && o.total - r.total >= 30) badges.push(`<span class="badge good">${min(o.total - r.total)} min faster than nearest bike + closest station</span>`);
    steps = `<ol class="steps">
      <li><span class="step-ico walk"></span><div><b>Walk ${min(r.walkP.time)} min</b> to ${esc(r.p.name)}<div class="step-sub">${esc(availText(r.p))}${r.p.uri ? ` · ${link(r.p.uri, 'Rent in app')}` : ''}</div></div></li>
      <li><span class="step-ico ride"></span><div><b>Ride ${min(r.ride.time)} min</b> to ${esc(r.s.name)}<div class="step-sub">${meters(r.ride.dist)}${state.type === 'ebike' ? ' by e-bike' : ''}</div></div></li>
      <li><span class="step-ico walk"></span><div><b>Walk ${min(r.walk.time)} min</b> to ${esc(D.label)}<div class="step-sub">${meters(r.walk.dist)}</div></div></li>
    </ol>`;
    actions = link(mapsLink(S, r.p, 'walking'), 'Walk to bike', 'primary') + link(mapsLink(r.p, r.s, 'bicycling'), 'Ride') + link(mapsLink(r.s, D, 'walking'), 'Walk');
  }
  if (r.ride && r.ride.time + PARK_S > INCLUDED_MIN * 60) badges.push(`<span class="badge warn">Ride over ${INCLUDED_MIN} min</span>`);
  return `<li class="card" data-i="${i}">
    <div class="card-top">
      <div class="rank${state.kind === 'pickup' ? ' pick' : ''}">${i + 1}</div>
      <div class="card-main">
        <div class="name">${esc(name)}</div>
        <div class="split">${esc(split)}</div>
      </div>
      <div class="total">${min(r.total)}<small> min</small></div>
    </div>
    ${badges.length ? `<div class="badges">${badges.join('')}</div>` : ''}
    ${steps}
    <div class="actions">${actions}</div>
  </li>`;
}

function renderResults() {
  const best = state.ranked[0];
  let msg = { pickup: `Nearest ${typeWord()}`, drop: 'Fastest drop-offs', trip: 'Fastest trips' }[state.kind];
  if (state.directWalk && min(state.directWalk.time) <= min(best.total)) {
    const w = min(state.directWalk.time);
    msg = `Walking straight there is ${w < min(best.total) ? 'faster' : 'just as fast'} (${w} min).`;
  } else if (state.estimated) {
    msg = 'Routing servers unavailable. Times are rough estimates.';
  }
  hint(msg);
  const S = startPoint();
  $('results').innerHTML = state.ranked.slice(0, 3).map((r, i) => cardHTML(r, i, S)).join('');
  $('replan').hidden = false;
  $('replan').textContent = state.from ? 'Plan from my location' : 'Re-plan from here';
  setMapCandidates();
}

function legsOf(r) {
  const S = startPoint(), D = state.to, ride = rideMode();
  if (state.kind === 'pickup') return [[S, r.p, 'walk']];
  if (state.kind === 'drop') return [[S, r.s, ride], [r.s, D, 'walk']];
  return [[S, r.p, 'walk'], [r.p, r.s, ride], [r.s, D, 'walk']];
}

async function select(i, fit = false) {
  state.sel = i;
  document.querySelectorAll('.card').forEach((c) => c.classList.toggle('sel', +c.dataset.i === i));
  drawRankMarkers();
  const legs = legsOf(state.ranked[i]);
  const ends = legs.flatMap(([a, b]) => [a, b]);
  if (fit) fitTo(ends);
  const seq = state.planSeq;
  const lines = await Promise.all(legs.map(([a, b, m]) => routeLine(a, b, m)));
  if (seq !== state.planSeq || state.sel !== i) return;
  setRoute(legs.map(([, , m], k) => ({ mode: m === 'walk' ? 'walk' : 'bike', coords: lines[k] })));
  fitTo([...ends, ...lines.flat().filter((_, k) => k % 8 === 0).map(([lon, lat]) => ({ lat, lon }))]);
}

$('results').addEventListener('click', (e) => {
  if (e.target.closest('a')) return;
  const card = e.target.closest('.card');
  if (card && +card.dataset.i !== state.sel) select(+card.dataset.i);
});

// ---------- mode + bike type ----------

function setSeg(id, v) {
  document.querySelectorAll(`#${id} button`).forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === v)));
}
for (const [id, key] of [['mode', 'mode'], ['type', 'type']]) {
  setSeg(id, state[key]);
  $(id).addEventListener('click', (e) => {
    const v = e.target.closest('button')?.dataset.v;
    if (!v || v === state[key]) return;
    state[key] = v;
    savePrefs();
    setSeg(id, v);
    setStationsOnMap();
    plan();
  });
}

// ---------- map ----------

const map = new maplibregl.Map({
  container: 'map', style: STYLE, center: MUC, zoom: 12.3, attributionControl: { compact: true },
});
const mapReady = new Promise((res) => map.on('load', res));
let rankMarkers = [], toMarker = null, startMarker = null, meMarker = null;
const EMPTY = { type: 'FeatureCollection', features: [] };
const ACCENT = '#0a6cff', PICK = '#12965a';
const fc = (features) => ({ type: 'FeatureCollection', features });
const point = (p, properties) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [p.lon, p.lat] }, properties });

mapReady.then(() => {
  document.querySelector('.maplibregl-ctrl-attrib')?.classList.remove('maplibregl-compact-show');
  for (const id of ['stations', 'areas', 'loose', 'cands', 'route']) map.addSource(id, { type: 'geojson', data: EMPTY });

  map.addLayer({ id: 'areas-fill', type: 'fill', source: 'areas', minzoom: 15, paint: { 'fill-color': ACCENT, 'fill-opacity': 0.28 } });
  map.addLayer({ id: 'areas-line', type: 'line', source: 'areas', minzoom: 15, paint: { 'line-color': ACCENT, 'line-width': ['interpolate', ['linear'], ['zoom'], 15, 1.5, 18, 3] } });

  map.addLayer({ id: 'route-bike-case', type: 'line', source: 'route', filter: ['==', ['get', 'mode'], 'bike'],
    layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#ffffff', 'line-width': 8 } });
  map.addLayer({ id: 'route-bike', type: 'line', source: 'route', filter: ['==', ['get', 'mode'], 'bike'],
    layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': ACCENT, 'line-width': 5 } });
  map.addLayer({ id: 'route-walk', type: 'line', source: 'route', filter: ['==', ['get', 'mode'], 'walk'],
    layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#e5372b', 'line-width': 4, 'line-dasharray': [0.1, 1.8] } });

  // Dots grow until street level, then shrink so the real parking zone underneath stays visible.
  const radius = ['interpolate', ['linear'], ['zoom'], 10, 3, 13, 6.5, 15, 11, 16.5, 11, 18, 7];
  // Need a bike: stations without a bike of the chosen type are drawn hollow.
  map.addLayer({ id: 'st', type: 'circle', source: 'stations', paint: {
    'circle-radius': radius, 'circle-color': ['case', ['get', 'empty'], '#ffffff', ACCENT], 'circle-opacity': 1,
    'circle-stroke-color': ['case', ['get', 'empty'], ACCENT, '#ffffff'], 'circle-stroke-opacity': 1,
    'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 10, 0.8, 14, 2],
  } });
  map.addLayer({ id: 'loose', type: 'circle', source: 'loose', minzoom: 13, paint: {
    'circle-radius': ['interpolate', ['linear'], ['zoom'], 13, 3, 16, 6], 'circle-color': PICK,
    'circle-stroke-color': '#ffffff', 'circle-stroke-width': 1.5,
  } });
  // Candidates of the current plan: green = where to pick up, blue = where to drop (faded beyond a 5 min walk).
  map.addLayer({ id: 'cand', type: 'circle', source: 'cands', paint: {
    'circle-radius': radius, 'circle-color': ['case', ['==', ['get', 'role'], 'pick'], PICK, ACCENT],
    'circle-opacity': ['case', ['all', ['==', ['get', 'role'], 'drop'], ['>', ['get', 'walk'], WALK_HILITE_S]], 0.6, 1],
    'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2,
  } });
  map.addLayer({ id: 'st-count', type: 'symbol', source: 'stations', minzoom: 14, layout: {
    'text-field': ['to-string', ['get', 'bikes']], 'text-font': ['Noto Sans Bold'], 'text-size': ['interpolate', ['linear'], ['zoom'], 14, 11, 16.5, 12, 18, 9], 'text-allow-overlap': true, 'text-ignore-placement': true,
  }, paint: { 'text-color': ['case', ['get', 'empty'], ACCENT, '#ffffff'] } });

  for (const l of ['st', 'cand', 'loose']) {
    map.on('click', l, (e) => placePopup(byKey(e.features[0].properties.k), e.lngLat));
    map.on('mouseenter', l, () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', l, () => { map.getCanvas().style.cursor = ''; });
  }
});

// Stations are "s<i>", loose bikes "l<i>" (indexes into state.stations / state.loose).
const byKey = (k) => (k[0] === 's' ? state.stations[+k.slice(1)] : state.loose[+k.slice(1)]);

function setStationsOnMap() {
  if (!map.getSource('stations') || !state.stations.length) return;
  const need = state.mode === 'need';
  map.getSource('stations').setData(fc(state.stations.map((s) => point(s, { k: s.key, bikes: avail(s), empty: need && avail(s) === 0 }))));
  map.getSource('areas').setData(fc(state.stations.filter((s) => s.area).map((s) => ({ type: 'Feature', geometry: s.area, properties: {} }))));
  map.getSource('loose').setData(fc(need ? state.loose.filter((b) => avail(b) > 0).map((b) => point(b, { k: b.key })) : []));
}

function setMapCandidates() {
  if (!map.getSource('cands')) return;
  const feats = [], seen = new Set();
  const add = (p, role, walk = 0) => { if (!seen.has(p.key + role)) { seen.add(p.key + role); feats.push(point(p, { k: p.key, role, walk })); } };
  for (const r of state.ranked) {
    if (r.p) add(r.p, 'pick');
    if (r.s) add(r.s, 'drop', r.walk.time);
  }
  map.getSource('cands').setData(fc(feats));
  // Dim the rest of the network while a plan is shown.
  map.setPaintProperty('st', 'circle-opacity', feats.length ? 0.3 : 1);
  map.setPaintProperty('st', 'circle-stroke-opacity', feats.length ? 0.3 : 1);
}

function setRoute(legs) {
  if (!map.getSource('route')) return;
  map.getSource('route').setData(fc(legs.map((l) => ({ type: 'Feature', geometry: { type: 'LineString', coordinates: l.coords }, properties: { mode: l.mode } }))));
}

function el(cls, html = '') { const d = document.createElement('div'); d.className = cls; d.innerHTML = html; return d; }
// MapLibre owns the marker element's transform, so the rotated teardrop lives inside a wrapper.
// The rotated tip pokes out below the box by (√2 - 1) * size / 2; the offset puts it on the point.
function pinEl(cls, size, html = '') {
  const w = el('pin-wrap', `<div class="pin ${cls}" style="width:${size}px;height:${size}px">${html}</div>`);
  w.style.width = w.style.height = `${size}px`;
  return { element: w, anchor: 'bottom', offset: [0, -Math.round(((Math.SQRT2 - 1) * size) / 2) - 2] };
}
const BIKE_SVG = '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="5.5" cy="16" r="3.5"/><circle cx="18.5" cy="16" r="3.5"/><path d="M5.5 16 9 8.5h6.5M12 16l-3-7.5M18.5 16 15 8.5M14 6h2.5"/></svg>';

function drawRankMarkers() {
  rankMarkers.forEach((m) => m.remove());
  rankMarkers = [];
  const top = state.ranked.slice(0, 3);
  const at = (r) => (state.kind === 'pickup' ? r.p : r.s);
  const cls = state.kind === 'pickup' ? 'pin-pick' : 'pin-rank';
  // unselected first, so the selected pin sits on top
  const order = top.map((r, i) => i).sort((a, b) => (a === state.sel) - (b === state.sel));
  for (const i of order) {
    const opts = i === state.sel ? pinEl(cls, 36, `<span>${i + 1}</span>`) : pinEl(`${cls} dim`, 28, `<span>${i + 1}</span>`);
    opts.element.addEventListener('click', (e) => { e.stopPropagation(); select(i); });
    rankMarkers.push(new maplibregl.Marker(opts).setLngLat([at(top[i]).lon, at(top[i]).lat]).addTo(map));
  }
  // full trip: also mark where to pick up the bike for the selected option
  const r = top[state.sel];
  if (state.kind === 'trip' && r) {
    const opts = pinEl('pin-pick', 34, `<span>${BIKE_SVG}</span>`);
    rankMarkers.push(new maplibregl.Marker(opts).setLngLat([r.p.lon, r.p.lat]).addTo(map));
  }
}

function drawPlaceMarkers() {
  toMarker?.remove(); startMarker?.remove(); toMarker = startMarker = null;
  if (state.to) toMarker = new maplibregl.Marker(pinEl('pin-to', 30)).setLngLat([state.to.lon, state.to.lat]).addTo(map);
  if (state.from) startMarker = new maplibregl.Marker({ element: el('start') }).setLngLat([state.from.lon, state.from.lat]).addTo(map);
}

function fitTo(points) {
  const pts = points.filter(Boolean);
  if (!pts.length) return;
  const b = new maplibregl.LngLatBounds();
  pts.forEach((p) => b.extend([p.lon, p.lat]));
  const top = $('panel').getBoundingClientRect().bottom + 56; // room for the pin above the point
  const bottom = $('sheet').getBoundingClientRect().height + 24;
  map.fitBounds(b, { padding: { top, bottom, left: 40, right: 40 }, maxZoom: 16.5, duration: 600 });
}

function popupHTML(title, sub, buttons) {
  return `<div class="pop-title">${esc(title)}</div>${sub ? `<div class="pop-sub">${esc(sub)}</div>` : ''}<div class="pop-btns">${buttons}</div>`;
}

let popup = null;
function showPopup(lngLat, html, handlers) {
  popup?.remove();
  popup = new maplibregl.Popup({ offset: 12, maxWidth: '280px' }).setLngLat(lngLat).setHTML(html).addTo(map);
  popup.getElement().addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act && handlers[act]) { handlers[act](); popup.remove(); }
  });
}

function placePopup(p, lngLat) {
  if (!p) return;
  const rent = p.uri ? `<a href="${esc(p.uri)}" target="_blank" rel="noopener">Rent in app</a>` : '';
  if (p.loose) {
    showPopup(lngLat, popupHTML(p.name, p.battery != null ? `${p.battery} % battery · parked outside a station` : 'Parked outside a station', rent), {});
    return;
  }
  const place = { lat: p.lat, lon: p.lon, label: p.name };
  showPopup(lngLat, popupHTML(p.name, `${availText(p, 'any')} here now`,
    `<button data-act="to">Go here</button><button data-act="from">Start here</button>${rent}`),
  { to: () => setTo(place), from: () => setFrom(place) });
}

async function pointMenu(lngLat) {
  const place = { lat: lngLat.lat, lon: lngLat.lng, label: 'Dropped pin' };
  showPopup(lngLat, popupHTML('Dropped pin', '', '<button data-act="to">Go here</button><button data-act="from">Start here</button>'),
    { to: () => setTo(place, false), from: () => setFrom(place) });
  try {
    const d = await getJSON(`${PHOTON}/reverse?lon=${place.lon}&lat=${place.lat}&lang=de`, {}, 6000);
    if (d.features?.[0]) {
      place.label = photonPlace(d.features[0]).label;
      if (state.to === place) $('to').value = place.label;
      if (state.from === place) $('from').value = place.label;
      popup?.getElement()?.querySelector('.pop-title')?.replaceChildren(place.label);
    }
  } catch { /* keep "Dropped pin" */ }
}

// Long-press on touch, right-click on desktop.
let lp = null;
map.on('touchstart', (e) => {
  clearTimeout(lp?.t);
  if (e.originalEvent.touches.length !== 1) { lp = null; return; }
  lp = { p: e.point, t: setTimeout(() => pointMenu(e.lngLat), 550) };
});
map.on('touchmove', (e) => { if (lp && (Math.abs(e.point.x - lp.p.x) > 10 || Math.abs(e.point.y - lp.p.y) > 10)) clearTimeout(lp.t); });
for (const ev of ['touchend', 'touchcancel', 'zoomstart']) map.on(ev, () => clearTimeout(lp?.t));
map.on('contextmenu', (e) => pointMenu(e.lngLat));

// ---------- start / destination ----------

function setTo(place, remember = true) {
  state.to = place;
  $('to').value = place.label;
  if (remember && place.label !== 'Dropped pin') saveRecent(place);
  closeSuggest();
  drawPlaceMarkers();
  plan();
}

function setFrom(place) {
  state.from = place;
  $('from').value = place ? place.label : '';
  $('from-gps').classList.toggle('on', !place);
  closeSuggest();
  drawPlaceMarkers();
  plan();
}

$('from-gps').addEventListener('click', () => { setFrom(null); if (state.gps) map.easeTo({ center: [state.gps.lon, state.gps.lat] }); });

$('swap').addEventListener('click', () => {
  const a = startPoint(), b = state.to;
  if (!a && !b) return;
  state.to = a ? { lat: a.lat, lon: a.lon, label: a.label } : null;
  state.from = b;
  $('to').value = state.to?.label ?? '';
  $('from').value = state.from?.label ?? '';
  $('from-gps').classList.toggle('on', !state.from);
  drawPlaceMarkers();
  plan();
});

$('replan').addEventListener('click', () => {
  if (state.from) { setFrom(null); return; }
  navigator.geolocation?.getCurrentPosition((p) => { onPos(p); plan(); }, () => plan(), { enableHighAccuracy: true, timeout: 8000 });
});

// ---------- search ----------

function photonPlace(f) {
  const p = f.properties;
  const [lon, lat] = f.geometry.coordinates;
  const street = [p.street, p.housenumber].filter(Boolean).join(' ');
  const label = p.name || street || p.district || p.city || 'Unnamed place';
  const sub = [p.name ? street : '', p.district || p.locality, p.city].filter((x) => x && x !== label).join(', ');
  return { lat, lon, label, sub };
}

// Photon is strict about how German street names are split. Rewrite the query the way OSM spells it:
//   Dachauerstr 163 -> Dachauer Straße 163   (street names from places, "-er", are two words)
//   Leopold Str 50  -> Leopoldstraße 50       (everything else is one word)
//   Karlspl / Rosenheimer Pl. -> ...platz
const L = 'A-Za-zÄÖÜäöüß';
const END = '(?=[\\s,\\d]|$)';
function queryVariant(q) {
  let v = q
    .replace(new RegExp(`(?<=[${L}])str(?:\\.|a(?:ss|s)e)?${END}`, 'gi'), 'straße')
    .replace(new RegExp(`(?<=[${L}])pl\\.?${END}`, 'gi'), 'platz')
    .replace(new RegExp(`(?<![${L}])(str\\.?|stra(?:ss|s)e)${END}`, 'gi'), 'Straße')
    .replace(new RegExp(`(?<![${L}])pl\\.?${END}`, 'gi'), 'Platz');
  v = v.replace(new RegExp(`([${L}]{3,}er)(straße|platz|weg|allee|ring|gasse)${END}`, 'gi'),
    (_, w, s) => `${w} ${s[0].toUpperCase()}${s.slice(1).toLowerCase()}`);
  v = v.replace(new RegExp(`(?<![-${L}])([${L}]{3,})\\s+(straße|platz|weg|allee|ring|gasse)${END}`, 'gi'),
    (m, w, s) => (/er$/i.test(w) ? m : w + s.toLowerCase()));
  return v;
}

async function photonSearch(q) {
  const near = state.to ?? state.gps ?? { lat: MUC[1], lon: MUC[0] };
  const d = await getJSON(`${PHOTON}/api/?q=${encodeURIComponent(q)}&lat=${near.lat}&lon=${near.lon}&limit=7&lang=de&bbox=${BBOX}`, {}, 8000);
  return d.features.map(photonPlace);
}

function dedupe(places) {
  const seen = new Set();
  return places.filter((p) => { const k = `${p.label}|${p.sub}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

// Original + respelled query in parallel; places carrying the typed house number go first.
async function searchPlaces(q) {
  const variant = queryVariant(q);
  const queries = variant.toLowerCase() === q.toLowerCase() ? [q] : [q, variant];
  const settled = await Promise.allSettled(queries.map(photonSearch));
  if (settled.every((r) => r.status === 'rejected')) throw settled[0].reason;
  const places = dedupe(settled.flatMap((r) => (r.status === 'fulfilled' ? r.value : [])));
  const num = q.match(/\b\d+\s?[a-z]?\b/i)?.[0].replace(/\s/g, '').toLowerCase();
  if (!num) return places.slice(0, 7);
  const hasNum = (p) => `${p.label} ${p.sub}`.toLowerCase().replace(/(\d)\s+([a-z])\b/g, '$1$2').split(/[\s,]+/).includes(num);
  return [...places.filter(hasNum), ...places.filter((p) => !hasNum(p))].slice(0, 7);
}

// Nominatim understands sloppy spellings better, but its policy forbids search-as-you-type:
// only called on an explicit search (Enter / "Search more thoroughly"), at most once per second.
let lastNominatim = 0;
async function nominatimSearch(q) {
  const wait = lastNominatim + 1100 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastNominatim = Date.now();
  const d = await getJSON(`${NOMINATIM}/search?q=${encodeURIComponent(q)}&format=jsonv2&limit=6&countrycodes=de`
    + `&viewbox=${NOMINATIM_VIEWBOX}&bounded=1&addressdetails=1&accept-language=de`, {}, 10000);
  return dedupe(d.map((x) => {
    const a = x.address ?? {};
    const street = [a.road ?? a.pedestrian ?? a.square, a.house_number].filter(Boolean).join(' ');
    const label = (x.name && x.name !== a.road ? x.name : street) || x.display_name.split(',')[0];
    const sub = [label !== street ? street : '', a.suburb ?? a.city_district, a.city ?? a.town ?? a.village]
      .filter((s) => s && s !== label).join(', ');
    return { lat: +x.lat, lon: +x.lon, label, sub };
  }));
}

// "Dachauerstr." finds "Dachauer Straße (Stiglmaierplatz)": compare without case, spaces and dots.
const squash = (s) => queryVariant(s).toLowerCase().replace(/ß/g, 'ss').replace(/[^a-z0-9äöü]/g, '');
function searchStations(q) {
  const n = squash(q);
  return state.stations.filter((s) => squash(s.name).includes(n)).slice(0, 3)
    .map((s) => ({ lat: s.lat, lon: s.lon, label: s.name, sub: `MyRadl station · ${availText(s, 'any')}` }));
}

let activeInput = null, suggestions = [], suggestSeq = 0, debounce = null;

function renderSuggest(groups) {
  suggestions = [];
  const html = groups.filter((g) => g.items.length).map((g) => {
    const head = g.title ? `<li class="tag" role="presentation">${esc(g.title)}</li>` : '';
    return head + g.items.map((it) => {
      const i = suggestions.push(it) - 1;
      return `<li role="option" data-i="${i}"><div class="s1">${esc(it.label)}</div>${it.sub ? `<div class="s2">${esc(it.sub)}</div>` : ''}</li>`;
    }).join('');
  }).join('');
  $('suggest').innerHTML = html;
  $('suggest').hidden = !html;
}

function closeSuggest() { $('suggest').hidden = true; suggestions = []; }

function pick(item) {
  if (item.more) { searchMore(item.q); return; }
  if (activeInput === 'from') setFrom(item.gps ? null : item);
  else setTo(item);
  document.activeElement?.blur();
}

function onInput(which) {
  activeInput = which;
  const q = $(which).value.trim();
  clearTimeout(debounce);
  const gpsItem = which === 'from' ? [{ label: 'My location', sub: 'Use GPS', gps: true }] : [];
  if (q.length < 2) {
    renderSuggest([{ items: gpsItem }, { title: 'Recent', items: which === 'to' ? loadRecent() : [] }]);
    return;
  }
  const seq = ++suggestSeq;
  const stations = searchStations(q);
  const more = [{ label: 'Search more thoroughly', sub: `“${q}”, or press Enter`, more: true, q }];
  renderSuggest([{ items: gpsItem }, { title: 'Stations', items: stations }]);
  debounce = setTimeout(async () => {
    let places = [];
    try { places = await searchPlaces(q); } catch (e) { console.warn('search', e); }
    if (seq === suggestSeq) {
      renderSuggest([{ items: gpsItem }, { items: places }, { title: 'Stations', items: stations }, { items: more }]);
    }
  }, 220);
}

async function searchMore(q) {
  const seq = ++suggestSeq;
  const gpsItem = activeInput === 'from' ? [{ label: 'My location', sub: 'Use GPS', gps: true }] : [];
  renderSuggest([{ items: [{ label: 'Searching…', sub: `“${q}”`, busy: true }] }]);
  let places = [];
  try { places = await nominatimSearch(q); } catch (e) { console.warn('nominatim', e); }
  if (seq !== suggestSeq) return;
  renderSuggest([{ items: gpsItem },
    { items: places.length ? places : [{ label: 'Nothing found', sub: 'Try a nearby street or place name', busy: true }] }]);
}

for (const which of ['from', 'to']) {
  const inp = $(which);
  inp.addEventListener('input', () => onInput(which));
  inp.addEventListener('focus', () => { inp.select(); onInput(which); });
  inp.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const q = inp.value.trim();
      const first = suggestions.find((s) => !s.gps && !s.more && !s.busy);
      if (first) pick(first);
      else if (q.length >= 2) { clearTimeout(debounce); activeInput = which; searchMore(q); }
    }
    if (e.key === 'Escape') { closeSuggest(); inp.blur(); }
  });
  inp.addEventListener('blur', () => setTimeout(() => {
    if (document.activeElement?.closest?.('#panel')) return;
    closeSuggest();
    // restore the chosen value if the user typed and walked away
    if (which === 'to') inp.value = state.to?.label ?? '';
    else inp.value = state.from?.label ?? '';
  }, 150));
}
$('suggest').addEventListener('pointerdown', (e) => e.preventDefault()); // keep focus, avoid blur race
$('suggest').addEventListener('click', (e) => {
  const li = e.target.closest('li[data-i]');
  if (li && !suggestions[+li.dataset.i].busy) pick(suggestions[+li.dataset.i]);
});

function loadRecent() {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY)) ?? []; } catch { return []; }
}
function saveRecent(place) {
  try {
    const list = [{ lat: place.lat, lon: place.lon, label: place.label, sub: place.sub ?? '' },
      ...loadRecent().filter((p) => p.label !== place.label)].slice(0, 6);
    localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  } catch { /* private mode: no recents */ }
}

// ---------- location ----------

function onPos(p) {
  const first = !state.gps;
  state.gps = { lat: p.coords.latitude, lon: p.coords.longitude };
  state.gpsError = null;
  if (!meMarker) meMarker = new maplibregl.Marker({ element: el('me') }).setLngLat([state.gps.lon, state.gps.lat]).addTo(map);
  else meMarker.setLngLat([state.gps.lon, state.gps.lat]);
  if (first && !state.from) {
    if (state.to || state.mode === 'need') plan(); // need a bike: show the nearest ones right away
    else map.easeTo({ center: [state.gps.lon, state.gps.lat], zoom: 14.5 });
  }
}

if (navigator.geolocation) {
  navigator.geolocation.watchPosition(onPos, (e) => {
    state.gpsError = e.message || 'denied';
    if (!state.from) plan();
  }, { enableHighAccuracy: true, maximumAge: 15000 });
} else {
  state.gpsError = 'unsupported';
}
$('from-gps').classList.add('on');

// ---------- stations + bikes ----------

const IOS = /iPhone|iPad|iPod/.test(navigator.userAgent);
const rentUri = (u) => (u ? (IOS ? u.ios : u.android) ?? u.web : null);

// Counts per type come from station_status; battery levels and loose bikes from free_bike_status.
function applyStatus(status, free) {
  const st = new Map(status.data.stations.map((s) => [s.station_id, s]));
  const best = new Map(); // station_id -> best e-bike battery %
  state.loose = [];
  for (const b of free.data.bikes) {
    if (b.is_reserved || b.is_disabled) continue;
    const kind = state.vehicleKind[b.vehicle_type_id] ?? 'bike';
    const battery = b.current_fuel_percent != null ? Math.round(b.current_fuel_percent * 100) : null;
    if (b.station_id) {
      if (kind === 'ebike' && battery != null) best.set(b.station_id, Math.max(best.get(b.station_id) ?? 0, battery));
    } else {
      state.loose.push({
        key: `l${state.loose.length}`, loose: true, lat: b.lat, lon: b.lon, battery: kind === 'ebike' ? battery : null,
        name: kind === 'ebike' ? 'Loose e-bike' : 'Loose bike', n: { bike: +(kind === 'bike'), ebike: +(kind === 'ebike') }, uri: rentUri(b.rental_uris),
      });
    }
  }
  for (const s of state.stations) {
    const x = st.get(s.id) ?? {};
    s.n = { bike: 0, ebike: 0 };
    for (const t of x.vehicle_types_available ?? []) s.n[state.vehicleKind[t.vehicle_type_id] ?? 'bike'] += t.count;
    s.battery = best.get(s.id) ?? null;
    s.renting = x.is_renting !== false && x.is_installed !== false;
    s.returning = x.is_returning !== false && x.is_installed !== false;
  }
  state.statusAt = Date.now();
}

async function loadStations() {
  const [info, status, free, types] = await Promise.all([
    getJSON(`${GBFS}/station_information.json`), getJSON(`${GBFS}/station_status.json`),
    getJSON(`${GBFS}/free_bike_status.json`), getJSON(`${GBFS}/vehicle_types.json`).catch(() => null),
  ]);
  state.vehicleKind = { 348: 'ebike' };
  for (const t of types?.data?.vehicle_types ?? []) state.vehicleKind[t.vehicle_type_id] = t.propulsion_type === 'human' ? 'bike' : 'ebike';
  state.stations = info.data.stations.map((s, i) => ({
    i, key: `s${i}`, id: s.station_id, name: s.name, lat: s.lat, lon: s.lon, area: s.station_area, uri: rentUri(s.rental_uris),
  }));
  applyStatus(status, free);
}

async function refreshStatus() {
  if (Date.now() - state.statusAt < STATUS_TTL_MS) return;
  try {
    const [status, free] = await Promise.all([getJSON(`${GBFS}/station_status.json`), getJSON(`${GBFS}/free_bike_status.json`)]);
    applyStatus(status, free);
    setStationsOnMap();
  } catch (e) { console.warn('status refresh', e); }
}

// Keep map controls above the bottom sheet.
new ResizeObserver(([e]) => {
  document.documentElement.style.setProperty('--sheet-h', `${e.target.getBoundingClientRect().height}px`);
}).observe($('sheet'));

(async () => {
  try {
    await Promise.all([loadStations(), mapReady]);
    setStationsOnMap();
    const n = state.stations.reduce((a, s) => ({ bike: a.bike + s.n.bike, ebike: a.ebike + s.n.ebike }), { bike: 0, ebike: 0 });
    hint(`${state.stations.length} stations · ${n.bike.toLocaleString('de')} bikes · ${n.ebike.toLocaleString('de')} e-bikes`);
    plan();
  } catch (e) {
    console.error(e);
    hint('Could not load MyRadl stations. Check your connection and reload.', true);
  }
})();

window.radl = { map, state }; // for poking around in devtools
