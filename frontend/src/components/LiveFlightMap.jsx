import { useEffect, useRef, useCallback } from 'react';
import L from 'leaflet';

const API_URL = import.meta.env.VITE_API_URL || '';

function greatCirclePoints(lat1, lon1, lat2, lon2, n = 200) {
  const toRad = d => d * Math.PI / 180;
  const toDeg = r => r * 180 / Math.PI;
  const φ1 = toRad(lat1), λ1 = toRad(lon1);
  const φ2 = toRad(lat2), λ2 = toRad(lon2);
  const v1 = [Math.cos(φ1)*Math.cos(λ1), Math.cos(φ1)*Math.sin(λ1), Math.sin(φ1)];
  const v2 = [Math.cos(φ2)*Math.cos(λ2), Math.cos(φ2)*Math.sin(λ2), Math.sin(φ2)];
  const dot = v1[0]*v2[0] + v1[1]*v2[1] + v1[2]*v2[2];
  const d = Math.acos(Math.min(1, Math.max(-1, dot)));
  return Array.from({ length: n + 1 }, (_, i) => {
    const t = i / n;
    if (d < 1e-10) return [lat1, lon1];
    const A = Math.sin((1-t)*d)/Math.sin(d), B = Math.sin(t*d)/Math.sin(d);
    const x = A*v1[0]+B*v2[0], y = A*v1[1]+B*v2[1], z = A*v1[2]+B*v2[2];
    return [toDeg(Math.atan2(z, Math.sqrt(x*x+y*y))), toDeg(Math.atan2(y, x))];
  });
}

function bearing(lat1, lon1, lat2, lon2) {
  const toRad = d => d * Math.PI / 180;
  const toDeg = r => r * 180 / Math.PI;
  const φ1 = toRad(lat1), φ2 = toRad(lat2), Δλ = toRad(lon2 - lon1);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1)*Math.sin(φ2) - Math.sin(φ1)*Math.cos(φ2)*Math.cos(Δλ);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

function planeIcon(deg) {
  return L.divIcon({
    className: '',
    html: `<div style="font-size:16px;line-height:1;transform:rotate(${deg - 90}deg);color:#26A9F0;filter:drop-shadow(0 1px 2px rgba(0,0,0,0.4))">✈</div>`,
    iconSize: [16, 16],
    iconAnchor: [8, 8],
  });
}

export default function LiveFlightMap() {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const layerGroupRef = useRef(null);
  const overlayRef = useRef(null);

  // Draw markers for given flight list
  const drawFlights = useCallback((flights) => {
    const map = mapRef.current;
    const group = layerGroupRef.current;
    const overlay = overlayRef.current;
    if (!map || !group) return;

    group.clearLayers();

    if (flights.length === 0) {
      if (overlay) overlay.style.display = 'flex';
      return;
    }
    if (overlay) overlay.style.display = 'none';

    for (const f of flights) {
      const arc = greatCirclePoints(f.origin_lat, f.origin_lon, f.dest_lat, f.dest_lon, 200);
      const idx = Math.min(Math.floor(f.progress * 200), 198);
      const [lat, lon] = arc[idx];
      const [nLat, nLon] = arc[idx + 1];
      const bear = bearing(lat, lon, nLat, nLon);

      const marker = L.marker([lat, lon], { icon: planeIcon(bear) });
      const remH = Math.floor(f.remaining_ms / 3600000);
      const remM = Math.floor((f.remaining_ms % 3600000) / 60000);
      const eta = `${remH}h ${String(remM).padStart(2, '0')}m remaining`;

      marker.bindPopup(
        `<div style="font-family:system-ui,sans-serif;line-height:1.7;min-width:140px">
          <strong style="font-family:monospace;font-size:1rem">${f.flight_number}</strong><br>
          <span style="font-family:monospace;font-weight:700">${f.origin_iata} → ${f.destination_iata}</span><br>
          <span style="color:#888;font-size:0.85rem">${eta}</span>
        </div>`,
        { maxWidth: 200 }
      );
      group.addLayer(marker);
    }
  }, []);

  // Fetch and update
  const fetchAndDraw = useCallback(async () => {
    const token = localStorage.getItem('token');
    try {
      const res = await fetch(`${API_URL}/api/flights/active`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      drawFlights(data.flights || []);
    } catch (err) {
      console.error('LiveFlightMap fetch error:', err);
    }
  }, [drawFlights]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    delete container._leaflet_id;

    const map = L.map(container, {
      center: [30, 10],
      zoom: 2,
      dragging: true,
      scrollWheelZoom: false,
      doubleClickZoom: false,
      zoomControl: true,
    });

    L.tileLayer(
      'https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png',
      { attribution: '© OpenStreetMap contributors © CARTO', maxZoom: 19, subdomains: 'abcd' }
    ).addTo(map);

    const group = L.layerGroup().addTo(map);
    mapRef.current = map;
    layerGroupRef.current = group;

    setTimeout(() => map.invalidateSize(), 100);

    fetchAndDraw();
    const interval = setInterval(fetchAndDraw, 30000);

    return () => {
      clearInterval(interval);
      map.remove();
      mapRef.current = null;
      layerGroupRef.current = null;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div style={{ position: 'relative' }}>
      <div ref={containerRef} style={{ height: '400px', width: '100%' }} />
      <div
        ref={overlayRef}
        style={{
          display: 'none',
          position: 'absolute', inset: 0,
          alignItems: 'center', justifyContent: 'center',
          pointerEvents: 'none',
        }}
      >
        <span style={{ color: '#999', fontSize: '0.88rem', fontStyle: 'italic' }}>
          No flights currently airborne
        </span>
      </div>
    </div>
  );
}
