import { useEffect, useRef } from 'react';
import L from 'leaflet';


export default function AirportMap({ lat, lng, airportName, iataCode }) {
  const containerRef = useRef(null);
  const mapRef = useRef(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    delete container._leaflet_id;

    const map = L.map(container, {
      center: [lat, lng],
      zoom: 14,
      dragging: true,
      touchZoom: false,
      scrollWheelZoom: false,
      doubleClickZoom: false,
      boxZoom: false,
      keyboard: false,
      zoomControl: false,
    });

    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      attribution: '© Esri',
      maxZoom: 19,
    }).addTo(map);


    mapRef.current = map;

    // Force re-layout after container has painted — fixes blank map on first render
    const t = setTimeout(() => { map.invalidateSize(); }, 100);

    return () => {
      clearTimeout(t);
      map.remove();
      mapRef.current = null;
    };
  }, [lat, lng, airportName, iataCode]);

  return (
    <div
      ref={containerRef}
      style={{ height: '100%', width: '100%', display: 'block' }}
    />
  );
}
