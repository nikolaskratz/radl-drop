// Radl Drop: fastest MyRadl drop-off station = min(ride to station + walk to destination).
// Everything runs in the browser against public, CORS-open APIs (no keys):
//   stations  nextbike GBFS (MyRadl system "nextbike_ml", CC0)
//   routing   Valhalla on FOSSGIS servers, OSRM FOSSGIS as fallback
//   search    Photon (komoot), map tiles OpenFreeMap

const GBFS = 'https://gbfs.nextbike.net/maps/gbfs/v2/nextbike_ml/de';
const VALHALLA = 'https://valhalla1.openstreetmap.de';
const OSRM = 'https://routing.openstreetmap.de';
const PHOTON = 'https://photon.komoot.io';
const STYLE = 'https://tiles.openfreemap.org/styles/positron';
const MUC = [11.5755, 48.1374];
const BBOX = '10.8,47.75,12.2,48.5';

const MAX_WALK_M = 1500;   // stations considered around the destination (straight line)
const MAX_CANDS = 40;      // Valhalla matrix handles 50 fine
const MIN_CANDS = 6;       // always try at least the nearest few, even if further away
const PARK_S = 60;         // finding the zone + locking + ending the rental
const INCLUDED_MIN = 30;   // ride time covered by the fixed price
const WALK_HILITE_S = 300; // highlight stations within a 5 min walk of the destination
const BIKE_COSTING = { bicycle: { bicycle_type: 'City', cycling_speed: 16 } };
const RECENT_KEY = 'radl-drop.recent';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const min = (s) => Math.max(1, Math.round(s / 60));
const meters = (m) => (m < 950 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1)} km`);

const state = {
  stations: [],
  gps: null,         // {lat, lon} from watchPosition
  gpsError: null,
  from: null,        // null = use GPS, else {lat, lon, label}
  to: null,          // {lat, lon, label}
  ranked: [],        // all evaluated candidates, best first
  sel: 0,
  planSeq: 0,
};

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

// ---------- routing ----------

// Returns matrix[i][j] = {time (s), dist (m)} or null, sources x targets.
async function valhallaMatrix(sources, targets, costing) {
  const body = { sources: sources.map(loc), targets: targets.map(loc), costing, units: 'kilometers' };
  if (costing === 'bicycle') body.costing_options = BIKE_COSTING;
  const d = await getJSON(`${VALHALLA}/sources_to_targets`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return d.sources_to_targets.map((row) => row.map((c) => (c.time == null ? null : { time: c.time, dist: c.distance * 1000 })));
}

async function osrmMatrix(sources, targets, profile) {
  const pts = [...sources, ...targets];
  const coords = pts.map((p) => `${p.lon.toFixed(6)},${p.lat.toFixed(6)}`).join(';');
  const src = sources.map((_, i) => i).join(';');
  const dst = targets.map((_, j) => sources.length + j).join(';');
  const d = await getJSON(`${OSRM}/routed-${profile}/table/v1/driving/${coords}?sources=${src}&destinations=${dst}&annotations=duration,distance`);
  return d.durations.map((row, i) => row.map((t, j) => (t == null ? null : { time: t, dist: d.distances[i][j] })));
}

function crowMatrix(sources, targets, mps) {
  return sources.map((a) => targets.map((b) => { const dist = haversine(a, b) * 1.3; return { time: dist / mps, dist }; }));
}

async function matrix(sources, targets, mode) {
  try { return { m: await valhallaMatrix(sources, targets, mode === 'bike' ? 'bicycle' : 'pedestrian'), src: 'valhalla' }; }
  catch (e) { console.warn('valhalla matrix', e); }
  try { return { m: await osrmMatrix(sources, targets, mode === 'bike' ? 'bike' : 'foot'), src: 'osrm' }; }
  catch (e) { console.warn('osrm matrix', e); }
  return { m: crowMatrix(sources, targets, mode === 'bike' ? 4.4 : 1.4), src: 'estimate' };
}

async function routeLine(a, b, mode) {
  try {
    const body = { locations: [loc(a), loc(b)], costing: mode === 'bike' ? 'bicycle' : 'pedestrian' };
    if (mode === 'bike') body.costing_options = BIKE_COSTING;
    const d = await getJSON(`${VALHALLA}/route`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return d.trip.legs.flatMap((l) => decodePolyline6(l.shape));
  } catch (e) { console.warn('valhalla route', e); }
  try {
    const d = await getJSON(`${OSRM}/routed-${mode === 'bike' ? 'bike' : 'foot'}/route/v1/driving/${a.lon},${a.lat};${b.lon},${b.lat}?overview=full&geometries=geojson`);
    return d.routes[0].geometry.coordinates;
  } catch (e) { console.warn('osrm route', e); }
  return [[a.lon, a.lat], [b.lon, b.lat]];
}

// ---------- planning ----------

function candidates(D) {
  const withDist = state.stations.filter((s) => s.returning).map((s) => ({ s, d: haversine(D, s) }));
  withDist.sort((x, y) => x.d - y.d);
  const near = withDist.filter((x, i) => x.d <= MAX_WALK_M || i < MIN_CANDS).slice(0, MAX_CANDS);
  return near.filter((x) => x.d < 5000).map((x) => x.s);
}

async function plan() {
  const D = state.to;
  if (!D) return;
  const S = startPoint();
  if (!S) {
    hint(state.gpsError ? 'Location is blocked. Type a start address above.' : 'Waiting for your location…', !!state.gpsError);
    return;
  }
  if (!state.stations.length) { hint('Loading stations…'); return; }

  const seq = ++state.planSeq;
  hint('Finding the fastest drop-off…');
  const cands = candidates(D);
  if (!cands.length) { clearResults(); hint('No MyRadl station within 5 km of this destination.', true); return; }

  // Walking matrix: every candidate -> D, plus S -> D (if close) to tell when walking beats riding.
  const walkDirect = haversine(S, D) < 3000;
  const walkSources = walkDirect ? [...cands, S] : cands;
  const [ride, walk] = await Promise.all([matrix([S], cands, 'bike'), matrix(walkSources, [D], 'walk')]);
  if (seq !== state.planSeq) return;

  state.ranked = cands
    .map((s, i) => ({ s, ride: ride.m[0][i], walk: walk.m[i][0] }))
    .filter((r) => r.ride && r.walk)
    .map((r) => ({ ...r, total: r.ride.time + r.walk.time + PARK_S }))
    .sort((a, b) => a.total - b.total);
  state.directWalk = walkDirect ? walk.m[cands.length][0] : null;
  state.estimated = ride.src === 'estimate' || walk.src === 'estimate';

  if (!state.ranked.length) { clearResults(); hint('Could not route to any nearby station.', true); return; }
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
  $('results').innerHTML = '';
  setMapCandidates([]);
  setRoute(null);
  rankMarkers.forEach((m) => m.remove());
  rankMarkers = [];
  $('replan').hidden = true;
}

const mapsLink = (from, to, mode) => {
  const o = from && !from.gps ? `&origin=${from.lat},${from.lon}` : '';
  return `https://www.google.com/maps/dir/?api=1${o}&destination=${to.lat},${to.lon}&travelmode=${mode}`;
};

function renderResults() {
  const top = state.ranked.slice(0, 3);
  const closest = state.ranked.reduce((a, b) => (b.walk.time < a.walk.time ? b : a));
  const best = state.ranked[0];
  const S = startPoint();

  let msg = '';
  if (state.directWalk && min(state.directWalk.time) <= min(best.total)) {
    const w = min(state.directWalk.time);
    msg = `Walking straight there is ${w < min(best.total) ? 'faster' : 'just as fast'} (${w} min).`;
  } else if (state.estimated) {
    msg = 'Routing servers unavailable. Times are rough estimates.';
  }
  hint(msg || 'Fastest drop-offs');

  $('results').innerHTML = top.map((r, i) => {
    const badges = [];
    if (r === closest) badges.push('<span class="badge">Closest to destination</span>');
    else if (i === 0 && closest.total - r.total >= 30) {
      badges.push(`<span class="badge good">${min(closest.total - r.total)} min faster than the closest station</span>`);
    }
    if (r.ride.time + PARK_S > INCLUDED_MIN * 60) badges.push(`<span class="badge warn">Ride over ${INCLUDED_MIN} min</span>`);
    return `<li class="card" data-i="${i}">
      <div class="card-top">
        <div class="rank">${i + 1}</div>
        <div class="card-main">
          <div class="name">${esc(r.s.name)}</div>
          <div class="split">Ride ${min(r.ride.time)} min · walk ${min(r.walk.time)} min (${meters(r.walk.dist)})</div>
        </div>
        <div class="total">${min(r.total)}<small> min</small></div>
      </div>
      ${badges.length ? `<div class="badges">${badges.join('')}</div>` : ''}
      <div class="actions">
        <a class="primary" href="${mapsLink(S, r.s, 'bicycling')}" target="_blank" rel="noopener">Ride there</a>
        <a href="${mapsLink(r.s, state.to, 'walking')}" target="_blank" rel="noopener">Walk from there</a>
      </div>
    </li>`;
  }).join('');

  $('replan').hidden = false;
  $('replan').textContent = state.from ? 'Plan from my location' : 'Re-plan from here';
  setMapCandidates(state.ranked);
}

async function select(i, fit = false) {
  state.sel = i;
  document.querySelectorAll('.card').forEach((c) => c.classList.toggle('sel', +c.dataset.i === i));
  drawRankMarkers();
  const r = state.ranked[i];
  const S = startPoint();
  if (fit) fitTo([S, r.s, state.to]);
  const seq = state.planSeq;
  const [bike, walk] = await Promise.all([routeLine(S, r.s, 'bike'), routeLine(r.s, state.to, 'walk')]);
  if (seq !== state.planSeq || state.sel !== i) return;
  setRoute({ bike, walk });
  fitTo([S, r.s, state.to, ...[...bike, ...walk].filter((_, k) => k % 8 === 0).map(([lon, lat]) => ({ lat, lon }))]);
}

$('results').addEventListener('click', (e) => {
  if (e.target.closest('a')) return;
  const card = e.target.closest('.card');
  if (card && +card.dataset.i !== state.sel) select(+card.dataset.i);
});

// ---------- map ----------

const map = new maplibregl.Map({
  container: 'map', style: STYLE, center: MUC, zoom: 12.3, attributionControl: { compact: true },
});
const mapReady = new Promise((res) => map.on('load', res));
let rankMarkers = [], toMarker = null, startMarker = null, meMarker = null;
const EMPTY = { type: 'FeatureCollection', features: [] };

mapReady.then(() => {
  document.querySelector('.maplibregl-ctrl-attrib')?.classList.remove('maplibregl-compact-show');
  const accent = '#0a6cff';
  map.addSource('stations', { type: 'geojson', data: EMPTY });
  map.addSource('areas', { type: 'geojson', data: EMPTY });
  map.addSource('cands', { type: 'geojson', data: EMPTY });
  map.addSource('route', { type: 'geojson', data: EMPTY });

  map.addLayer({ id: 'areas-fill', type: 'fill', source: 'areas', minzoom: 15, paint: { 'fill-color': accent, 'fill-opacity': 0.28 } });
  map.addLayer({ id: 'areas-line', type: 'line', source: 'areas', minzoom: 15, paint: { 'line-color': accent, 'line-width': ['interpolate', ['linear'], ['zoom'], 15, 1.5, 18, 3] } });

  map.addLayer({ id: 'route-bike-case', type: 'line', source: 'route', filter: ['==', ['get', 'mode'], 'bike'],
    layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#ffffff', 'line-width': 8 } });
  map.addLayer({ id: 'route-bike', type: 'line', source: 'route', filter: ['==', ['get', 'mode'], 'bike'],
    layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': accent, 'line-width': 5 } });
  map.addLayer({ id: 'route-walk', type: 'line', source: 'route', filter: ['==', ['get', 'mode'], 'walk'],
    layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#e5372b', 'line-width': 4, 'line-dasharray': [0.1, 1.8] } });

  // Dots grow until street level, then shrink so the real parking zone underneath stays visible.
  const radius = ['interpolate', ['linear'], ['zoom'], 10, 3, 13, 6.5, 15, 11, 16.5, 11, 18, 7];
  map.addLayer({ id: 'st', type: 'circle', source: 'stations', paint: {
    'circle-radius': radius, 'circle-color': accent, 'circle-opacity': 1,
    'circle-stroke-color': '#ffffff', 'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 10, 0.8, 14, 2], 'circle-stroke-opacity': 1,
  } });
  // Candidates near the destination: strong if within a 5 min walk, else mid.
  map.addLayer({ id: 'cand', type: 'circle', source: 'cands', paint: {
    'circle-radius': radius, 'circle-color': ['case', ['<=', ['get', 'walk'], WALK_HILITE_S], '#12965a', accent],
    'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2,
  } });
  map.addLayer({ id: 'st-count', type: 'symbol', source: 'stations', minzoom: 14, layout: {
    'text-field': ['to-string', ['get', 'bikes']], 'text-font': ['Noto Sans Bold'], 'text-size': ['interpolate', ['linear'], ['zoom'], 14, 11, 16.5, 12, 18, 9], 'text-allow-overlap': true, 'text-ignore-placement': true,
  }, paint: { 'text-color': '#ffffff' } });

  map.on('click', 'st', (e) => stationPopup(state.stations[e.features[0].properties.i], e.lngLat));
  map.on('click', 'cand', (e) => stationPopup(state.stations[e.features[0].properties.i], e.lngLat));
  for (const l of ['st', 'cand']) {
    map.on('mouseenter', l, () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', l, () => { map.getCanvas().style.cursor = ''; });
  }
});

function setStationsOnMap() {
  const pts = state.stations.map((s, i) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [s.lon, s.lat] }, properties: { i, bikes: s.bikes } }));
  const areas = state.stations.filter((s) => s.area).map((s) => ({ type: 'Feature', geometry: s.area, properties: {} }));
  map.getSource('stations').setData({ type: 'FeatureCollection', features: pts });
  map.getSource('areas').setData({ type: 'FeatureCollection', features: areas });
}

function setMapCandidates(ranked) {
  if (!map.getSource('cands')) return;
  map.getSource('cands').setData({ type: 'FeatureCollection', features: ranked.map((r) => ({
    type: 'Feature', geometry: { type: 'Point', coordinates: [r.s.lon, r.s.lat] }, properties: { i: r.s.i, walk: r.walk.time },
  })) });
  // Dim the rest of the network while a plan is shown.
  map.setPaintProperty('st', 'circle-opacity', ranked.length ? 0.3 : 1);
  map.setPaintProperty('st', 'circle-stroke-opacity', ranked.length ? 0.3 : 1);
}

function setRoute(r) {
  if (!map.getSource('route')) return;
  map.getSource('route').setData(!r ? EMPTY : { type: 'FeatureCollection', features: [
    { type: 'Feature', geometry: { type: 'LineString', coordinates: r.bike }, properties: { mode: 'bike' } },
    { type: 'Feature', geometry: { type: 'LineString', coordinates: r.walk }, properties: { mode: 'walk' } },
  ] });
}

function el(cls, html = '') { const d = document.createElement('div'); d.className = cls; d.innerHTML = html; return d; }
// MapLibre owns the marker element's transform, so the rotated teardrop lives inside a wrapper.
// The rotated tip pokes out below the box by (√2 - 1) * size / 2; the offset puts it on the point.
function pinEl(cls, size, html = '') {
  const w = el('pin-wrap', `<div class="pin ${cls}" style="width:${size}px;height:${size}px">${html}</div>`);
  w.style.width = w.style.height = `${size}px`;
  return { element: w, anchor: 'bottom', offset: [0, -Math.round(((Math.SQRT2 - 1) * size) / 2) - 2] };
}

function drawRankMarkers() {
  rankMarkers.forEach((m) => m.remove());
  rankMarkers = state.ranked.slice(0, 3).map((r, i) => {
    const opts = i === state.sel ? pinEl('pin-rank', 36, `<span>${i + 1}</span>`) : pinEl('pin-rank dim', 28, `<span>${i + 1}</span>`);
    opts.element.addEventListener('click', (e) => { e.stopPropagation(); select(i); });
    return new maplibregl.Marker(opts).setLngLat([r.s.lon, r.s.lat]).addTo(map);
  }).reverse();
  // the selected pin should sit on top
  const selM = rankMarkers[rankMarkers.length - 1 - state.sel];
  if (selM) selM.getElement().style.zIndex = 2;
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

function stationPopup(s, lngLat) {
  const place = { lat: s.lat, lon: s.lon, label: s.name };
  showPopup(lngLat, popupHTML(s.name, `${s.bikes} bike${s.bikes === 1 ? '' : 's'} here now`,
    `<button data-act="to">Go here</button><button data-act="from">Start here</button>${s.uri ? `<a href="${esc(s.uri)}" target="_blank" rel="noopener">Rent in app</a>` : ''}`),
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
  if (state.to) plan(); else clearResults();
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

async function searchPlaces(q) {
  const near = state.to ?? state.gps ?? { lat: MUC[1], lon: MUC[0] };
  const d = await getJSON(`${PHOTON}/api/?q=${encodeURIComponent(q)}&lat=${near.lat}&lon=${near.lon}&limit=7&lang=de&bbox=${BBOX}`, {}, 8000);
  const seen = new Set();
  return d.features.map(photonPlace).filter((p) => { const k = `${p.label}|${p.sub}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

function searchStations(q) {
  const n = q.toLowerCase();
  return state.stations.filter((s) => s.name.toLowerCase().includes(n)).slice(0, 3)
    .map((s) => ({ lat: s.lat, lon: s.lon, label: s.name, sub: `MyRadl station · ${s.bikes} bikes` }));
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
  renderSuggest([{ items: gpsItem }, { title: 'Stations', items: stations }]);
  debounce = setTimeout(async () => {
    try {
      const places = await searchPlaces(q);
      if (seq === suggestSeq) renderSuggest([{ items: gpsItem }, { items: places }, { title: 'Stations', items: stations }]);
    } catch (e) { console.warn('search', e); }
  }, 220);
}

for (const which of ['from', 'to']) {
  const inp = $(which);
  inp.addEventListener('input', () => onInput(which));
  inp.addEventListener('focus', () => { inp.select(); onInput(which); });
  inp.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && suggestions.length) { e.preventDefault(); pick(suggestions.find((s) => !s.gps) ?? suggestions[0]); }
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
  if (li) pick(suggestions[+li.dataset.i]);
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
  if (first) {
    if (!state.to) map.easeTo({ center: [state.gps.lon, state.gps.lat], zoom: 14.5 });
    else if (!state.from) plan();
  }
}

if (navigator.geolocation) {
  navigator.geolocation.watchPosition(onPos, (e) => {
    state.gpsError = e.message || 'denied';
    if (state.to && !state.from) plan();
  }, { enableHighAccuracy: true, maximumAge: 15000 });
} else {
  state.gpsError = 'unsupported';
}
$('from-gps').classList.add('on');

// ---------- stations ----------

async function loadStations() {
  const [info, status] = await Promise.all([getJSON(`${GBFS}/station_information.json`), getJSON(`${GBFS}/station_status.json`)]);
  const st = new Map(status.data.stations.map((s) => [s.station_id, s]));
  state.stations = info.data.stations.map((s, i) => {
    const x = st.get(s.station_id) ?? {};
    return {
      i, id: s.station_id, name: s.name, lat: s.lat, lon: s.lon, area: s.station_area,
      bikes: x.num_bikes_available ?? 0, returning: x.is_returning !== false && x.is_installed !== false, uri: s.rental_uris?.web,
    };
  });
}

// Keep map controls and the button above the bottom sheet.
new ResizeObserver(([e]) => {
  document.documentElement.style.setProperty('--sheet-h', `${e.target.getBoundingClientRect().height}px`);
}).observe($('sheet'));

(async () => {
  try {
    await Promise.all([loadStations(), mapReady]);
    setStationsOnMap();
    if (!state.to) hint(`${state.stations.length} MyRadl stations. Search a destination, or long-press the map.`);
    plan();
  } catch (e) {
    console.error(e);
    hint('Could not load MyRadl stations. Check your connection and reload.', true);
  }
})();

window.radl = { map, state }; // for poking around in devtools
