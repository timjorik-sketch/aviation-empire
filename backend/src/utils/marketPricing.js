// Market pricing model — single source of truth (audit C2).
//
// Anchors below were duplicated across flights.js and marketAnalyses.js. Both
// now import from here. Same numbers, same maths, no drift.
//
// `calcMarketPrices(distKm, depCat, arrCat)` returns a fair-market reference
// for a route (eco / biz / first). `getPriceBounds(...)` derives an acceptable
// player-set range around that reference; `validatePriceClamp(...)` is the
// one-call validator wired into POST/PATCH route + schedule handlers.

const BASE_RATE_ANCHORS = [
  { km: 0,     v: 0.22 },
  { km: 500,   v: 0.22 },
  { km: 1500,  v: 0.13 },
  { km: 3000,  v: 0.085 },
  { km: 6000,  v: 0.068 },
  { km: 10000, v: 0.060 },
  { km: 15000, v: 0.050 },
];
const BUSINESS_MULT_ANCHORS = [
  { km: 0,    v: 2.5 },
  { km: 1000, v: 2.5 },
  { km: 3000, v: 3.0 },
  { km: 6000, v: 4.0 },
];
const FIRST_MULT_ANCHORS = [
  { km: 0,    v: 5.0 },
  { km: 1000, v: 5.0 },
  { km: 3000, v: 7.0 },
  { km: 6000, v: 10.0 },
];

function interpolateAnchors(km, anchors) {
  if (km <= anchors[0].km) return anchors[0].v;
  if (km >= anchors[anchors.length - 1].km) return anchors[anchors.length - 1].v;
  for (let i = 0; i < anchors.length - 1; i++) {
    const lo = anchors[i], hi = anchors[i + 1];
    if (km >= lo.km && km <= hi.km) {
      const p = (km - lo.km) / (hi.km - lo.km);
      return lo.v + p * (hi.v - lo.v);
    }
  }
  return anchors[anchors.length - 1].v;
}

function calcBaseRate(d) {
  return interpolateAnchors(d, BASE_RATE_ANCHORS);
}

function calcAirportPremium(cat1, cat2) {
  const P = { 8: 1.5, 7: 1.4, 6: 1.3, 5: 1.2, 4: 1.15, 3: 1.05, 2: 1.0, 1: 0.9 };
  return ((P[cat1] || 1.0) + (P[cat2] || 1.0)) / 2;
}

export function calcMarketPrices(distKm, depCat, arrCat) {
  const eco = Math.round(distKm * calcBaseRate(distKm) * calcAirportPremium(depCat, arrCat));
  return {
    eco,
    biz:   Math.round(eco * interpolateAnchors(distKm, BUSINESS_MULT_ANCHORS)),
    first: Math.round(eco * interpolateAnchors(distKm, FIRST_MULT_ANCHORS)),
  };
}

// Acceptable player-set bounds around the market reference.
//
// Lower 0.5× lets you discount aggressively (e.g. promo) without breaking the
// demand model — anything below is griefing. Upper 2.0× lets you charge a
// premium (e.g. business-heavy cabin on a leisure route) without breaking
// pax demand at the high end. HARD_MIN is a per-class floor; market×0.5
// could otherwise collapse to $0 on cheap short-haul anchors.
const LOWER_FACTOR = 0.5;
const UPPER_FACTOR = 2.0;
const HARD_MIN = 5;

export function getPriceBounds(distKm, depCat, arrCat) {
  const market = calcMarketPrices(distKm, depCat, arrCat);
  const bound = (m) => ({
    market: m,
    min: Math.max(HARD_MIN, Math.round(m * LOWER_FACTOR)),
    max: Math.round(m * UPPER_FACTOR),
  });
  return { eco: bound(market.eco), biz: bound(market.biz), first: bound(market.first) };
}

/**
 * Validate user-supplied prices against the market band. Returns null on
 * success; returns { error, details } on the first violation. Each price
 * argument may be null/undefined (e.g. business_price not set on an
 * eco-only route) — only set values are checked.
 */
export function validatePriceClamp({ distKm, depCat, arrCat, eco, biz, first }) {
  if (!distKm || distKm <= 0) return null; // can't clamp without a distance — skip rather than block
  const bounds = getPriceBounds(distKm, depCat, arrCat);

  const check = (label, value, b) => {
    if (value === null || value === undefined) return null;
    const v = Number(value);
    if (!Number.isFinite(v)) return `${label} price must be a number`;
    if (v < b.min) return `${label} price $${v} is below the minimum $${b.min} for this route (market: $${b.market})`;
    if (v > b.max) return `${label} price $${v} exceeds the maximum $${b.max} for this route (market: $${b.market})`;
    return null;
  };

  for (const [label, value, b] of [
    ['Economy',  eco,   bounds.eco],
    ['Business', biz,   bounds.biz],
    ['First',    first, bounds.first],
  ]) {
    const msg = check(label, value, b);
    if (msg) return { error: msg, bounds };
  }
  return null;
}
