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

// Destination point given start, bearing (compass deg), and distance (km).
function destPoint(lat, lon, bearingDeg, distanceKm) {
  const R = 6371;
  const δ = distanceKm / R;
  const θ = bearingDeg * Math.PI / 180;
  const φ1 = lat * Math.PI / 180;
  const λ1 = lon * Math.PI / 180;
  const φ2 = Math.asin(Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ));
  const λ2 = λ1 + Math.atan2(
    Math.sin(θ) * Math.sin(δ) * Math.cos(φ1),
    Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2),
  );
  return [φ2 * 180 / Math.PI, ((λ2 * 180 / Math.PI) + 540) % 360 - 180];
}

// 3-phase trajectory tuning: short 5 km / 1 min initial climb (planes pop out of
// the airport quickly), longer 40 km / 8 min final approach (visible alignment).
// Skip the pattern for very short hops where there isn't room for a meaningful cruise leg.
const CLIMB_MIN = 1;
const APPROACH_MIN = 8;
const CLIMB_DISTANCE_KM = 5;
const APPROACH_DISTANCE_KM = 40;
const MIN_FLIGHT_MIN_FOR_PATTERN = 20;

function planeIcon(deg, color = '#26A9F0') {
  return L.divIcon({
    className: '',
    html: `<div style="font-size:16px;line-height:1;transform:rotate(${deg - 90}deg);color:${color};filter:drop-shadow(0 1px 2px rgba(0,0,0,0.4))">✈</div>`,
    iconSize: [16, 16],
    iconAnchor: [8, 8],
  });
}

const TILE_LAYERS = {
  dark: {
    url: 'https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png',
    options: { attribution: '© OpenStreetMap contributors © CARTO', maxZoom: 19, subdomains: 'abcd' },
  },
  satellite: {
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    options: { attribution: 'Tiles © Esri — Source: Esri, Maxar, Earthstar Geographics', maxZoom: 19 },
  },
};

export default function LiveFlightMap({ mapStyle = 'dark' }) {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const layerGroupRef = useRef(null);
  const overlayRef = useRef(null);
  const tileLayerRef = useRef(null);

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

      // Default position: linear progress along the great-circle.
      let arcIdx = Math.min(Math.floor(f.progress * 200), 198);
      let lat = arc[arcIdx][0];
      let lon = arc[arcIdx][1];
      let bear = bearing(arc[arcIdx][0], arc[arcIdx][1], arc[arcIdx + 1][0], arc[arcIdx + 1][1]);
      let phaseLabel = null;

      // Tech Air gets a multi-phase position computation that reflects the
      // out-and-back-and-out-again choreography:
      //   A: takeoff → turnback point  (forward, fraction 0..X of arc)
      //   B: turnback → land at origin (backward, fraction X..0)
      //   C: at origin (1h repair)     (parked at arc[0])
      //   D: takeoff → arrival         (forward, fraction 0..1)
      if (f.delay_reason === 'technical_air' && f.turnback_fraction != null && f.original_flight_min) {
        const X = f.turnback_fraction;
        const F = f.original_flight_min; // minutes (one-way)
        const repairMin = 60;
        const phaseEndA = X * F;
        const phaseEndB = phaseEndA + X * F;
        const phaseEndC = phaseEndB + repairMin;
        const phaseEndD = phaseEndC + F;
        const elapsedMin = (Date.now() - new Date(f.departure_time).getTime()) / 60000;

        let arcFrac;
        let backward = false;
        if (elapsedMin < phaseEndA) {
          const local = elapsedMin / phaseEndA;
          arcFrac = local * X;
          phaseLabel = `Outbound · turnback at ${(X * 100).toFixed(0)}%`;
        } else if (elapsedMin < phaseEndB) {
          const local = (elapsedMin - phaseEndA) / (phaseEndB - phaseEndA);
          arcFrac = X - local * X;
          backward = true;
          phaseLabel = `Diverted — returning to ${f.origin_iata}`;
        } else if (elapsedMin < phaseEndC) {
          arcFrac = 0;
          phaseLabel = `Repairing at ${f.origin_iata}`;
        } else if (elapsedMin < phaseEndD) {
          const local = (elapsedMin - phaseEndC) / (phaseEndD - phaseEndC);
          arcFrac = local;
          phaseLabel = `Continuing to ${f.destination_iata}`;
        } else {
          arcFrac = 1;
          phaseLabel = 'Arriving';
        }
        arcIdx = Math.max(0, Math.min(Math.floor(arcFrac * 200), 198));
        lat = arc[arcIdx][0];
        lon = arc[arcIdx][1];
        bear = bearing(arc[arcIdx][0], arc[arcIdx][1], arc[arcIdx + 1][0], arc[arcIdx + 1][1]);
        if (backward) bear = (bear + 180) % 360;
      } else if (
        f.origin_heading != null && f.dest_heading != null &&
        f.delay_reason !== 'medical' &&
        (f.remaining_ms / (1 - f.progress)) >= MIN_FLIGHT_MIN_FOR_PATTERN * 60_000
      ) {
        // 3-phase trajectory: initial climb out runway heading, great-circle cruise
        // between fix points, final approach lined up with destination runway.
        const totalMs = f.remaining_ms / (1 - f.progress);
        const elapsedMs = totalMs - f.remaining_ms;
        const climbMs = CLIMB_MIN * 60_000;
        const approachMs = APPROACH_MIN * 60_000;

        const depFix = destPoint(f.origin_lat, f.origin_lon, f.origin_heading, CLIMB_DISTANCE_KM);
        const apprFix = destPoint(f.dest_lat, f.dest_lon, (f.dest_heading + 180) % 360, APPROACH_DISTANCE_KM);

        if (elapsedMs < climbMs) {
          const t = elapsedMs / climbMs;
          lat = f.origin_lat + (depFix[0] - f.origin_lat) * t;
          lon = f.origin_lon + (depFix[1] - f.origin_lon) * t;
          bear = f.origin_heading;
        } else if (f.remaining_ms < approachMs) {
          const t = 1 - f.remaining_ms / approachMs;
          lat = apprFix[0] + (f.dest_lat - apprFix[0]) * t;
          lon = apprFix[1] + (f.dest_lon - apprFix[1]) * t;
          bear = f.dest_heading;
        } else {
          const cruiseArc = greatCirclePoints(depFix[0], depFix[1], apprFix[0], apprFix[1], 200);
          const cruiseT = (elapsedMs - climbMs) / (totalMs - climbMs - approachMs);
          const idx = Math.max(0, Math.min(Math.floor(cruiseT * 200), 198));
          lat = cruiseArc[idx][0];
          lon = cruiseArc[idx][1];
          bear = bearing(cruiseArc[idx][0], cruiseArc[idx][1], cruiseArc[idx + 1][0], cruiseArc[idx + 1][1]);
        }
      }

      // Orange highlight for any disrupted flight currently in the air
      const isDisrupted = f.delay_reason === 'medical' || f.delay_reason === 'technical_air';
      const color = isDisrupted ? '#facc15' : '#26A9F0';
      const marker = L.marker([lat, lon], { icon: planeIcon(bear, color) });
      const remH = Math.floor(f.remaining_ms / 3600000);
      const remM = Math.floor((f.remaining_ms % 3600000) / 60000);
      const eta = `${remH}h ${String(remM).padStart(2, '0')}m remaining`;

      let divNote = '';
      if (f.delay_reason === 'medical' && f.diversion_airport_code) {
        divNote = `<div style="margin-top:4px;font-size:0.72rem;font-weight:700;color:#facc15;text-transform:uppercase;letter-spacing:0.04em">Diverted via ${f.diversion_airport_code}</div>`;
      } else if (f.delay_reason === 'medical') {
        divNote = `<div style="margin-top:4px;font-size:0.72rem;font-weight:700;color:#facc15;text-transform:uppercase;letter-spacing:0.04em">Medical diversion</div>`;
      } else if (f.delay_reason === 'technical_air' && phaseLabel) {
        divNote = `<div style="margin-top:4px;font-size:0.72rem;font-weight:700;color:#facc15;text-transform:uppercase;letter-spacing:0.04em">${phaseLabel}</div>`;
      }

      marker.bindPopup(
        `<div style="font-family:system-ui,sans-serif;line-height:1.7;min-width:140px">
          <strong style="font-family:monospace;font-size:1rem">${f.flight_number}</strong><br>
          <span style="font-family:monospace;font-weight:700">${f.origin_iata} → ${f.destination_iata}</span><br>
          <span style="color:#888;font-size:0.85rem">${eta}</span>
          ${divNote}
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

    const initial = TILE_LAYERS[mapStyle] || TILE_LAYERS.dark;
    tileLayerRef.current = L.tileLayer(initial.url, initial.options).addTo(map);

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
      tileLayerRef.current = null;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Swap tile layer when mapStyle changes (without remounting the map)
  useEffect(() => {
    const map = mapRef.current;
    const oldLayer = tileLayerRef.current;
    if (!map || !oldLayer) return;
    const cfg = TILE_LAYERS[mapStyle] || TILE_LAYERS.dark;
    const next = L.tileLayer(cfg.url, cfg.options).addTo(map);
    map.removeLayer(oldLayer);
    tileLayerRef.current = next;
  }, [mapStyle]);

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
