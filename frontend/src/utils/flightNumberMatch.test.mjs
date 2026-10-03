// Scenarios for buildMatchPlan(). No test runner in this repo — run it with:
//   node frontend/src/utils/flightNumberMatch.test.mjs
import { buildMatchPlan, suggestPrefix } from './flightNumberMatch.js';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${extra}`); }
};
const R = (id, fn, dep, arr) => ({ id, flight_number: fn, departure_airport: dep, arrival_airport: arr });
const plan = (routes, opts = {}) => buildMatchPlan({
  routes, refHub: 'CDG', targetHubs: ['MUC'], mask: 3, airlineCode: 'AB',
  prefixOf: () => '2', ...opts,
});
const row = (p, dep, arr) => p.rows.find(r => r.dep === dep && r.arr === arr);

// Reference hub: CDG is numbered the way the player wants it.
const ref = [
  R(1, 'AB1101', 'CDG', 'CPT'), R(2, 'AB1102', 'CPT', 'CDG'),
  R(3, 'AB1201', 'CDG', 'SIN'), R(4, 'AB1202', 'SIN', 'CDG'),
];

console.log('\n1) mirrors region digit + serial, keeps the hub digit');
{
  const p = plan([...ref, R(5, 'AB2905', 'MUC', 'CPT'), R(6, 'AB2906', 'CPT', 'MUC'), R(7, 'AB2907', 'MUC', 'SIN')]);
  ok('MUC->CPT becomes 2101', row(p, 'MUC', 'CPT').newNumber === 'AB2101', row(p, 'MUC', 'CPT').newNumber);
  ok('CPT->MUC becomes 2102', row(p, 'CPT', 'MUC').newNumber === 'AB2102', row(p, 'CPT', 'MUC').newNumber);
  ok('MUC->SIN becomes 2201', row(p, 'MUC', 'SIN').newNumber === 'AB2201', row(p, 'MUC', 'SIN').newNumber);
  ok('no conflicts', p.hasConflict === false);
  ok('3 rows submitted', p.applyRows.length === 3, p.applyRows.length);
  ok('reference routes untouched', !p.rows.some(r => [1, 2, 3, 4].includes(r.route_id)));
}

console.log('\n2) mask 2 inherits only the serial — collision is caught');
{
  const p = plan([...ref, R(5, 'AB2905', 'MUC', 'CPT'), R(6, 'AB2907', 'MUC', 'SIN')],
    { mask: 2, prefixOf: () => '21' });
  ok('both claim AB2101', row(p, 'MUC', 'CPT').newNumber === 'AB2101' && row(p, 'MUC', 'SIN').newNumber === 'AB2101');
  ok('flagged as conflict', p.hasConflict === true);
  ok('reason names the clash', row(p, 'MUC', 'SIN').reason === 'two routes claim this number', row(p, 'MUC', 'SIN').reason);
  ok('nothing submitted', p.applyRows.length === 0);
}

console.log('\n3) destination the reference hub does not serve is left alone');
{
  const p = plan([...ref, R(5, 'AB2777', 'MUC', 'JFK')]);
  const r = row(p, 'MUC', 'JFK');
  ok('listed but not moved', r.changed === false && r.newNumber === null);
  ok('reason explains why', r.reason === 'not flown from CDG', r.reason);
  ok('no conflict', p.hasConflict === false);
  ok('nothing submitted', p.applyRows.length === 0);
}

console.log('\n4) already-correct route is listed as unchanged, not rewritten');
{
  const p = plan([...ref, R(5, 'AB2101', 'MUC', 'CPT'), R(6, 'AB2905', 'CPT', 'MUC')]);
  ok('MUC->CPT unchanged', row(p, 'MUC', 'CPT').changed === false);
  ok('CPT->MUC moves', row(p, 'CPT', 'MUC').newNumber === 'AB2102');
  ok('only the mover is submitted', p.applyRows.length === 1 && p.applyRows[0].route_id === 6);
  ok('changed count is 1', p.changed === 1 && p.total === 2);
}

console.log('\n5) target number held by a route this run does not touch');
{
  // A non-hub route already sits on AB2101 and is not part of the plan.
  const p = plan([...ref, R(5, 'AB2905', 'MUC', 'CPT'), R(9, 'AB2101', 'LHR', 'ACC')]);
  ok('conflict raised', p.hasConflict === true);
  ok('reason names it', row(p, 'MUC', 'CPT').reason === 'number in use elsewhere', row(p, 'MUC', 'CPT').reason);
}

console.log('\n6) ring swap inside the batch is allowed');
{
  // MUC currently has CPT and SIN the wrong way round — they trade numbers.
  const p = plan([...ref, R(5, 'AB2201', 'MUC', 'CPT'), R(6, 'AB2101', 'MUC', 'SIN')]);
  ok('CPT takes 2101', row(p, 'MUC', 'CPT').newNumber === 'AB2101');
  ok('SIN takes 2201', row(p, 'MUC', 'SIN').newNumber === 'AB2201');
  ok('no conflict — both are in the batch', p.hasConflict === false);
  ok('both submitted', p.applyRows.length === 2);
}

console.log('\n7) legs to the reference hub keep their numbers');
{
  const p = plan([...ref, R(5, 'AB2001', 'MUC', 'CDG'), R(6, 'AB2002', 'CDG', 'MUC')]);
  const legs = p.rows.filter(r => r.route_id === 5 || r.route_id === 6);
  ok('both legs listed', legs.length === 2, `${legs.length} rows`);
  ok('both left alone', legs.every(l => l.changed === false && l.reason === 'CDG leg — left alone'),
    legs.map(l => l.reason).join(' / '));
  ok('nothing submitted', p.applyRows.length === 0);
}

console.log('\n7b) a route between two target hubs is claimed exactly once');
{
  const routes = [...ref, R(5, 'AB2500', 'MUC', 'ZRH'), R(6, 'AB2905', 'MUC', 'CPT'), R(7, 'AB3905', 'ZRH', 'CPT')];
  const p = buildMatchPlan({ routes, refHub: 'CDG', targetHubs: ['MUC', 'ZRH'], mask: 3,
    airlineCode: 'AB', prefixOf: h => (h === 'MUC' ? '2' : '3') });
  ok('MUC->ZRH appears once', p.rows.filter(r => r.route_id === 5).length === 1);
  ok('no duplicate route_id in the batch', new Set(p.rows.map(r => r.route_id)).size === p.rows.length);
  ok('both hubs still get CPT', row(p, 'MUC', 'CPT').newNumber === 'AB2101' && row(p, 'ZRH', 'CPT').newNumber === 'AB3101');
}

console.log('\n8) incomplete prefix blocks the apply');
{
  const p = plan([...ref, R(5, 'AB2905', 'MUC', 'CPT')], { prefixOf: () => '' });
  ok('conflict raised', p.hasConflict === true);
  ok('reason asks for the prefix', row(p, 'MUC', 'CPT').reason === 'MUC needs a 1-digit prefix', row(p, 'MUC', 'CPT').reason);
}

console.log('\n9) several target hubs in one run');
{
  const routes = [...ref,
    R(5, 'AB2905', 'MUC', 'CPT'), R(6, 'AB2906', 'MUC', 'SIN'),
    R(7, 'AB3905', 'ZRH', 'CPT'), R(8, 'AB3906', 'ZRH', 'SIN')];
  const p = buildMatchPlan({ routes, refHub: 'CDG', targetHubs: ['MUC', 'ZRH'], mask: 3,
    airlineCode: 'AB', prefixOf: h => (h === 'MUC' ? '2' : '3') });
  ok('MUC block', row(p, 'MUC', 'CPT').newNumber === 'AB2101' && row(p, 'MUC', 'SIN').newNumber === 'AB2201');
  ok('ZRH block', row(p, 'ZRH', 'CPT').newNumber === 'AB3101' && row(p, 'ZRH', 'SIN').newNumber === 'AB3201');
  ok('no conflict across hubs', p.hasConflict === false);
  ok('4 submitted', p.applyRows.length === 4);
}

console.log('\n10) a route without a 4-digit tail cannot seed a pattern');
{
  const p = plan([...ref, R(5, 'AB77', 'CDG', 'BKK'), R(6, 'AB2905', 'MUC', 'BKK')]);
  ok('BKK left alone', row(p, 'MUC', 'BKK').reason === 'not flown from CDG');
}

console.log('\n11) prefix proposal reads the hub back from its own numbers');
{
  const routes = [R(1, 'AB2101', 'MUC', 'CPT'), R(2, 'AB2201', 'MUC', 'SIN'), R(3, 'AB3905', 'MUC', 'JFK')];
  ok('1-digit proposal is 2', suggestPrefix(routes, 'MUC', 1) === '2', suggestPrefix(routes, 'MUC', 1));
  ok('2-digit proposal is the most common', ['21', '22'].includes(suggestPrefix(routes, 'MUC', 2)), suggestPrefix(routes, 'MUC', 2));
  ok('unknown hub yields empty', suggestPrefix(routes, 'FRA', 1) === '');
}

console.log('\n12) skipHubToHub excludes legs between two own hubs');
{
  const hubs = new Set(['CDG', 'MUC', 'ZRH']);
  // CDG flies to ZRH, so without the switch MUC->ZRH would inherit that number.
  const routes = [...ref, R(5, 'AB1301', 'CDG', 'ZRH'),
    R(6, 'AB2905', 'MUC', 'ZRH'), R(7, 'AB2906', 'MUC', 'CPT')];

  const off = buildMatchPlan({ routes, refHub: 'CDG', targetHubs: ['MUC'], mask: 3,
    airlineCode: 'AB', prefixOf: () => '2', hubCodes: hubs, skipHubToHub: false });
  ok('off: MUC->ZRH inherits the CDG->ZRH tail', row(off, 'MUC', 'ZRH').newNumber === 'AB2301',
    row(off, 'MUC', 'ZRH').newNumber);
  ok('off: 2 submitted', off.applyRows.length === 2, off.applyRows.length);

  const on = buildMatchPlan({ routes, refHub: 'CDG', targetHubs: ['MUC'], mask: 3,
    airlineCode: 'AB', prefixOf: () => '2', hubCodes: hubs, skipHubToHub: true });
  ok('on: MUC->ZRH excluded', row(on, 'MUC', 'ZRH').changed === false && row(on, 'MUC', 'ZRH').newNumber === null);
  ok('on: reason says so', row(on, 'MUC', 'ZRH').reason === 'hub-to-hub — excluded', row(on, 'MUC', 'ZRH').reason);
  ok('on: still listed for transparency', on.total === off.total, `${on.total} vs ${off.total}`);
  ok('on: only the real destination is submitted',
    on.applyRows.length === 1 && on.applyRows[0].arr === 'CPT', on.applyRows.length);
  ok('on: no conflict', on.hasConflict === false);
}

console.log('\n13) excluding is safe without a hub set');
{
  // hubCodes omitted — the switch must not throw, it simply cannot apply.
  const p = plan([...ref, R(5, 'AB2905', 'MUC', 'CPT')], { skipHubToHub: true });
  ok('plan still builds', p.applyRows.length === 1 && row(p, 'MUC', 'CPT').newNumber === 'AB2101');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
