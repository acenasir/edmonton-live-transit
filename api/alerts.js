// Decodes the City of Edmonton GTFS-realtime service alerts feed into JSON.
const { transit_realtime } = require('gtfs-realtime-bindings');

const FEED_URL = 'https://gtfs.edmonton.ca/TMGTFSRealTimeWebService/Alert/Alerts.pb';

function text(ts) {
  if (!ts || !ts.translation || !ts.translation.length) return null;
  const en = ts.translation.find((t) => !t.language || /^en/i.test(t.language)) || ts.translation[0];
  return en.text || null;
}

function num(v) {
  if (v == null) return null;
  if (typeof v === 'object' && typeof v.toNumber === 'function') return v.toNumber();
  return Number(v);
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
    const now = Math.floor(Date.now() / 1000);

    const alerts = [];
    for (const entity of feed.entity) {
      const a = entity.alert;
      if (!a) continue;
      const periods = (a.activePeriod || []).map((p) => ({ start: num(p.start), end: num(p.end) }));
      const active = !periods.length || periods.some((p) => (!p.start || p.start <= now) && (!p.end || p.end >= now));
      if (!active) continue;
      const routes = [...new Set((a.informedEntity || []).map((e) => e.routeId).filter(Boolean))];
      const stops = [...new Set((a.informedEntity || []).map((e) => e.stopId).filter(Boolean))];
      alerts.push({
        id: entity.id,
        header: text(a.headerText),
        description: text(a.descriptionText),
        url: text(a.url),
        cause: a.cause != null ? num(a.cause) : null,
        effect: a.effect != null ? num(a.effect) : null,
        routes,
        stops: stops.length,
        periods,
      });
    }

    res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300');
    res.status(200).json({ ts: num(feed.header.timestamp), count: alerts.length, alerts });
  } catch (err) {
    res.setHeader('Cache-Control', 'no-store');
    res.status(502).json({ error: String((err && err.message) || err) });
  }
};
