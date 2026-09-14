// Decodes the City of Edmonton GTFS-realtime VehiclePositions protobuf feed
// and returns it as compact JSON for the map front end.
// Source: https://data.edmonton.ca/Transit/Real-Time-Vehicle-Position-GTFS-PB-File-/uyt2-vrrn
const { transit_realtime } = require('gtfs-realtime-bindings');

const FEED_URL = 'https://gtfs.edmonton.ca/TMGTFSRealTimeWebService/Vehicle/VehiclePositions.pb';

function num(v) {
  if (v == null) return null;
  if (typeof v === 'object' && typeof v.toNumber === 'function') return v.toNumber();
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function round(v, d) {
  if (v == null) return null;
  const f = Math.pow(10, d);
  return Math.round(v * f) / f;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
    const upstream = await fetch(FEED_URL, {
      headers: { 'User-Agent': 'edmonton-live-transit (github)' },
      signal: AbortSignal.timeout(8000),
    });
    if (!upstream.ok) throw new Error(`upstream responded ${upstream.status}`);
    const buf = Buffer.from(await upstream.arrayBuffer());
    const feed = transit_realtime.FeedMessage.decode(buf);

    const vehicles = [];
    for (const entity of feed.entity) {
      const v = entity.vehicle;
      if (!v || !v.position) continue;
      const lat = num(v.position.latitude);
      const lon = num(v.position.longitude);
      if (!lat || !lon) continue;
      vehicles.push({
        id: entity.id,
        vid: v.vehicle ? v.vehicle.id || null : null,
        label: v.vehicle ? v.vehicle.label || null : null,
        route: v.trip ? v.trip.routeId || null : null,
        trip: v.trip ? v.trip.tripId || null : null,
        dir: v.trip && v.trip.directionId != null ? num(v.trip.directionId) : null,
        lat: round(lat, 6),
        lon: round(lon, 6),
        bearing: v.position.bearing != null ? round(num(v.position.bearing), 0) : null,
        speed: v.position.speed != null ? round(num(v.position.speed), 1) : null, // m/s
        ts: num(v.timestamp),
        stopSeq: v.currentStopSequence != null ? num(v.currentStopSequence) : null,
        stopId: v.stopId || null,
        status: v.currentStatus != null ? num(v.currentStatus) : null,
      });
    }

    res.setHeader('Cache-Control', 'public, s-maxage=5, stale-while-revalidate=20');
    res.status(200).json({
      ts: num(feed.header.timestamp),
      fetched: Math.floor(Date.now() / 1000),
      count: vehicles.length,
      vehicles,
    });
  } catch (err) {
    res.setHeader('Cache-Control', 'no-store');
    res.status(502).json({ error: String((err && err.message) || err) });
  }
};
