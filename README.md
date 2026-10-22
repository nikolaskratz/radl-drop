# Radl Drop

Trip planner for MyRadl (MVG/MVV bike share, run by nextbike) in Munich:

- **Need a bike**: nearest bikes from where you are; with a destination, the best combination of
  **walk to bike + ride + walk from the drop-off station** (+1 min each to rent and to park).
- **On a bike**: the drop-off station with the lowest **ride to station + walk to destination**.
- Filter **All / Bike / E-bike**: picks only stations with that type, e-bikes ride at 20 km/h instead of 16,
  battery of the best e-bike is shown. Bikes parked outside stations count as pickups too.
- **Saved places**: Home / Work / favourites as one-tap buttons; the star next to the destination saves it.
- **Bike still there?** While a pickup is shown, counts refresh every 30 s and on returning to the app;
  if the chosen bike is gone a banner offers the next best. Stops once you have reached the bike.
- **Arriving**: within 120 m of the pickup or drop-off the map zooms onto that station's zone
  (selected zones are drawn bold: green = pick up, blue = park).
- **Fast start**: the station list + zones are cached on the phone (refreshed every 12 h in the background);
  a normal launch only waits for the 5 KB of live counts and the phone's last known position.
  Battery levels and loose bikes fill in afterwards. Slow 4G: first result 2.2 s → 0.9 s.
- Bump the `?v=` on `app.js` / `style.css` in `index.html` with every deploy (phones cache the old files).

Static site, no build step, no API keys. Everything runs in the browser:

| What | Source |
|---|---|
| Stations, parking zones, bikes per type, e-bike battery, loose bikes | nextbike GBFS `nextbike_ml` (CC0) |
| Ride / walk times | Valhalla on FOSSGIS (`valhalla1.openstreetmap.de`), OSRM FOSSGIS as fallback |
| Address search | Photon (komoot) while typing, Nominatim on Enter |
| Map | MapLibre GL + OpenFreeMap Positron tiles |

How it ranks: take up to 40 drop-off stations near the destination (within 1.5 km straight line, at least
the nearest 6) and up to 12 pickups near the start (within 1 km, at least 4). Walk times come from two
matrix calls; for a full trip the 5 best pickups × 20 best drop-offs (Valhalla's 100-cell matrix limit) then
get one ride matrix, and every combination is summed and sorted. The nearest bike and the closest station
always stay in the shortlist. Bike counts refresh when older than a minute. Tuning constants are at the
top of `app.js`.

Run locally: `python3 -m http.server 8765` in this folder, open http://127.0.0.1:8765
(GPS only works on localhost or HTTPS).
