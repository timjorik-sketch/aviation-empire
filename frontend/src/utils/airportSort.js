// Shared dropdown grouping for airport selectors.
// Top tier (flat, no group label): Home Base → Primary Hub → Secondary Hubs.
// Rest grouped into <optgroup> by country, countries alphabetical, airports alphabetical by IATA.
//
// Input: airport objects with at least { iata_code, name, country } and one of:
//   - display_type ('home_base' | 'primary_hub' | 'hub' | 'hub_restricted' | 'destination' | ...)
//   - destination_type + primaryHubCode (legacy fallback if display_type absent)
//
// Returns: { top: [...], countries: [c, ...], byCountry: { [c]: [...] } }
export function groupAirportsForDropdown(airports, primaryHubCode = null) {
  const resolveDisplay = (a) => {
    if (a.display_type) return a.display_type;
    if (a.destination_type === 'home_base') return 'home_base';
    if (primaryHubCode && a.iata_code === primaryHubCode) return 'primary_hub';
    return a.destination_type || 'destination';
  };
  const isTopTier = (d) => d === 'home_base' || d === 'primary_hub' || d === 'hub' || d === 'hub_restricted';
  const tierRank = (d) => {
    if (d === 'home_base') return 0;
    if (d === 'primary_hub') return 1;
    return 2; // secondary hubs (hub / hub_restricted)
  };

  const top = [];
  const rest = [];
  for (const a of airports) {
    const d = resolveDisplay(a);
    if (isTopTier(d)) top.push({ ...a, _display: d });
    else rest.push(a);
  }
  top.sort((a, b) => {
    const ra = tierRank(a._display), rb = tierRank(b._display);
    if (ra !== rb) return ra - rb;
    return a.iata_code.localeCompare(b.iata_code);
  });

  const byCountry = rest.reduce((acc, a) => {
    const c = a.country || '—';
    if (!acc[c]) acc[c] = [];
    acc[c].push(a);
    return acc;
  }, {});
  const countries = Object.keys(byCountry).sort((a, b) => a.localeCompare(b));
  for (const c of countries) byCountry[c].sort((a, b) => a.iata_code.localeCompare(b.iata_code));

  return { top, countries, byCountry };
}
