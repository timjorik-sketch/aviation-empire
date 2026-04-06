import { useEffect, useRef, useState } from 'react';
import L from 'leaflet';

// Mercator aspect ratio (width / height) for bounds [−58°S, 75°N]
const MAP_SOUTH = -58, MAP_NORTH = 75;
const MAP_ASPECT = (() => {
  const mercY = lat => Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360));
  return (2 * Math.PI) / (mercY(MAP_NORTH) - mercY(MAP_SOUTH)); // ≈ 2.05
})();

const WORLD_BOUNDS = L.latLngBounds([[MAP_SOUTH, -180], [MAP_NORTH, 180]]);

function greatCirclePoints(lat1, lon1, lat2, lon2) {
  const toRad = d => d * Math.PI / 180;
  const toDeg = r => r * 180 / Math.PI;
  const φ1 = toRad(lat1), λ1 = toRad(lon1);
  const φ2 = toRad(lat2), λ2 = toRad(lon2);
  const v1 = [Math.cos(φ1)*Math.cos(λ1), Math.cos(φ1)*Math.sin(λ1), Math.sin(φ1)];
  const v2 = [Math.cos(φ2)*Math.cos(λ2), Math.cos(φ2)*Math.sin(λ2), Math.sin(φ2)];
  const dot = v1[0]*v2[0] + v1[1]*v2[1] + v1[2]*v2[2];
  const d = Math.acos(Math.min(1, Math.max(-1, dot)));
  // Adaptive n: ~60 points per radian of arc, min 20, max 300
  const n = Math.min(300, Math.max(20, Math.ceil(d * 60)));
  const pts = Array.from({ length: n + 1 }, (_, i) => {
    const t = i / n;
    if (d < 1e-10) return [lat1, lon1];
    const A = Math.sin((1-t)*d)/Math.sin(d), B = Math.sin(t*d)/Math.sin(d);
    const x = A*v1[0]+B*v2[0], y = A*v1[1]+B*v2[1], z = A*v1[2]+B*v2[2];
    return [toDeg(Math.atan2(z, Math.sqrt(x*x+y*y))), toDeg(Math.atan2(y, x))];
  });
  // Fix antimeridian crossings: keep longitudes continuous instead of jumping ±360°
  for (let i = 1; i < pts.length; i++) {
    const diff = pts[i][1] - pts[i-1][1];
    if (diff > 180)  pts[i][1] -= 360;
    if (diff < -180) pts[i][1] += 360;
  }
  return pts;
}

// Split unwrapped great-circle points into segments at each antimeridian crossing.
// Returns array of segments, each with coordinates wrapped back to [-180, 180].
function splitAtAntimeridian(pts) {
  const segments = [];
  let current = [];

  for (let i = 0; i < pts.length; i++) {
    const [lat, lon] = pts[i];

    if (i === 0) {
      current.push([lat, lon]);
      continue;
    }

    const prevLon = pts[i - 1][1];
    const prevBucket = Math.floor((prevLon + 180) / 360);
    const currBucket = Math.floor((lon + 180) / 360);

    if (prevBucket !== currBucket) {
      // Interpolate lat at the exact ±180° crossing
      const crossLon = prevBucket < currBucket ? prevBucket * 360 + 180 : currBucket * 360 + 180;
      const t = (crossLon - prevLon) / (lon - prevLon);
      const crossLat = pts[i - 1][0] + t * (lat - pts[i - 1][0]);
      const edgeSide = prevBucket < currBucket ? 180 : -180;

      current.push([crossLat, edgeSide]);
      segments.push(current);
      current = [[crossLat, -edgeSide]];
    }

    // Wrap back to [-180, 180]
    const wrapped = ((lon + 180) % 360 + 360) % 360 - 180;
    current.push([lat, wrapped]);
  }

  if (current.length > 0) segments.push(current);
  return segments;
}

// dep / arr: { iata, name, lat, lng } or null  — single route with markers
// routes: [{ dep, arr, depLat, depLng, arrLat, arrLng }]  — multiple routes, no markers
// hubs: [{ code, lat, lng }] — clickable hub dots (toggle filter)
// homeAirport: { code, lat, lng } — home base dot
// containerStyle: optional override for the container div style
export default function RoutePreviewMap({ dep, arr, routes, hubs, homeAirport, containerStyle }) {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const routeLayerRef = useRef(null);
  const hubMarkersRef = useRef({});
  const [activeHub, setActiveHub] = useState(null);

  const isMulti = !!(routes && routes.length > 0);
  const hubKey = hubs ? hubs.map(h => h.code).join(',') : '';

  // Effect 1: Map init, tiles, hub dots, home dot. Re-runs when airports/hubs change.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    delete container._leaflet_id;
    setActiveHub(null);
    hubMarkersRef.current = {};

    const map = L.map(container, {
      dragging: isMulti, scrollWheelZoom: isMulti,
      doubleClickZoom: isMulti, boxZoom: isMulti,
      keyboard: false, touchZoom: isMulti,
      zoomControl: isMulti,
      zoomSnap: 0.1,
    });

    L.tileLayer(
      'https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png',
      { attribution: '© OpenStreetMap contributors © CARTO', maxZoom: 19, subdomains: 'abcd' }
    ).addTo(map);

    // Route lines go in a layer group so Effect 2 can clear+redraw them
    const routeLayer = L.layerGroup().addTo(map);
    mapRef.current = map;
    routeLayerRef.current = routeLayer;

    // Single route mode: draw line here (static, no filtering needed)
    if (dep && arr) {
      const arc = greatCirclePoints(dep.lat, dep.lng, arr.lat, arr.lng);
      splitAtAntimeridian(arc).forEach(seg =>
        L.polyline(seg, { color: '#26A9F0', weight: 1.8 }).addTo(map)
      );
      setTimeout(() => {
        map.invalidateSize();
        map.fitBounds(WORLD_BOUNDS, { padding: [0, 0], animate: false });
      }, 100);
    }

    if (isMulti) {
      // Hub dots — clickable toggle
      if (hubs && hubs.length > 0) {
        hubs.forEach(h => {
          if (h.lat == null || h.lng == null) return;
          const marker = L.circleMarker([h.lat, h.lng], {
            radius: 4,
            color: '#1a6dc4',
            fillColor: '#26A9F0',
            fillOpacity: 1,
            weight: 1.5,
            interactive: true,
          });
          marker.bindTooltip(h.code, { permanent: false, direction: 'top', offset: [0, -6] });
          marker.on('click', () => setActiveHub(prev => prev === h.code ? null : h.code));
          marker.addTo(map);
          hubMarkersRef.current[h.code] = marker;
        });
      }

      // Home base dot (not clickable — just a marker)
      if (homeAirport && homeAirport.lat != null) {
        L.circleMarker([homeAirport.lat, homeAirport.lng], {
          radius: 5,
          color: '#1a6dc4',
          fillColor: '#26A9F0',
          fillOpacity: 1,
          weight: 2,
          interactive: true,
        }).bindTooltip(`${homeAirport.code} (Home-Base)`, { permanent: false, direction: 'top', offset: [0, -7] })
          .addTo(map);
      }

      setTimeout(() => map.invalidateSize(), 100);
    }

    const ro = new ResizeObserver(() => { if (!isMulti) { map.invalidateSize(); map.fitBounds(WORLD_BOUNDS, { padding: [0, 0], animate: false }); } });
    ro.observe(container);

    return () => {
      ro.disconnect();
      map.remove();
      mapRef.current = null;
      routeLayerRef.current = null;
      hubMarkersRef.current = {};
    };
  }, [dep?.iata, arr?.iata, isMulti, hubKey, homeAirport?.code]); // eslint-disable-line react-hooks/exhaustive-deps

  // Effect 2: Draw/redraw route lines whenever routes or activeHub changes.
  useEffect(() => {
    const routeLayer = routeLayerRef.current;
    const map = mapRef.current;
    if (!routeLayer || !map || !routes) return;

    routeLayer.clearLayers();

    const filtered = activeHub
      ? routes.filter(r => r.dep === activeHub || r.arr === activeHub)
      : routes;

    const allPoints = [];
    filtered.forEach(({ depLat, depLng, arrLat, arrLng }) => {
      const arc = greatCirclePoints(depLat, depLng, arrLat, arrLng);
      allPoints.push(...arc);
      splitAtAntimeridian(arc).forEach(seg =>
        L.polyline(seg, { color: '#26A9F0', weight: 1, opacity: 0.85 }).addTo(routeLayer)
      );
    });

    if (allPoints.length > 0) {
      map.fitBounds(L.latLngBounds(allPoints), { padding: [24, 24], animate: !!activeHub });
    } else if (routes.length > 0 && activeHub) {
      // Hub selected but no routes — stay put
    } else {
      map.fitBounds(WORLD_BOUNDS, { padding: [0, 0], animate: false });
    }

    // Update hub marker styles to reflect active/inactive state
    Object.entries(hubMarkersRef.current).forEach(([code, marker]) => {
      marker.setStyle({
        fillColor: activeHub === code ? '#ffffff' : '#26A9F0',
        color: activeHub === code ? '#ffffff' : '#1a6dc4',
        weight: activeHub === code ? 2 : 1.5,
      });
    });
  }, [routes, activeHub]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div
      ref={containerRef}
      style={containerStyle ?? { width: '100%', aspectRatio: MAP_ASPECT, display: 'block' }}
    />
  );
}
