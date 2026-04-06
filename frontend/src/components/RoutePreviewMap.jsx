import { useEffect, useRef } from 'react';
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

function badgeIcon(code) {
  return L.divIcon({
    className: '',
    html: `<div style="background:#2C2C2C;color:#fff;font-family:monospace;font-weight:700;font-size:11px;padding:3px 8px;border-radius:3px;white-space:nowrap;letter-spacing:0.08em">${code}</div>`,
    iconSize: null,
    iconAnchor: [-4, 8],
  });
}

// dep / arr: { iata, name, lat, lng } or null  — single route with markers
// routes: [{ depLat, depLng, arrLat, arrLng }]  — multiple routes, no markers
// containerStyle: optional override for the container div style
export default function RoutePreviewMap({ dep, arr, routes, hubs, containerStyle }) {
  const containerRef = useRef(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    delete container._leaflet_id;

    const isMulti = routes && routes.length > 0;

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

    let networkBounds = null;

    // Multiple routes mode (dashboard overview — no markers)
    if (isMulti) {
      const allPoints = [];
      routes.forEach(({ depLat, depLng, arrLat, arrLng }) => {
        const arc = greatCirclePoints(depLat, depLng, arrLat, arrLng);
        allPoints.push(...arc);
        splitAtAntimeridian(arc).forEach(seg =>
          L.polyline(seg, { color: '#26A9F0', weight: 1, opacity: 0.85 }).addTo(map)
        );
      });
      if (allPoints.length > 0) networkBounds = L.latLngBounds(allPoints);

      // Hub dots
      if (hubs && hubs.length > 0) {
        hubs.forEach(h => {
          if (h.lat == null || h.lng == null) return;
          L.circleMarker([h.lat, h.lng], {
            radius: 4,
            color: '#1a6dc4',
            fillColor: '#26A9F0',
            fillOpacity: 1,
            weight: 1.5,
          }).bindTooltip(h.code, { permanent: false, direction: 'top', offset: [0, -6] })
            .addTo(map);
        });
      }
    }

    // Single route mode (Route Map page — line only, no markers)
    if (dep && arr) {
      const arc = greatCirclePoints(dep.lat, dep.lng, arr.lat, arr.lng);
      splitAtAntimeridian(arc).forEach(seg =>
        L.polyline(seg, { color: '#26A9F0', weight: 1.8 }).addTo(map)
      );
    }

    const fit = () => {
      map.invalidateSize();
      if (networkBounds) {
        map.fitBounds(networkBounds, { padding: [24, 24], animate: false });
      } else {
        map.fitBounds(WORLD_BOUNDS, { padding: [0, 0], animate: false });
      }
    };

    setTimeout(fit, 100);

    // Refit on resize only for single-route (multi is interactive)
    const ro = new ResizeObserver(() => { if (!isMulti) fit(); });
    ro.observe(container);

    return () => { ro.disconnect(); map.remove(); };
  }, [dep?.iata, arr?.iata, routes]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div
      ref={containerRef}
      style={containerStyle ?? { width: '100%', aspectRatio: MAP_ASPECT, display: 'block' }}
    />
  );
}
