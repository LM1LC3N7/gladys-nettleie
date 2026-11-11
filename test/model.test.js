// -----------------------------------------------------------------------------
// The pure parts: local time, holidays, the fri-nettleie model, the rates,
// the pricing, the capacity step, the catalog, the spot and NVE parsers.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Catalog, CompanyError, loadSnapshot, normalizeName } from '../src/catalog.js';
import { emptyRecord, hoursOf, monthKwh, peakOf, recordIntervals } from '../src/capacity.js';
import { InputError, readInputs } from '../src/contract.js';
import { easter, isHoliday } from '../src/holidays.js';
import { compareDay, parseNveDay } from '../src/nve.js';
import { SpotMissing, capOf, currentPrice, priceIntervals } from '../src/pricing.js';
import { RateError, checkRates, norgesprisOn, supportThreshold, taxesOn } from '../src/rates.js';
import { checkSpotCache, parseSpotDay, priceIn, pruneSpot, spotUrl } from '../src/spot.js';
import {
  TariffError,
  capacityStep,
  checkCompany,
  energyPrice,
  parseHours,
  tariffOn,
} from '../src/tariffs.js';
import { nextDate, oslo, osloMidnight, parseInstant, previousMonth } from '../src/time.js';
import { readFileSync } from 'node:fs';

const fixture = (name) =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
const HVA = fixture('hvakosterstrommen-2026-11-10-NO1.json');
const NVE_BKK = fixture('nve-bkk-2026-11-11.json');

const snapshot = loadSnapshot();
const catalog = new Catalog(snapshot);
const RATES = catalog.rates();
const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

/** A company document with one tariff (fri-nettleie format). */
function doc(tariff = {}, extra = {}) {
  return {
    netteier: 'Test Nett AS',
    gln: ['7080000000001'],
    sist_oppdatert: '2026-10-01',
    kilder: ['https://example.com/nettleie'],
    tariffer: [
      {
        kundegrupper: ['husholdning', 'fritid'],
        gyldig_fra: '2026-01-01',
        fastledd: {
          metode: 'TRE_DØGNMAX_MND',
          terskel_inkludert: true,
          terskler: [
            { terskel: 0, pris: 1200 },
            { terskel: 2, pris: 2400 },
            { terskel: 5, pris: 4800 },
          ],
        },
        energiledd: {
          grunnpris: 10,
          unntak: [{ navn: 'Dag', timer: '6-21', dager: ['virkedag'], pris: 20 }],
        },
        ...tariff,
      },
    ],
    ...extra,
  };
}
const company = (tariff, extra) => checkCompany(doc(tariff, extra)).company;
const settings = (inputs = {}) =>
  readInputs({ grid_company: 'test', price_area: 'NO1', ...inputs });
const ctx = (c = company(), spot = () => 1) => ({ company: c, rates: RATES, spot });

// --- time and holidays -------------------------------------------------------------

test('Oslo local time across the changes of time', () => {
  // Summer time ends on 25 October 2026 at 03:00 (02:00 twice).
  assert.equal(oslo(Date.parse('2026-10-25T00:30:00Z')).h, 2);
  assert.equal(oslo(Date.parse('2026-10-25T01:30:00Z')).h, 2);
  assert.equal(oslo(Date.parse('2026-10-25T02:30:00Z')).h, 3);
  // Summer time starts on 29 March 2026 at 02:00 (hour 2 skipped).
  assert.equal(oslo(Date.parse('2026-03-29T00:30:00Z')).h, 1);
  assert.equal(oslo(Date.parse('2026-03-29T01:30:00Z')).h, 3);
  assert.equal(osloMidnight('2026-07-01'), Date.parse('2026-06-30T22:00:00Z'));
  assert.equal(osloMidnight('2026-12-01'), Date.parse('2026-11-30T23:00:00Z'));
  assert.equal(osloMidnight('2026-02-30'), undefined);
  assert.equal(nextDate('2026-12-31'), '2027-01-01');
  assert.equal(previousMonth('2026-01'), '2025-12');
  assert.equal(oslo(Date.parse('2026-11-30T23:30:00Z')).month, '2026-12');
  assert.equal(oslo(Date.parse('2026-11-11T08:00:00Z')).weekday, 3);
  assert.equal(parseInstant('2026-11-11T08:00:00.000Z'), Date.parse('2026-11-11T08:00:00Z'));
  assert.equal(parseInstant('11/11/2026'), undefined);
  assert.equal(parseInstant(12), undefined);
});

test('Norwegian public holidays', () => {
  assert.deepEqual(easter(2026), [4, 5]);
  assert.deepEqual(easter(2025), [4, 20]);
  for (const d of ['2026-04-02', '2026-04-03', '2026-04-06', '2026-05-14', '2026-05-25']) {
    assert.ok(isHoliday(d), d);
  }
  for (const d of ['2026-01-01', '2026-05-01', '2026-05-17', '2026-12-25', '2026-12-26']) {
    assert.ok(isHoliday(d), d);
  }
  assert.ok(!isHoliday('2026-04-07'));
  assert.ok(!isHoliday('2026-12-24'));
});

// --- fri-nettleie model ------------------------------------------------------------

test('hours: spans, over midnight, lists; anything else refused', () => {
  assert.deepEqual(
    parseHours('6-21'),
    [6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21],
  );
  assert.deepEqual(parseHours('22-5'), [0, 1, 2, 3, 4, 5, 22, 23]);
  assert.deepEqual(parseHours('7'), [7]);
  assert.deepEqual(parseHours('6-8,16-17'), [6, 7, 8, 16, 17]);
  assert.deepEqual(parseHours(7), [7]);
  for (const bad of ['6-24', 'a-b', '', '6--8', '25']) {
    const { company: c, problems } = checkCompany(
      doc({ energiledd: { grunnpris: 1, unntak: [{ timer: bad, pris: 2 }] } }),
    );
    assert.equal(c.tariffs.length, 0, bad);
    assert.equal(problems.length, 1, bad);
  }
});

test('a tariff out of the format is dropped with a reason, never guessed', () => {
  const bad = [
    { gyldig_fra: '2026-13-01' },
    { gyldig_til: '2025-01-01' },
    { kundegrupper: ['husholdning', 'industri'] },
    { energiledd: { grunnpris: '10' } },
    { energiledd: { grunnpris: 10, unntak: [{ navn: 'Dag', pris: 'x' }] } },
    { energiledd: { grunnpris: 10, unntak: [{ pris: 2, dager: ['onsdag', 'ferie'] }] } },
    { energiledd: { grunnpris: 10, unntak: [{ pris: 2, måneder: ['jan'] }] } },
    { fastledd: { metode: 'NY', terskel_inkludert: true, terskler: [{ terskel: 0, pris: 1 }] } },
    { fastledd: { metode: 'TRE_DØGNMAX_MND', terskel_inkludert: 'ja', terskler: [] } },
    {
      fastledd: {
        metode: 'TRE_DØGNMAX_MND',
        terskel_inkludert: true,
        terskler: [
          { terskel: 0, pris: 1 },
          { terskel: 0, pris: 2 },
        ],
      },
    },
    {
      fastledd: {
        metode: 'MND_MAX',
        terskel_inkludert: true,
        terskler: [{ terskel: -1, pris: 1 }],
      },
    },
  ];
  for (const t of bad) {
    const { company: c, problems } = checkCompany(doc(t));
    assert.equal(c.tariffs.length, 0, JSON.stringify(t));
    assert.match(problems[0], /^tariff 1: /);
  }
  assert.equal(checkCompany(null).company, null);
  assert.equal(checkCompany(doc({}, { netteier: 'x\u0007' })).company, null);
  assert.equal(checkCompany(doc({}, { sist_oppdatert: 'soon' })).company, null);
  assert.equal(checkCompany(doc({}, { tariffer: 'many' })).company, null);
  // A tariff for business customers only is not offered (no error).
  const pro = checkCompany(doc({ kundegrupper: ['liten_næring'] }));
  assert.equal(pro.company.tariffs.length, 0);
  assert.equal(pro.problems.length, 0);
});

test('every company of the snapshot passes the checks with tariffs', () => {
  assert.ok(catalog.slugs.length >= 70);
  for (const slug of catalog.slugs) {
    const { company: c, problems } = checkCompany(snapshot.companies[slug].doc);
    assert.ok(c, slug);
    assert.deepEqual(problems, [], slug);
  }
  assert.match(snapshot.source.commit, /^[0-9a-f]{40}$/);
  assert.equal(snapshot.source.license, 'CC-BY-4.0');
});

test('the tariff of a date: periods, groups, names', () => {
  const c = company();
  assert.equal(tariffOn(c, { group: 'husholdning', date: '2026-11-11' }).base, 10);
  assert.throws(
    () => tariffOn(c, { group: 'husholdning', date: '2025-12-31' }),
    (e) => e instanceof TariffError && e.code === 'no_tariff',
  );
  const two = checkCompany(
    doc(
      {},
      {
        tariffer: [
          { ...doc().tariffer[0], navn: 'Nord' },
          { ...doc().tariffer[0], navn: 'Sør', energiledd: { grunnpris: 30 } },
        ],
      },
    ),
  ).company;
  assert.throws(
    () => tariffOn(two, { group: 'fritid', date: '2026-06-01' }),
    (e) => e.code === 'ambiguous' && e.names.join() === 'Nord,Sør',
  );
  assert.equal(tariffOn(two, { group: 'fritid', name: 'sør', date: '2026-06-01' }).base, 30);
  assert.throws(
    () => tariffOn(two, { group: 'fritid', name: 'Vest', date: '2026-06-01' }),
    (e) => e.code === 'no_tariff' && e.names.join() === 'Nord,Sør',
  );
  // gyldig_til is exclusive.
  const ended = company({ gyldig_til: '2026-07-01' });
  assert.ok(tariffOn(ended, { group: 'husholdning', date: '2026-06-30' }));
  assert.throws(() => tariffOn(ended, { group: 'husholdning', date: '2026-07-01' }));
});

test('energy price: hours, working days, holidays, months, the last match wins', () => {
  const t = tariffOn(company(), { group: 'husholdning', date: '2026-11-11' });
  const at = (iso) => energyPrice(t, oslo(Date.parse(iso))).ore;
  assert.equal(at('2026-11-11T05:00:00Z'), 20); // 06:00 local, Wednesday
  assert.equal(at('2026-11-11T04:59:00Z'), 10); // 05:59
  assert.equal(at('2026-11-11T20:30:00Z'), 20); // 21:30
  assert.equal(at('2026-11-11T21:00:00Z'), 10); // 22:00
  assert.equal(at('2026-11-14T10:00:00Z'), 10); // Saturday
  assert.equal(at('2026-12-25T10:00:00Z'), 10); // Christmas, a Friday
  assert.equal(at('2026-05-14T10:00:00Z'), 10); // Ascension (summer time)
  const seasons = tariffOn(
    company({
      energiledd: {
        grunnpris: 10,
        unntak: [
          { navn: 'Vinter', måneder: ['januar', 'februar', 'mars'], pris: 15 },
          { navn: 'Vinter dag', måneder: ['januar'], timer: '6-21', pris: 25 },
          { navn: 'Natt', timer: '22-5', dager: ['helg'], pris: 5 },
        ],
      },
    }),
    { group: 'husholdning', date: '2027-01-05' },
  );
  const s = (iso) => energyPrice(seasons, oslo(Date.parse(iso))).ore;
  assert.equal(s('2027-01-05T10:00:00Z'), 25);
  assert.equal(s('2027-02-05T10:00:00Z'), 15);
  assert.equal(s('2027-04-05T10:00:00Z'), 10);
  assert.equal(s('2027-04-03T23:30:00Z'), 5); // Sunday 00:30
});

test('Elvia from the snapshot: 28.99 / 16.99 øre since 1 July 2026', () => {
  const elvia = catalog.company('elvia');
  const t = tariffOn(elvia, { group: 'husholdning', date: '2026-11-11' });
  assert.equal(energyPrice(t, oslo(Date.parse('2026-11-11T08:00:00Z'))).ore, 28.99);
  assert.equal(energyPrice(t, oslo(Date.parse('2026-11-11T22:00:00Z'))).ore, 16.99);
  assert.equal(t.capacity.method, 'TRE_DØGNMAX_MND');
});

test('capacity step: thresholds included or not, unknown side', () => {
  const cap = (included) => ({
    method: 'TRE_DØGNMAX_MND',
    included,
    steps: [
      { from: 0, yearly: 1200 },
      { from: 2, yearly: 2400 },
      { from: 5, yearly: 4800 },
    ],
  });
  assert.deepEqual(capacityStep(cap(true), 1.9), { index: 0, from: 0, next: 2, monthly: 100 });
  assert.equal(capacityStep(cap(true), 2).index, 1);
  assert.equal(capacityStep(cap(false), 2).index, 0);
  assert.equal(capacityStep(cap(false), 2.001).index, 1);
  assert.equal(capacityStep(cap(null), 2), null);
  assert.equal(capacityStep(cap(null), 2.5).index, 1);
  assert.deepEqual(capacityStep(cap(true), 9), { index: 2, from: 5, next: null, monthly: 400 });
  assert.equal(capacityStep(cap(true), NaN), null);
  assert.equal(capacityStep(cap(true), -1), null);
});

// --- rates -------------------------------------------------------------------------

test('taxes by zone and date; a year the rates do not cover is unknown', () => {
  assert.deepEqual(taxesOn(RATES, 'south', '2026-11-11'), { vat: 0.25, taxOre: 8.13 });
  assert.deepEqual(taxesOn(RATES, 'north', '2026-11-11'), { vat: 0, taxOre: 8.13 });
  assert.deepEqual(taxesOn(RATES, 'tiltakssone', '2026-11-11'), { vat: 0, taxOre: 1 });
  close(taxesOn(RATES, 'south', '2025-05-01').taxOre, 17.93);
  close(taxesOn(RATES, 'south', '2025-10-01').taxOre, 13.53);
  assert.throws(() => taxesOn(RATES, 'south', '2027-01-01'), RateError);
  assert.throws(() => taxesOn(RATES, 'south', '2024-12-31'), RateError);
  assert.throws(() => taxesOn(RATES, 'east', '2026-01-01'), RateError);
  assert.throws(() => taxesOn(null, 'south', '2026-01-01'), RateError);
  // A rate of 2027 (or a verification in 2027) extends the years covered.
  const next = checkRates({ ...snapshot.rates, sist_verifisert: '2027-01-15' });
  assert.equal(taxesOn(next, 'south', '2027-06-01').taxOre, 8.13);
  assert.equal(checkRates({ ...snapshot.rates, mva: { sats: 'x' } }), null);
  assert.equal(
    checkRates({
      ...snapshot.rates,
      forbruksavgift: { satser: [{ fra: '2026', ore_per_kwh: 1 }] },
    }),
    null,
  );
});

test('strømstøtte threshold and Norgespris dates', () => {
  assert.equal(supportThreshold('2025-06-01'), 0.75);
  assert.equal(supportThreshold('2026-06-01'), 0.77);
  assert.throws(() => supportThreshold('2027-01-01'), RateError);
  assert.equal(norgesprisOn('2025-10-01'), 0.4);
  assert.equal(norgesprisOn('2026-12-31'), 0.4);
  assert.throws(() => norgesprisOn('2025-09-30'), RateError);
  assert.throws(() => norgesprisOn('2027-01-01'), RateError);
});

// --- inputs ------------------------------------------------------------------------

test('contract inputs: defaults, refusals, never a silent default for a wrong value', () => {
  assert.deepEqual(readInputs({ grid_company: ' Elvia ' }), {
    company: 'Elvia',
    tariffName: '',
    group: 'husholdning',
    zone: 'south',
    supply: 'grid_only',
    area: null,
    markup: 0,
  });
  assert.throws(() => readInputs({ grid_company: 'x', supply: 'spot' }), /price_area is needed/);
  assert.equal(
    readInputs({ grid_company: 'x', supply: 'norgespris', price_area: 'NO5' }).area,
    'NO5',
  );
  assert.equal(readInputs({ grid_company: 'x', customer_group: 'holiday_home' }).group, 'fritid');
  assert.equal(readInputs({ grid_company: 'x', supplier_markup: '0.05' }).markup, 0.05);
  for (const bad of [
    {},
    { grid_company: '  ' },
    { grid_company: 'a\nb' },
    { grid_company: 'x', customer_group: 'constructor' },
    { grid_company: 'x', customer_group: '__proto__' },
    { grid_company: 'x', tax_zone: 'east' },
    { grid_company: 'x', supply: 'fixed' },
    { grid_company: 'x', price_area: 'SE3' },
    { grid_company: 'x', supplier_markup: 6 },
    { grid_company: 'x', supplier_markup: 'abc' },
    { grid_company: 'x', supplier_markup: Infinity },
  ]) {
    assert.throws(() => readInputs(bad), InputError, JSON.stringify(bad));
  }
});

// --- pricing -----------------------------------------------------------------------

const iv = (iso, kwh = 1) => ({ starts_at: iso, kwh, max_power_kw: 0 });

test('grid only: energiledd + consumption tax + Enova, VAT by zone', () => {
  const costs = priceIntervals(
    [iv('2026-11-11T08:00:00.000Z'), iv('2026-11-11T22:00:00.000Z', 2)],
    0,
    settings(),
    ctx(),
  );
  // (20 + 7.13 + 1) * 1.25 / 100 and (10 + 8.13) * 1.25 / 100 * 2
  close(costs[0].cost, 0.351625);
  close(costs[1].cost, 0.45325);
  assert.equal(costs[0].label, 'Nettleie');
  assert.equal(costs[0].starts_at, '2026-11-11T08:00:00.000Z');
  close(
    priceIntervals([iv('2026-11-11T08:00:00Z')], 0, settings({ tax_zone: 'north' }), ctx())[0].cost,
    0.2813,
  );
  close(
    priceIntervals([iv('2026-11-11T08:00:00Z')], 0, settings({ tax_zone: 'tiltakssone' }), ctx())[0]
      .cost,
    0.21,
  );
  assert.deepEqual(priceIntervals([], 0, settings(), ctx()), []);
});

test('the autumn night: both 02:00 hours are hour 2, priced', () => {
  const c = company({
    gyldig_fra: '2026-01-01',
    energiledd: { grunnpris: 10, unntak: [{ navn: 'To', timer: '2', pris: 50 }] },
  });
  const costs = priceIntervals(
    [iv('2026-10-25T00:00:00Z'), iv('2026-10-25T01:00:00Z'), iv('2026-10-25T02:00:00Z')],
    0,
    settings(),
    ctx(c),
  );
  close(costs[0].cost, (50 + 8.13) * 0.0125);
  close(costs[1].cost, (50 + 8.13) * 0.0125);
  close(costs[2].cost, (10 + 8.13) * 0.0125);
});

test('spot: interval mean, strømstøtte on the hour mean above the threshold, 5,000 kWh cap', () => {
  // Quarters of 08:00-09:00 UTC: 1.0, 1.4, 2.2, 1.0 NOK -> hour mean 1.4.
  const prices = {
    [Date.parse('2026-11-11T08:00:00Z')]: 1.0,
    [Date.parse('2026-11-11T08:15:00Z')]: 1.4,
    [Date.parse('2026-11-11T08:30:00Z')]: 2.2,
    [Date.parse('2026-11-11T08:45:00Z')]: 1.0,
  };
  const spot = (area, ms) => (area === 'NO2' ? prices[ms] : undefined);
  const s = settings({ supply: 'spot', price_area: 'NO2', supplier_markup: 0.1 });
  const grid = (20 + 8.13) * 0.0125;
  const support = 0.9 * (1.4 - 0.77) * 1.25;
  const [a, b] = priceIntervals(
    [iv('2026-11-11T08:00:00Z'), iv('2026-11-11T08:30:00Z')],
    0,
    s,
    ctx(company(), spot),
  );
  close(a.cost, grid + (1.2 + 0.1) * 1.25 - support);
  close(b.cost, grid + (1.6 + 0.1) * 1.25 - support);
  assert.equal(a.label, 'Nettleie + spot');
  // 4,999.5 kWh before: half a kWh with the support, the rest without.
  const [split] = priceIntervals([iv('2026-11-11T08:00:00Z', 2)], 4999.5, s, ctx(company(), spot));
  close(split.cost, 2 * grid + 2 * (1.3 * 1.25) - 0.5 * support);
  // A holiday home has no support and no cap.
  const cabin = settings({ supply: 'spot', price_area: 'NO2', customer_group: 'holiday_home' });
  close(
    priceIntervals([iv('2026-11-11T08:00:00Z')], 0, cabin, ctx(company(), spot))[0].cost,
    grid + 1.5,
  );
  assert.equal(capOf(cabin), null);
  // A missing quarter: no cost, never a zero.
  assert.throws(
    () => priceIntervals([iv('2026-11-11T09:00:00Z')], 0, s, ctx(company(), spot)),
    (e) =>
      e instanceof SpotMissing && e.area === 'NO2' && e.at === Date.parse('2026-11-11T09:00:00Z'),
  );
});

test('Norgespris: 40 øre within the cap (1,000 kWh for a holiday home), spot beyond', () => {
  const s = settings({ supply: 'norgespris', supplier_markup: 0.02 });
  const grid = (20 + 8.13) * 0.0125;
  const noSpot = () => undefined;
  const [inCap] = priceIntervals([iv('2026-11-11T08:00:00Z')], 100, s, ctx(company(), noSpot));
  close(inCap.cost, grid + 0.42 * 1.25);
  assert.throws(
    () => priceIntervals([iv('2026-11-11T08:00:00Z', 2)], 4999, s, ctx(company(), noSpot)),
    SpotMissing,
  );
  const [beyond] = priceIntervals(
    [iv('2026-11-11T08:00:00Z', 2)],
    4999,
    s,
    ctx(company(), () => 2),
  );
  close(beyond.cost, 2 * grid + 0.42 * 1.25 + 2.02 * 1.25);
  const cabin = settings({ supply: 'norgespris', customer_group: 'holiday_home' });
  assert.equal(capOf(cabin), 1000);
  const [c] = priceIntervals(
    [iv('2026-11-11T08:00:00Z')],
    999.5,
    cabin,
    ctx(company(), () => 3),
  );
  close(c.cost, grid + 0.5 * 0.4 * 1.25 + 0.5 * 3 * 1.25);
  // Before October 2025 and after 2026: unknown.
  assert.throws(
    () => priceIntervals([iv('2027-01-02T08:00:00Z')], 0, s, ctx(company(), noSpot)),
    RateError,
  );
});

test('the cap of a new local month starts again from zero, in time order', () => {
  const s = settings({ supply: 'norgespris' });
  const spot = () => 2;
  const costs = priceIntervals(
    [iv('2026-11-30T23:00:00Z', 3), iv('2026-11-30T22:30:00Z', 3)],
    4998,
    s,
    ctx(company(), spot),
  );
  const grid = (10 + 8.13) * 0.0125;
  // 22:30 UTC = 23:30 on 30 November: 2 kWh within, 1 beyond.
  close(costs[1].cost, 3 * grid + 2 * 0.5 + 1 * 2 * 1.25);
  // 23:00 UTC = 00:00 on 1 December: a new month, all within.
  close(costs[0].cost, 3 * grid + 3 * 0.5);
  assert.throws(() => priceIntervals([iv('2026-11-11T08:00:00Z')], NaN, s, ctx()), /month before/);
});

test('a negative total counts as zero; an unreadable interval or unknown rates throw', () => {
  const s = settings({ supply: 'spot', customer_group: 'holiday_home' });
  const [neg] = priceIntervals(
    [iv('2026-11-11T08:00:00Z')],
    0,
    s,
    ctx(company(), () => -2),
  );
  assert.equal(neg.cost, 0);
  assert.throws(
    () => priceIntervals([{ starts_at: 'now', kwh: 1 }], 0, settings(), ctx()),
    /interval 0/,
  );
  assert.throws(
    () => priceIntervals([iv('2026-11-11T08:00:00Z', -1)], 0, settings(), ctx()),
    /interval 0/,
  );
  assert.throws(
    () => priceIntervals([iv('2026-11-11T08:00:00Z', NaN)], 0, settings(), ctx()),
    /interval 0/,
  );
  assert.throws(
    () => priceIntervals([iv('2026-11-11T08:00:00Z')], 0, settings(), { ...ctx(), rates: null }),
    RateError,
  );
  assert.throws(
    () => priceIntervals([iv('2025-11-11T08:00:00Z')], 0, settings(), ctx()),
    TariffError,
  );
});

test('current price: the next kWh, its end and the next price', () => {
  const now = Date.parse('2026-11-11T20:40:00Z'); // 21:40 local
  const p = currentPrice(now, 0, settings(), ctx());
  close(p.price, (20 + 8.13) * 0.0125);
  assert.equal(p.valid_until, '2026-11-11T21:00:00.000Z');
  close(p.next_price, (10 + 8.13) * 0.0125);
  const spot = currentPrice(
    now,
    6000,
    settings({ supply: 'spot' }),
    ctx(company(), () => 1),
  );
  assert.equal(spot.valid_until, '2026-11-11T21:00:00.000Z');
  close(spot.price, (20 + 8.13) * 0.0125 + 1.25);
  const unknown = currentPrice(
    now,
    0,
    settings({ supply: 'spot' }),
    ctx(company(), (a, ms) => (ms < Date.parse('2026-11-11T21:00:00Z') ? 1 : undefined)),
  );
  assert.equal(unknown.next_price, null);
});

// --- capacity ----------------------------------------------------------------------

test('capacity: hours from half hours, the three highest days, the highest hour', () => {
  const record = emptyRecord();
  const now = Date.parse('2026-11-20T12:00:00Z');
  const put = (iso, kwh) => ({ start: Date.parse(iso), kwh });
  recordIntervals(
    record,
    [
      put('2026-11-02T17:00:00Z', 3),
      put('2026-11-02T17:30:00Z', 4), // 7 kWh in the hour
      put('2026-11-02T18:00:00Z', 2),
      put('2026-11-02T18:30:00Z', 4), // same day, 6
      put('2026-11-03T07:00:00Z', 2.5),
      put('2026-11-03T07:30:00Z', 2.5), // 5
      put('2026-11-04T07:00:00Z', 1),
      put('2026-11-04T07:30:00Z', 2), // 3
      put('2026-11-05T07:00:00Z', 1), // 1 (half known)
      put('2026-10-31T22:30:00Z', 9), // 23:30 on 31 October: another month
    ],
    now,
  );
  const peak = peakOf(record, '2026-11', 'TRE_DØGNMAX_MND');
  assert.equal(peak.kw, 5);
  assert.deepEqual(peak.days, ['2026-11-02', '2026-11-03', '2026-11-04']);
  assert.equal(peakOf(record, '2026-11', 'MND_MAX').kw, 7);
  assert.equal(peakOf(record, '2026-11', 'FEM_VEKTET_ÅR'), null);
  assert.equal(peakOf(record, '2026-09', 'MND_MAX'), null);
  assert.equal(peakOf(record, '2026-10', 'MND_MAX').kw, 9);
  assert.equal(monthKwh(record, '2026-11'), 22);
  assert.equal(hoursOf(record, '2026-11').find((h) => h.date === '2026-11-05').complete, false);
  // A recalculation replaces a value, never adds it twice.
  recordIntervals(record, [put('2026-11-02T17:30:00Z', 1)], now);
  assert.equal(peakOf(record, '2026-11', 'MND_MAX').kw, 6);
  // A day with fewer than three days known: their mean.
  const one = recordIntervals(emptyRecord(), [put('2026-11-02T17:00:00Z', 2)], now);
  assert.equal(peakOf(one, '2026-11', 'TRE_DØGNMAX_MND').kw, 2);
  // Only the current and the previous month are kept; nothing far in the future.
  recordIntervals(record, [put('2026-12-01T10:00:00Z', 1)], Date.parse('2026-12-10T00:00:00Z'));
  assert.ok(
    Object.keys(record.intervals).every((k) => Number(k) >= Date.parse('2026-10-31T23:00:00Z')),
  );
  recordIntervals(
    record,
    [put('2027-01-01T10:00:00Z', 1), { start: NaN, kwh: 1 }, put('2026-12-02T10:00:00Z', -1)],
    Date.parse('2026-12-10T00:00:00Z'),
  );
  assert.equal(record.intervals[Date.parse('2027-01-01T10:00:00Z')], undefined);
  assert.equal(record.intervals[Date.parse('2026-12-02T10:00:00Z')], undefined);
});

// --- catalog -----------------------------------------------------------------------

test('catalog: a company by file name, GLN, organisation number or name', () => {
  assert.equal(catalog.resolve('elvia'), 'elvia');
  assert.equal(catalog.resolve('Elvia AS'), 'elvia');
  assert.equal(catalog.resolve('7080005046220'), 'elvia');
  assert.equal(catalog.resolve('980 489 698'), 'elvia');
  assert.equal(catalog.resolve('TENSIO-TN'), 'tensio-tn');
  assert.equal(catalog.resolve('Høland og Setskog Elverk'), 'holandogsetskogelverk');
  assert.throws(() => catalog.resolve(''), CompanyError);
  assert.throws(
    () => catalog.resolve('Area Nett'),
    (e) => e instanceof CompanyError && e.suggestions.length > 1,
  );
  assert.throws(
    () => catalog.resolve('Statkraft'),
    (e) => e.suggestions.length === 0,
  );
  assert.equal(normalizeName('BKK AS '), 'bkk');
  assert.ok(catalog.dataOf('elvia').updated >= '2026-06-05');
  assert.equal(catalog.dataOf('nope'), null);
});

test('catalog: a file read again overrides the snapshot; the snapshot stays the fallback', () => {
  const c = new Catalog(snapshot);
  const live = company({}, { netteier: 'Elvia AS' });
  c.setLive('elvia', live, '"etag"', 123);
  assert.equal(c.company('elvia'), live);
  assert.equal(c.dataOf('elvia').read, 123);
  assert.notEqual(c.company('bkk'), null);
});

// --- spot and NVE ------------------------------------------------------------------

test('spot: a whole local day of Hva koster strømmen.no, hour by hour, kept 62 days', () => {
  const day = parseSpotDay(HVA, '2026-11-10');
  assert.equal(day.length, 24);
  assert.equal(day[0][0], Date.parse('2026-11-09T23:00:00Z'));
  assert.equal(day[0][2], 2.0612);
  assert.equal(priceIn({ slots: day }, Date.parse('2026-11-09T23:40:00Z')), 2.0612);
  assert.equal(priceIn({ slots: day }, Date.parse('2026-11-10T23:00:00Z')), undefined);
  assert.equal(
    spotUrl('2026-11-10', 'NO5'),
    'https://www.hvakosterstrommen.no/api/v1/prices/2026/11-10_NO5.json',
  );
  assert.throws(() => spotUrl('2026-11-10', 'SE3'));
  // Not the whole day: refused, never kept in part.
  assert.equal(parseSpotDay(HVA.slice(0, 23), '2026-11-10'), null);
  assert.equal(parseSpotDay(HVA, '2026-11-11'), null);
  assert.equal(parseSpotDay([...HVA.slice(0, 5), ...HVA.slice(6)], '2026-11-10'), null);
  assert.equal(
    parseSpotDay(
      HVA.map((e, i) => (i === 3 ? { ...e, NOK_per_kWh: '1' } : e)),
      '2026-11-10',
    ),
    null,
  );
  assert.equal(
    parseSpotDay(
      HVA.map((e, i) => (i === 3 ? { ...e, NOK_per_kWh: undefined } : e)),
      '2026-11-10',
    ),
    null,
  );
  assert.equal(parseSpotDay({}, '2026-11-10'), null);
  // The day the clocks go back has 25 hours, the spring one 23.
  const hours = (date, n, startIso) =>
    Array.from({ length: n }, (_, i) => ({
      NOK_per_kWh: 1,
      time_start: new Date(Date.parse(startIso) + i * 3600_000).toISOString(),
      time_end: new Date(Date.parse(startIso) + (i + 1) * 3600_000).toISOString(),
    }));
  assert.equal(
    parseSpotDay(hours('2026-10-25', 25, '2026-10-24T22:00:00Z'), '2026-10-25').length,
    25,
  );
  assert.equal(parseSpotDay(hours('2026-10-25', 24, '2026-10-24T22:00:00Z'), '2026-10-25'), null);
  assert.equal(
    parseSpotDay(hours('2026-03-29', 23, '2026-03-28T23:00:00Z'), '2026-03-29').length,
    23,
  );
  const cache = checkSpotCache({
    NO1: { '2026-11-10': { slots: day, at: 1 }, '2026-11-09': { slots: day.slice(1) } },
    XX: {},
  });
  assert.deepEqual(Object.keys(cache), ['NO1']);
  assert.deepEqual(Object.keys(cache.NO1), ['2026-11-10']);
  cache.NO1['2026-08-01'] = { slots: day };
  pruneSpot(cache, '2026-11-10');
  assert.deepEqual(Object.keys(cache.NO1), ['2026-11-10']);
});

test('NVE BKK of 2026-11-11 (a real answer): the same tariff once the Enova levy is counted', () => {
  const nve = parseNveDay(NVE_BKK);
  const bkk = tariffOn(catalog.company('bkk'), { group: 'husholdning', date: '2026-11-11' });
  const energy = {};
  for (let t = osloMidnight('2026-11-11'); oslo(t).date === '2026-11-11'; t += 3600_000) {
    energy[oslo(t).h] = Math.round((energyPrice(bkk, oslo(t)).ore + RATES.enova) * 1e6) / 1e6;
  }
  const steps = bkk.capacity.steps.map((st) => ({ from: st.from, monthly: st.yearly / 12 }));
  assert.equal(compareDay({ energy, steps }, nve).same, true);
});

test('NVE: one day parsed and compared with fri-nettleie', () => {
  const rows = [];
  for (let h = 0; h < 24; h += 1) {
    for (const [from, monthly] of [
      [0, 100],
      [2, 200],
    ]) {
      rows.push({
        time: h,
        energileddEks: h >= 6 && h <= 21 ? 20 : 10,
        effekttrinnFraKw: from,
        fastleddEks: monthly,
      });
    }
  }
  const nve = parseNveDay(rows);
  assert.equal(nve.energy[7], 20);
  assert.deepEqual(nve.steps, [
    { from: 0, monthly: 100 },
    { from: 2, monthly: 200 },
  ]);
  const ours = {
    energy: { ...nve.energy },
    steps: [
      { from: 0, monthly: 100 },
      { from: 2, monthly: 200.4 },
    ],
  };
  assert.equal(compareDay(ours, nve).same, true);
  ours.energy[7] = 21;
  ours.steps.push({ from: 5, monthly: 300 });
  const diff = compareDay(ours, nve);
  assert.deepEqual(diff.energyDiffs, [{ hour: 7, ours: 21, nve: 20 }]);
  assert.deepEqual(diff.stepDiffs, [{ from: 5, ours: 300, nve: null }]);
  assert.equal(parseNveDay([]), null);
  assert.equal(parseNveDay({}), null);
});

test('strømstøtte: nothing below the threshold, never a charge', () => {
  const s = settings({ supply: 'spot' });
  const [cost] = priceIntervals(
    [iv('2026-11-11T08:00:00Z')],
    0,
    s,
    ctx(company(), () => 0.5),
  );
  close(cost.cost, (20 + 8.13) * 0.0125 + 0.5 * 1.25);
});

test('current price: the cap boundary and an unknown month', () => {
  const now = Date.parse('2026-11-11T08:10:00Z');
  const s = settings({ supply: 'norgespris' });
  const grid = (20 + 8.13) * 0.0125;
  close(
    currentPrice(
      now,
      4999.9,
      s,
      ctx(company(), () => 2),
    ).price,
    grid + 0.5,
  );
  // At exactly 5,000 kWh the next kWh is beyond the cap: the spot price.
  close(
    currentPrice(
      now,
      5000,
      s,
      ctx(company(), () => 2),
    ).price,
    grid + 2.5,
  );
  assert.throws(
    () =>
      currentPrice(
        now,
        NaN,
        s,
        ctx(company(), () => 2),
      ),
    /month are unknown/,
  );
  // No cap, no month needed.
  close(currentPrice(now, NaN, settings(), ctx()).price, grid);
});
