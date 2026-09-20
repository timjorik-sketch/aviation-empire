// Mirroring one hub's flight numbers onto the airline's other hubs.
//
// The idea: you number ONE hub the way you want it, and every other hub copies
// it. Nothing about the numbering scheme is stored anywhere — the reference hub
// IS the pattern, read back from the numbers it already carries. A target route
// inherits the last `mask` digits of the reference hub's route to the same
// destination in the same direction, placed behind the target hub's own prefix:
//
//   CDG -> CPT = AB1101,  MUC prefix "2",  mask 3   =>  MUC -> CPT = AB2101
//
// So the leading digit stays hub-specific while region digit and destination
// serial are shared, which is what makes "SIN is always x201" hold across hubs.

// The 4-digit tail of a flight number ("AB1101" -> "1101"). Null if it does not
// end in four digits, e.g. a route that was never numbered to the scheme.
export function flightSuffix(flightNumber) {
  const m = /(\d{4})$/.exec(String(flightNumber || ''));
  return m ? m[1] : null;
}

// Build the mirror plan. Spans the whole route list on purpose (no page filter)
// so that ring swaps land in one batch and the backend's temp-park pass can
// resolve them; only rows flagged `changed` are meant to be submitted.
//
//   routes      [{ id, flight_number, departure_airport, arrival_airport }]
//   refHub      IATA of the hub that already has the numbering you want
//   targetHubs  IATA list of the hubs that should copy it
//   mask        digits inherited from the reference (1-3)
//   prefixOf    hub -> leading digits that stay hub-specific
//   airlineCode prefix of every flight number, e.g. "AB"
export function buildMatchPlan({ routes, refHub, targetHubs, mask, prefixOf, airlineCode }) {
  const empty = { rows: [], applyRows: [], hasConflict: false, total: 0, changed: 0 };
  if (!refHub || !Array.isArray(routes) || routes.length === 0) return empty;

  const prefixLen = 4 - mask;

  // What the reference hub flies, keyed by destination + direction.
  const refMap = new Map();
  for (const r of routes) {
    const suf = flightSuffix(r.flight_number);
    if (!suf) continue;
    if (r.departure_airport === refHub) refMap.set(`${r.arrival_airport}|out`, { suffix: suf, number: r.flight_number });
    else if (r.arrival_airport === refHub) refMap.set(`${r.departure_airport}|ret`, { suffix: suf, number: r.flight_number });
  }

  const holderOf = new Map();
  routes.forEach(r => holderOf.set(r.flight_number, r.id));

  const rows = [];
  const seen = new Set();
  for (const hub of targetHubs) {
    const prefix = prefixOf(hub);
    const prefixBad = prefix.length !== prefixLen;
    const hubRoutes = routes
      .filter(r => r.departure_airport === hub || r.arrival_airport === hub)
      .sort((a, b) => String(a.flight_number).localeCompare(String(b.flight_number)));
    for (const r of hubRoutes) {
      if (seen.has(r.id)) continue; // a hub-to-hub route belongs to one side only
      seen.add(r.id);
      const isOutbound = r.departure_airport === hub;
      const dest = isOutbound ? r.arrival_airport : r.departure_airport;
      const ref = refMap.get(`${dest}|${isOutbound ? 'out' : 'ret'}`);
      const base = {
        route_id: r.id, hub, oldNumber: r.flight_number,
        dep: r.departure_airport, arr: r.arrival_airport, isOutbound,
        refNumber: ref ? ref.number : null,
        newSuffix: null, newNumber: null, changed: false, conflict: false, reason: '',
      };
      // A leg between a target hub and the reference hub itself has no
      // destination to match on, and which prefix it should wear is a judgement
      // call — so it keeps its number.
      if (dest === refHub) { rows.push({ ...base, reason: `${refHub} leg — left alone` }); continue; }
      if (!ref) { rows.push({ ...base, reason: `not flown from ${refHub}` }); continue; }
      if (prefixBad) { rows.push({ ...base, conflict: true, reason: `${hub} needs a ${prefixLen}-digit prefix` }); continue; }
      const newSuffix = prefix + ref.suffix.slice(prefixLen);
      const newNumber = `${airlineCode}${newSuffix}`;
      rows.push({ ...base, newSuffix, newNumber, changed: newNumber !== r.flight_number });
    }
  }

  // Conflicts: two routes claiming one number, or a number held by a route this
  // run does not touch (so the temp-park pass can never free it).
  const claims = new Map();
  rows.forEach(r => {
    if (!r.newNumber) return;
    if (!claims.has(r.newNumber)) claims.set(r.newNumber, []);
    claims.get(r.newNumber).push(r);
  });
  const movingIds = new Set(rows.filter(r => r.changed).map(r => r.route_id));
  for (const [number, group] of claims) {
    if (group.length > 1) {
      group.forEach(r => { r.conflict = true; r.reason = 'two routes claim this number'; });
    }
    const holder = holderOf.get(number);
    if (holder !== undefined && !movingIds.has(holder) && !group.some(r => r.route_id === holder)) {
      group.forEach(r => { r.conflict = true; r.reason = 'number in use elsewhere'; });
    }
  }

  return {
    rows,
    applyRows: rows.filter(r => r.changed && !r.conflict),
    hasConflict: rows.some(r => r.conflict),
    total: rows.length,
    changed: rows.filter(r => r.changed).length,
  };
}

// The leading digits a hub's numbers already use most often — the prefix the
// modal proposes so the common case needs no typing.
export function suggestPrefix(routes, hub, prefixLen) {
  if (prefixLen <= 0) return '';
  const counts = new Map();
  for (const r of routes) {
    if (r.departure_airport !== hub && r.arrival_airport !== hub) continue;
    const suf = flightSuffix(r.flight_number);
    if (!suf) continue;
    const pre = suf.slice(0, prefixLen);
    counts.set(pre, (counts.get(pre) || 0) + 1);
  }
  let best = '', bestCount = 0;
  for (const [pre, n] of counts) if (n > bestCount) { best = pre; bestCount = n; }
  return best;
}
