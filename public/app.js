/* Edmonton Live Transit — every ETS bus and LRT train, animated on a map.
   Data: City of Edmonton GTFS-realtime feeds via /api/vehicles and /api/alerts. */
(function () {
  'use strict';

  const POLL_MS = 6000;          // how often to ask the API
  const STALE_S = 300;           // vehicle report older than this is drawn dimmed
  const DROP_S = 900;            // vehicle not reported for this long is removed
  const CENTER = [-113.4938, 53.5461];

  const $ = (id) => document.getElementById(id);
  const statusEl = $('status');
  const dot = document.querySelector('.brand-dot');

  // ---------- basemap ----------
  const style = {
    version: 8,
    glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
    sources: {
      sat: {
        type: 'raster', tileSize: 256, maxzoom: 19,
        tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
        attribution: 'Imagery © Esri, Maxar, Earthstar Geographics',
      },
      satlabels: {
        type: 'raster', tileSize: 256, maxzoom: 19,
        tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}'],
      },
      dark: {
        type: 'raster', tileSize: 256, maxzoom: 19,
        tiles: ['https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png', 'https://b.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png', 'https://c.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png'],
        attribution: '© CARTO © OpenStreetMap contributors',
      },
    },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': '#0b0e12' } },
      { id: 'sat', type: 'raster', source: 'sat', paint: { 'raster-saturation': -0.15, 'raster-brightness-max': 0.9 } },
      { id: 'satlabels', type: 'raster', source: 'satlabels', paint: { 'raster-opacity': 0.9 } },
      { id: 'dark', type: 'raster', source: 'dark', layout: { visibility: 'none' } },
    ],
  };

  const map = new maplibregl.Map({
    container: 'map',
    style,
    center: CENTER,
    zoom: 11.2,
    minZoom: 8,
    maxZoom: 18,
    attributionControl: false,
    hash: true,
  });
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');
  map.addControl(new maplibregl.GeolocateControl({ positionOptions: { enableHighAccuracy: true }, trackUserLocation: false }), 'bottom-right');

  // ---------- state ----------
  let routes = {};                 // route_id -> {n,l,t,c,tc,a}
  const vehicles = new Map();      // id -> {from:[lon,lat], to:[lon,lat], t0, dur, data}
  const icons = new Set();
  let filterSet = null;            // Set of upper-cased route short names, or null
  let lastFeedTs = 0;
  let popup = null;
  let popupVehicleId = null;
  let animating = false;

  const empty = () => ({ type: 'FeatureCollection', features: [] });

  // ---------- pill icons drawn on canvas ----------
  function pill(text, bg, fg, big) {
    const scale = 2;
    const h = (big ? 22 : 18) * scale;
    const font = `700 ${(big ? 12 : 11) * scale}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
    const c = document.createElement('canvas');
    let ctx = c.getContext('2d');
    ctx.font = font;
    const tw = ctx.measureText(text).width;
    const w = Math.ceil(tw + 14 * scale);
    c.width = w; c.height = h;
    ctx = c.getContext('2d');
    ctx.font = font;
    // shadow / outline
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    roundRect(ctx, 0, 0, w, h, h / 2); ctx.fill();
    ctx.fillStyle = bg;
    roundRect(ctx, 1.5 * scale, 1.5 * scale, w - 3 * scale, h - 3 * scale, h / 2); ctx.fill();
    ctx.fillStyle = fg;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(text, w / 2, h / 2 + 0.5 * scale);
    return { data: ctx.getImageData(0, 0, w, h), scale };
  }
  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }
  function arrowIcon() {
    const s = 2, w = 12 * s, h = 12 * s;
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    ctx.beginPath(); ctx.moveTo(w / 2, 0); ctx.lineTo(w, h); ctx.lineTo(w / 2, h * 0.7); ctx.lineTo(0, h); ctx.closePath();
    ctx.fillStyle = 'rgba(255,255,255,0.95)'; ctx.fill();
    ctx.lineWidth = 1.5 * s; ctx.strokeStyle = 'rgba(0,0,0,0.6)'; ctx.stroke();
    return { data: ctx.getImageData(0, 0, w, h), scale: s };
  }

  function ensureIcon(routeId) {
    const key = 'r:' + (routeId || '?');
    if (icons.has(key)) return key;
    const r = routes[routeId];
    const label = r ? r.n : (routeId || '?');
    const bg = r ? '#' + r.c : '#666a73';
    const fg = r ? '#' + r.tc : '#ffffff';
    const big = r && r.t === 0;
    const img = pill(label, bg, fg, big);
    map.addImage(key, img.data, { pixelRatio: img.scale });
    icons.add(key);
    return key;
  }

  // ---------- layers ----------
  map.on('load', async () => {
    map.addImage('arrow', arrowIcon().data, { pixelRatio: 2 });

    try {
      const [r, lrt] = await Promise.all([
        fetch('data/routes.json').then((x) => x.json()),
        fetch('data/lrt.geojson').then((x) => x.json()),
      ]);
      routes = r;
      map.addSource('lrt', { type: 'geojson', data: lrt });
      map.addLayer({
        id: 'lrt-casing', type: 'line', source: 'lrt',
        paint: { 'line-color': '#000', 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 4, 15, 9], 'line-opacity': 0.55 },
        layout: { 'line-cap': 'round', 'line-join': 'round' },
      });
      map.addLayer({
        id: 'lrt-line', type: 'line', source: 'lrt',
        paint: { 'line-color': ['get', 'color'], 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 2, 15, 5], 'line-opacity': 0.9 },
        layout: { 'line-cap': 'round', 'line-join': 'round' },
      });
    } catch (e) {
      console.warn('static data failed', e);
    }

    map.addSource('veh', { type: 'geojson', data: empty() });
    map.addLayer({
      id: 'veh-arrow', type: 'symbol', source: 'veh',
      filter: ['all', ['has', 'bearing'], ['>', ['get', 'moving'], 0]],
      layout: {
        'icon-image': 'arrow',
        'icon-size': ['interpolate', ['linear'], ['zoom'], 10, 0.55, 14, 0.9],
        'icon-rotate': ['get', 'bearing'],
        'icon-rotation-alignment': 'map',
        'icon-offset': [0, -19],
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
      },
      paint: { 'icon-opacity': ['*', ['get', 'alpha'], 0.9] },
    });
    map.addLayer({
      id: 'veh', type: 'symbol', source: 'veh',
      layout: {
        'icon-image': ['get', 'icon'],
        'icon-size': ['interpolate', ['linear'], ['zoom'], 9, 0.6, 12, 0.85, 15, 1],
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
        'symbol-sort-key': ['get', 'sort'],
      },
      paint: { 'icon-opacity': ['get', 'alpha'] },
    });

    map.on('mouseenter', 'veh', () => (map.getCanvas().style.cursor = 'pointer'));
    map.on('mouseleave', 'veh', () => (map.getCanvas().style.cursor = ''));
    map.on('click', 'veh', (e) => {
      const f = e.features && e.features[0];
      if (f) openPopup(f.properties.id);
    });

    poll();
    setInterval(poll, POLL_MS);
    loadAlerts();
    setInterval(loadAlerts, 120000);
    requestAnimationFrame(frame);
  });

  // ---------- data polling ----------
  async function poll() {
    try {
      const res = await fetch('api/vehicles', { cache: 'no-store' });
      const json = await res.json();
      if (!res.ok || json.error) throw new Error(json.error || res.statusText);
      ingest(json);
      const age = Math.max(0, json.fetched - json.ts);
      setStatus(`Feed updated ${fmtAgo(json.ts)} · ${json.count} vehicles reporting`, age > 120 ? 'stale' : 'ok');
    } catch (err) {
      setStatus('Feed unavailable: ' + err.message, 'down');
    }
  }

  function ingest(json) {
    const now = performance.now();
    const seen = new Set();
    lastFeedTs = json.ts;
    for (const v of json.vehicles) {
      if (!v.lat || !v.lon) continue;
      seen.add(v.id);
      const to = [v.lon, v.lat];
      const cur = vehicles.get(v.id);
      if (!cur) {
        vehicles.set(v.id, { from: to, to, t0: now, dur: 1, data: v, seenAt: now });
      } else {
        const pos = interp(cur, now);
        const moved = dist(pos, to) > 0.5;
        cur.from = pos; cur.to = to;
        cur.t0 = now;
        cur.dur = moved ? POLL_MS : 1;
        cur.data = v; cur.seenAt = now;
      }
    }
    // drop vehicles that vanished from the feed for a long time
    for (const [id, cur] of vehicles) {
      if (!seen.has(id) && now - cur.seenAt > DROP_S * 1000) vehicles.delete(id);
    }
    updateStats();
  }

  function interp(cur, now) {
    const p = Math.min(1, (now - cur.t0) / cur.dur);
    const e = p < 1 ? 1 - Math.pow(1 - p, 2) : 1; // ease-out
    return [cur.from[0] + (cur.to[0] - cur.from[0]) * e, cur.from[1] + (cur.to[1] - cur.from[1]) * e];
  }
  function dist(a, b) { // metres, good enough at this scale
    const dx = (b[0] - a[0]) * 66500, dy = (b[1] - a[1]) * 111300;
    return Math.sqrt(dx * dx + dy * dy);
  }

  // ---------- animation ----------
  let lastFrame = 0;
  function frame(t) {
    requestAnimationFrame(frame);
    if (t - lastFrame < 33) return; // ~30 fps is plenty for setData
    lastFrame = t;
    const now = performance.now();
    const nowS = Date.now() / 1000;
    const features = [];
    for (const [id, cur] of vehicles) {
      const v = cur.data;
      const pos = interp(cur, now);
      const r = routes[v.route];
      const match = !filterSet || (r && filterSet.has(r.n.toUpperCase())) || (v.route && filterSet.has(String(v.route).toUpperCase()));
      const age = v.ts ? nowS - v.ts : 0;
      let alpha = match ? 1 : 0.12;
      if (age > STALE_S) alpha *= 0.45;
      features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: pos },
        properties: {
          id,
          icon: ensureIcon(v.route),
          bearing: v.bearing == null ? null : v.bearing,
          moving: (v.speed || 0) > 0.5 || cur.dur > 1 ? 1 : 0,
          alpha,
          sort: (r && r.t === 0 ? 0 : 1) + (match ? 0 : 2),
        },
      });
    }
    const src = map.getSource('veh');
    if (src) src.setData({ type: 'FeatureCollection', features });
    if (popup && popupVehicleId && vehicles.has(popupVehicleId)) {
      const cur = vehicles.get(popupVehicleId);
      popup.setLngLat(interp(cur, now));
      if (t % 1000 < 40) popup.setHTML(popupHtml(cur.data));
    }
  }

  // ---------- popup ----------
  function popupHtml(v) {
    const r = routes[v.route] || {};
    const bg = '#' + (r.c || '666a73'), fg = '#' + (r.tc || 'ffffff');
    const kmh = v.speed != null ? Math.round(v.speed * 3.6) : null;
    const dirName = v.dir == null ? null : v.dir === 0 ? 'Outbound / direction 0' : 'Inbound / direction 1';
    return `<div class="popup">
      <div class="title"><span class="pill" style="background:${bg};color:${fg}">${esc(r.n || v.route || '?')}</span>${esc(r.l || 'Unknown route')}</div>
      <dl>
        ${r.a ? `<dt>Agency</dt><dd>${esc(r.a)}</dd>` : ''}
        <dt>Vehicle</dt><dd>${esc(v.label || v.vid || v.id)}</dd>
        ${kmh != null ? `<dt>Speed</dt><dd>${kmh} km/h</dd>` : ''}
        ${v.bearing != null ? `<dt>Heading</dt><dd>${compass(v.bearing)} (${v.bearing}°)</dd>` : ''}
        ${dirName ? `<dt>Direction</dt><dd>${dirName}</dd>` : ''}
        ${v.stopSeq != null ? `<dt>Stop #</dt><dd>${v.stopSeq}${v.stopId ? ' · stop ' + esc(v.stopId) : ''}</dd>` : ''}
        <dt>Reported</dt><dd>${v.ts ? fmtAgo(v.ts) : 'n/a'}</dd>
        ${v.trip ? `<dt>Trip</dt><dd>${esc(v.trip)}</dd>` : ''}
      </dl></div>`;
  }
  function openPopup(id) {
    const cur = vehicles.get(id);
    if (!cur) return;
    if (popup) popup.remove();
    popupVehicleId = id;
    popup = new maplibregl.Popup({ offset: 14, closeButton: true, maxWidth: '300px' })
      .setLngLat(interp(cur, performance.now()))
      .setHTML(popupHtml(cur.data))
      .addTo(map);
    popup.on('close', () => { popup = null; popupVehicleId = null; });
  }

  // ---------- alerts ----------
  async function loadAlerts() {
    try {
      const res = await fetch('api/alerts', { cache: 'no-store' });
      const json = await res.json();
      if (!res.ok || json.error) throw new Error(json.error);
      const box = $('alerts-box'), list = $('alerts');
      $('alerts-count').textContent = json.count;
      list.innerHTML = '';
      for (const a of json.alerts.slice(0, 40)) {
        const li = document.createElement('li');
        const routeNames = a.routes.map((id) => (routes[id] ? routes[id].n : id)).join(', ');
        li.innerHTML = `<b>${esc(a.header || 'Service alert')}</b>${a.description ? esc(a.description).slice(0, 240) : ''}${routeNames ? `<div class="routes">Routes: ${esc(routeNames)}</div>` : ''}`;
        list.appendChild(li);
      }
      box.hidden = json.count === 0;
    } catch (e) {
      $('alerts-box').hidden = true;
    }
  }

  // ---------- UI ----------
  function updateStats() {
    let bus = 0, lrt = 0;
    for (const cur of vehicles.values()) {
      const r = routes[cur.data.route];
      if (r && r.t === 0) lrt++; else bus++;
    }
    $('stat-total').textContent = vehicles.size;
    $('stat-bus').textContent = bus;
    $('stat-lrt').textContent = lrt;
    $('expand-count').textContent = vehicles.size;
  }
  function setStatus(msg, state) {
    statusEl.textContent = msg;
    statusEl.classList.toggle('bad', state === 'down');
    dot.classList.toggle('stale', state === 'stale');
    dot.classList.toggle('down', state === 'down');
  }

  $('filter').addEventListener('input', (e) => {
    const parts = e.target.value.split(/[,\s]+/).map((s) => s.trim().toUpperCase()).filter(Boolean);
    filterSet = parts.length ? new Set(parts.flatMap(expandRouteName)) : null;
  });
  // "1" should match route "001", "Capital" should match the Capital Line etc.
  function expandRouteName(q) {
    const out = [q];
    for (const id in routes) {
      const n = routes[id].n.toUpperCase();
      if (n === q || n.replace(/^0+/, '') === q.replace(/^0+/, '') || (q.length >= 3 && (n.startsWith(q) || routes[id].l.toUpperCase().includes(q)))) out.push(n, id.toUpperCase());
    }
    return out;
  }

  $('basemap').addEventListener('click', (e) => {
    const btn = e.currentTarget;
    const toDark = btn.dataset.mode === 'sat';
    btn.dataset.mode = toDark ? 'dark' : 'sat';
    btn.textContent = toDark ? 'Dark map' : 'Satellite';
    map.setLayoutProperty('sat', 'visibility', toDark ? 'none' : 'visible');
    map.setLayoutProperty('satlabels', 'visibility', toDark || !$('labels').classList.contains('on') ? 'none' : 'visible');
    map.setLayoutProperty('dark', 'visibility', toDark ? 'visible' : 'none');
  });
  $('labels').addEventListener('click', (e) => {
    const on = e.currentTarget.classList.toggle('on');
    if ($('basemap').dataset.mode === 'sat') map.setLayoutProperty('satlabels', 'visibility', on ? 'visible' : 'none');
  });
  $('trails').addEventListener('click', (e) => {
    const on = e.currentTarget.classList.toggle('on');
    map.setLayoutProperty('veh-arrow', 'visibility', on ? 'visible' : 'none');
  });
  $('lrtlines').addEventListener('click', (e) => {
    const on = e.currentTarget.classList.toggle('on');
    for (const id of ['lrt-casing', 'lrt-line']) if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
  });
  $('collapse').addEventListener('click', () => { $('panel').hidden = true; $('expand').hidden = false; });
  $('expand').addEventListener('click', () => { $('panel').hidden = false; $('expand').hidden = true; });

  // ---------- helpers ----------
  function fmtAgo(ts) {
    const s = Math.max(0, Math.round(Date.now() / 1000 - ts));
    if (s < 5) return 'just now';
    if (s < 60) return s + 's ago';
    if (s < 3600) return Math.floor(s / 60) + 'm ' + (s % 60) + 's ago';
    return Math.floor(s / 3600) + 'h ago';
  }
  function compass(b) {
    return ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(((b % 360) + 360) % 360 / 45) % 8];
  }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
})();
