// Regenerates backend/src/database/runwayHeadings.js from OurAirports public-domain data.
//
// Usage:
//   curl -sSL -o /tmp/ourairports_airports.csv https://davidmegginson.github.io/ourairports-data/airports.csv
//   curl -sSL -o /tmp/ourairports_runways.csv  https://davidmegginson.github.io/ourairports-data/runways.csv
//   node backend/scripts/build_runway_headings.mjs

import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = resolve(__dirname, '../src/database/runwayHeadings.js');

// Minimal CSV parser that handles quoted fields with commas inside.
function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQuotes = false;
      } else cur += c;
    } else {
      if (c === ',') { out.push(cur); cur = ''; }
      else if (c === '"') inQuotes = true;
      else cur += c;
    }
  }
  out.push(cur);
  return out;
}

function loadCsv(path) {
  const text = readFileSync(path, 'utf8');
  const lines = text.split('\n').filter(l => l.length > 0);
  const headers = parseCsvLine(lines[0]);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = parseCsvLine(lines[i]);
    const obj = {};
    for (let j = 0; j < headers.length; j++) obj[headers[j]] = cells[j] ?? '';
    rows.push(obj);
  }
  return rows;
}

const airports = loadCsv('/tmp/ourairports_airports.csv');
const runways  = loadCsv('/tmp/ourairports_runways.csv');

// Build ident → iata
const identToIata = new Map();
for (const a of airports) {
  const ident = a.ident;
  const iata = a.iata_code;
  if (ident && iata && /^[A-Z]{3}$/.test(iata)) identToIata.set(ident, iata);
}

// For each airport_ident, find longest open runway with a numeric le_heading_degT.
const bestPerIdent = new Map();
for (const r of runways) {
  if (r.closed === '1') continue;
  const ident = r.airport_ident;
  const len = parseInt(r.length_ft, 10);
  const heading = parseFloat(r.le_heading_degT);
  if (!ident || !Number.isFinite(len) || !Number.isFinite(heading)) continue;
  const prev = bestPerIdent.get(ident);
  if (!prev || len > prev.len) {
    bestPerIdent.set(ident, { len, heading: Math.round(heading) % 360 });
  }
}

// Build IATA → heading
const result = {};
for (const [ident, info] of bestPerIdent) {
  const iata = identToIata.get(ident);
  if (!iata) continue;
  result[iata] = info.heading;
}

const sorted = Object.keys(result).sort();
const obj = {};
for (const k of sorted) obj[k] = result[k];

const out = `// Auto-generated from OurAirports runways.csv (public domain).
// Maps IATA code → primary runway true heading (degrees, 0-359).
// Heading represents the direction an aircraft is flying when landing on/taking off from the longest runway's "low end".
// Total entries: ${sorted.length}.
// Regenerate with backend/scripts/build_runway_headings.mjs.

export const RUNWAY_HEADINGS = ${JSON.stringify(obj, null, 0).replace(/,"/g, ',\n  "').replace(/^\{"/, '{\n  "').replace(/\}$/, '\n}')};
`;

writeFileSync(OUT_PATH, out);
console.log(`Wrote ${sorted.length} entries to ${OUT_PATH}`);
console.log(`Sample: LHR=${result.LHR}, JFK=${result.JFK}, FRA=${result.FRA}, NRT=${result.NRT}, SYD=${result.SYD}, ZRH=${result.ZRH}`);
