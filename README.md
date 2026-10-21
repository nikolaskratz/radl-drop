# Radl Drop

Finds the fastest MyRadl (MVG/MVV bike share, run by nextbike) drop-off station for a destination in
Munich: the station with the lowest **ride to station + walk to destination** (+1 min to park).

Static site, no build step, no API keys. Everything runs in the browser:

| What | Source |
|---|---|
| Stations, parking zones, bike counts | nextbike GBFS `nextbike_ml` (CC0) |
| Ride / walk times | Valhalla on FOSSGIS (`valhalla1.openstreetmap.de`), OSRM FOSSGIS as fallback |
| Address search | Photon (komoot) |
| Map | MapLibre GL + OpenFreeMap Positron tiles |

How it ranks: take up to 40 stations near the destination (all within 1.5 km straight line, at least the
nearest 6), get ride times start → each station and walk times each station → destination in two matrix
calls, sort by total. Tuning constants are at the top of `app.js` (city-bike speed 16 km/h, 1 min parking).

Run locally: `python3 -m http.server 8765` in this folder, open http://127.0.0.1:8765
(GPS only works on localhost or HTTPS).
