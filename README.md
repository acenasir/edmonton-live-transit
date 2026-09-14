# Edmonton Live Transit

Every Edmonton Transit Service (ETS) bus and LRT train, live, animated over a satellite map of Edmonton.
Inspired by the "every train in Berlin" style live maps, built entirely on City of Edmonton open data.

## How it works

- **`api/vehicles.js`** — a Vercel serverless function that fetches the City of Edmonton
  [GTFS-realtime Vehicle Positions](https://data.edmonton.ca/Transit/Real-Time-Vehicle-Position-GTFS-PB-File-/uyt2-vrrn)
  protobuf feed (`gtfs.edmonton.ca/TMGTFSRealTimeWebService/Vehicle/VehiclePositions.pb`), decodes it with
  `gtfs-realtime-bindings`, and returns compact JSON. Responses are edge-cached for 5 seconds so any number of
  viewers hit the City's server at most once every few seconds.
- **`api/alerts.js`** — same idea for the service alerts feed.
- **`public/`** — a static [MapLibre GL](https://maplibre.org) front end. It polls the API every 6 seconds and
  tweens each vehicle from its previous position to its new one, so the map moves smoothly instead of jumping.
  Each vehicle is drawn as a pill in its official route colour (from the static GTFS `routes.txt`), with a small
  heading arrow when the vehicle is moving. Click any vehicle for route, speed, heading and last-report time.
- **`public/data/routes.json`** and **`public/data/lrt.geojson`** — generated from the static GTFS extract
  (`gtfs.edmonton.ca/TMGTFSRealTimeWebService/GTFS/gtfs.zip`) by `scripts/build-static.ps1`. The GeoJSON holds the
  Capital, Metro and Valley Line alignments, simplified with Douglas-Peucker.

Basemaps: Esri World Imagery (satellite) with an optional CARTO Dark Matter toggle.

## Run locally

```bash
npm install
npx vercel dev
```

Then open http://localhost:3000.

## Regenerating the static data

Download the GTFS zip into `_data/gtfs.zip`, extract it to `_data/gtfs/`, and run `scripts/build-static.ps1`
(PowerShell). This rewrites `public/data/routes.json` and `public/data/lrt.geojson`.

## Data & licences

Transit data © City of Edmonton, provided under the
[City of Edmonton Open Data Terms of Use](https://data.edmonton.ca/stories/s/City-of-Edmonton-Open-Data-Terms-of-Use/msh8-if28/).
The feed covers ETS plus regional partners (St. Albert, Strathcona County, Spruce Grove, Fort Saskatchewan,
Beaumont and Leduc transit). Code is MIT licensed.
