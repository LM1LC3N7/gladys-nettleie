// -----------------------------------------------------------------------------
// The app against the fake Gladys of the SDK, a scripted network and a
// virtual clock: start, Discovery, delegated pricing, capacity states, spot
// prices, the daily refresh of fri-nettleie, pauses, /data, the Test button.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stringify } from 'yaml';
import { loadSnapshot } from '../src/catalog.js';
import { USER_AGENT } from '../src/constants.js';
import {
  CONTRACT_ID,
  DAY,
  DEVICE,
  F,
  HOUR,
  MINUTE,
  NOW,
  OTHER_ID,
  SECOND,
  contract,
  createNet,
  intervalsFrom,
  json,
  memoryStores,
  hvaDay,
  plain,
  priceRequest,
  settle,
  setup,
} from './helpers/app.js';

const RAW = 'https://raw.githubusercontent.com/kraftsystemet/fri-nettleie/main/';
const ELVIA = `${RAW}tariffer/elvia.yml`;
const RATES = `${RAW}docs/llm-v2-innsamling-skill/skills/samle-tariff/references/satser.yml`;
const SPOT = 'https://www.hvakosterstrommen.no/';
const NVE = 'https://nettleietariffer.dataplattform.nve.no/';
const snapshot = loadSnapshot();
const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);
const statusText = (env) => env.status()?.message?.en ?? '';

/** Elvia's document with its last energy prices changed. */
function elviaYaml(day = 30, night = 18) {
  const doc = structuredClone(snapshot.companies.elvia.doc);
  const last = doc.tariffer[doc.tariffer.length - 1];
  last.energiledd.grunnpris = night;
  last.energiledd.unntak[0].pris = day;
  doc.sist_oppdatert = '2026-11-10';
  return `---\n${stringify(doc)}`;
}

/** A network where fri-nettleie answers, Nord Pool and NVE are scripted per test. */
function netWith(extra = {}) {
  return createNet({
    [RATES]: () => plain(stringify(snapshot.rates), 200, { etag: '"r1"' }),
    [ELVIA]: () => plain(elviaYaml(), 200, { etag: '"e1"' }),
    ...extra,
  });
}

// --- start, status, Discovery -----------------------------------------------------------

test('start: status with the data date, one device per contract in Discovery', async () => {
  const env = await setup({ config: { refresh_data: false } });
  await env.run();
  assert.match(
    statusText(env),
    /^1 contract\(s\)\. Data: fri-nettleie of 2026-06-05 \(CC BY 4\.0\)\.$/,
  );
  assert.equal(env.status().connected, true);
  const devices = env.gladys.fake.discoveredDevices;
  assert.equal(devices.length, 1);
  assert.equal(devices[0].external_id, DEVICE());
  assert.equal(devices[0].name, 'Nettleie Elvia AS');
  assert.deepEqual(
    devices[0].features.map((f) => f.external_id),
    ['price', 'capacity', 'capacity_fee', 'next_step'].map((k) => F(k)),
  );
  assert.ok(devices[0].features.every((f) => f.read_only && !f.has_feedback));
  // refresh_data off: nothing asked to the network, ever.
  await env.advance(3 * DAY);
  assert.equal(env.net.calls.length, 0);
  await env.app.stop();
});

test('no contract: the status says how to create one; other templates and bad ids are ignored', async () => {
  const env = await setup({
    config: { refresh_data: false },
    contracts: [
      { ...contract(), template_key: 'other' },
      contract({}, 'not-a-uuid'),
      contract({}, OTHER_ID, { status: 'expired' }),
    ],
  });
  await env.run();
  assert.match(
    statusText(env),
    /^Ready\. Create a contract with the "Nettleie \(Norway\)" template/,
  );
  assert.deepEqual(env.gladys.fake.discoveredDevices, []);
  const ack = await env.gladys.fake.action('test');
  assert.match(ack.data.message.en, /^No contract uses the "Nettleie \(Norway\)" template yet/);
  await env.app.stop();
});

test('Discovery lists the contracts again (a contract created since the start)', async () => {
  const env = await setup({ config: { refresh_data: false }, contracts: [] });
  await env.run();
  assert.equal(env.gladys.fake.discoveredDevices.length, 0);
  env.gladys.fake.energyContracts.push(contract({ grid_company: 'bkk' }, OTHER_ID));
  await env.gladys.fake.scanRequest();
  assert.equal(env.gladys.fake.discoveredDevices[0].name, 'Nettleie BKK AS');
  await env.app.stop();
});

test('getConfig() failing in `connected`: retried, doubling, then the start goes on', async () => {
  let fails = 2;
  const env = await setup({ config: { refresh_data: false } });
  const real = env.gladys.getConfig.bind(env.gladys);
  env.gladys.getConfig = async () => {
    if (fails-- > 0) throw new Error('down');
    return real();
  };
  await env.run();
  assert.match(statusText(env), /configuration could not be read/);
  assert.equal(env.gladys.fake.discoveredDevices.length, 0);
  await env.advance(10 * SECOND);
  assert.match(statusText(env), /configuration could not be read/);
  await env.advance(20 * SECOND);
  assert.match(statusText(env), /^1 contract/);
  assert.equal(env.gladys.fake.discoveredDevices.length, 1);
  await env.app.stop();
});

test('getEnergyContracts() failing: said in the status, read again, then the devices come', async () => {
  let fails = 1;
  const env = await setup({ config: { refresh_data: false } });
  const real = env.gladys.getEnergyContracts.bind(env.gladys);
  env.gladys.getEnergyContracts = async () => {
    if (fails-- > 0) throw new Error('down');
    return real();
  };
  await env.run();
  assert.match(statusText(env), /contracts could not be read/);
  await env.advance(10 * SECOND);
  assert.doesNotMatch(statusText(env), /could not be read/);
  assert.equal(env.gladys.fake.discoveredDevices.length, 1);
  await env.app.stop();
});

// --- delegated pricing ------------------------------------------------------------------

test('pricing: one cost per interval, the capacity recorded and published', async () => {
  const env = await setup({ config: { refresh_data: false } });
  await env.run();
  // 1 to 4 November 2026, 07:00-09:00 local, 2.5 kWh per half hour on the 2nd.
  const intervals = [
    ...intervalsFrom('2026-11-02T06:00:00.000Z', 4, (i) => (i < 2 ? 2.5 : 1)),
    ...intervalsFrom('2026-11-03T06:00:00.000Z', 2, 2),
    ...intervalsFrom('2026-11-04T06:00:00.000Z', 2, 1.5),
  ];
  const ack = await env.gladys.fake.energyPrice(priceRequest(intervals));
  assert.equal(ack.success, true, ack.error);
  const costs = ack.data.costs;
  assert.equal(costs.length, intervals.length);
  // Monday 07:00 local, Elvia working-day price 28.99 øre + 8.13 taxes, VAT 25 %.
  close(costs[0].cost, 2.5 * (28.99 + 8.13) * 0.0125);
  assert.equal(costs[0].label, 'Nettleie');
  // Peak hours: 5, 4 and 3 kWh -> 4 kW, Elvia step 2-5 kW: 2400 NOK a year + VAT.
  assert.equal(env.last(F('capacity')), 4);
  assert.equal(env.last(F('capacity_fee')), 250);
  assert.equal(env.last(F('next_step')), 5);
  assert.equal(env.last(F('price')), 0.464); // 09:20 local on a Wednesday
  const saved = env.stores.capacity.data.contracts[CONTRACT_ID].intervals;
  assert.equal(Object.keys(saved).length, intervals.length);
  await env.app.stop();
});

test('a wrong company: no cost (failure ack), the problem in the status, cleared by a success', async () => {
  const env = await setup({
    config: { refresh_data: false },
    contracts: [contract({ grid_company: 'Area Nett' })],
  });
  await env.run();
  const intervals = intervalsFrom('2026-11-02T06:00:00.000Z', 1);
  const bad = await env.gladys.fake.energyPrice(
    priceRequest(intervals, { inputs: { grid_company: 'Area Nett' } }),
  );
  assert.equal(bad.success, false);
  assert.match(bad.error, /grid company "Area Nett" not found \(did you mean: area-alle, /);
  assert.match(statusText(env), /Problem: grid company "Area Nett" not found/);
  const good = await env.gladys.fake.energyPrice(
    priceRequest(intervals, { inputs: { grid_company: 'area-lega' } }),
  );
  assert.equal(good.success, true);
  await env.advance(SECOND);
  assert.doesNotMatch(statusText(env), /Problem/);
  const other = await env.gladys.fake.energyPrice({
    ...priceRequest(intervals),
    contract: { ...priceRequest(intervals).contract, template_key: 'nord-pool-spot-no1' },
  });
  assert.equal(other.success, false);
  await env.app.stop();
});

test('spot: never a wait in the pricing; the days missing read in the background, our User-Agent', async () => {
  let release;
  const net = createNet({
    [SPOT]: (url) =>
      new Promise((resolve) => {
        release = () =>
          resolve(
            json(
              hvaDay(
                url
                  .match(/(\d{4})\/(\d{2})-(\d{2})/)
                  .slice(1)
                  .join('-'),
                () => 1,
              ),
            ),
          );
      }),
  });
  const env = await setup({ config: { refresh_data: false }, net, contracts: [] });
  await env.app.connected();
  const inputs = { supply: 'spot', customer_group: 'holiday_home' };
  const req = () => priceRequest(intervalsFrom('2026-11-02T06:00:00.000Z', 2), { inputs });
  // The pricing answers at once (the clock does not move), without the spot price.
  const first = await env.gladys.fake.energyPrice(req());
  assert.equal(first.success, false);
  assert.match(first.error, /no NO1 spot price/);
  const call = net.calls.find((c) => c.url.startsWith(SPOT));
  assert.equal(call.url, `${SPOT}api/v1/prices/2026/11-02_NO1.json`);
  assert.equal(call.headers['User-Agent'], USER_AGENT);
  assert.match(
    USER_AGENT,
    /^gladys-nettleie\/0\.1\.0 \(\+https:\/\/github\.com\/LM1LC3N7\/gladys-nettleie\)$/,
  );
  // Asked again while the read hangs: still at once, no second request.
  const second = await env.gladys.fake.energyPrice(req());
  assert.equal(second.success, false);
  assert.equal(net.count(SPOT), 1);
  release();
  await env.advance(SECOND);
  const ack = await env.gladys.fake.energyPrice(req());
  assert.equal(ack.success, true, ack.error);
  close(ack.data.costs[0].cost, (28.99 + 8.13) * 0.0125 + 1.25);
  assert.equal(net.calls.filter((c) => c.url.includes('11-02_NO1')).length, 1);
  assert.ok(env.stores.spot.data.areas.NO1['2026-11-02']);
  await env.app.stop();
});

test('spot not published (404) or partial: not kept, not asked again before 6 hours (a past day) or 15 minutes (partial)', async () => {
  const net = createNet({ [SPOT]: () => json({ message: 'not found' }, 404) });
  const env = await setup({ config: { refresh_data: false }, net, contracts: [] });
  await env.app.connected();
  const inputs = { supply: 'spot' };
  const d2 = () => net.calls.filter((c) => c.url.includes('11-02_NO1')).length;
  const req = () => priceRequest(intervalsFrom('2026-11-02T06:00:00.000Z', 1), { inputs });
  assert.equal((await env.gladys.fake.energyPrice(req())).success, false);
  await env.advance(SECOND);
  assert.equal(d2(), 1);
  await env.gladys.fake.energyPrice(req());
  await env.advance(10 * MINUTE);
  await env.gladys.fake.energyPrice(req());
  assert.equal(d2(), 1);
  net.routes[SPOT] = () => json(hvaDay('2026-11-02').slice(0, 20));
  await env.advance(6 * HOUR);
  await env.gladys.fake.energyPrice(req());
  await env.advance(2 * SECOND);
  assert.equal(d2(), 2);
  assert.equal(env.app.spot.NO1?.['2026-11-02'], undefined);
  assert.match(env.lines.join('\n'), /NO1 2026-11-02: not a whole day, not kept/);
  await env.app.stop();
});

test('a 429 of the spot source pauses it (Retry-After), kept in /data, nothing asked during the pause', async () => {
  const net = createNet({ [SPOT]: () => json({}, 429, { 'retry-after': '7200' }) });
  const stores = memoryStores();
  const env = await setup({ config: { refresh_data: false }, net, stores, contracts: [] });
  await env.app.connected();
  const inputs = { supply: 'spot' };
  await env.gladys.fake.energyPrice(
    priceRequest(intervalsFrom('2026-11-02T06:00:00.000Z', 1), { inputs }),
  );
  await env.advance(SECOND);
  assert.equal(net.count(SPOT), 1);
  const pause = stores.state.data.pauses.spot;
  assert.ok(Math.abs(pause.until - (NOW + 2 * HOUR)) < 2 * SECOND);
  assert.equal(pause.status, 429);
  await env.advance(20 * MINUTE);
  await env.gladys.fake.energyPrice(
    priceRequest(intervalsFrom('2026-11-03T06:00:00.000Z', 1), { inputs }),
  );
  await env.advance(SECOND);
  assert.equal(net.count(SPOT), 1);
  assert.match(
    statusText(env),
    /Hva koster strømmen\.no asks to wait \(HTTP 429\): paused until 10:20 UTC/,
  );
  await env.app.stop();
  const env2 = await setup({
    config: { refresh_data: false },
    net,
    stores,
    contracts: [],
    start: NOW + 30 * MINUTE,
  });
  await env2.app.connected();
  await env2.gladys.fake.energyPrice(
    priceRequest(intervalsFrom('2026-11-04T06:00:00.000Z', 1), { inputs }),
  );
  await env2.advance(SECOND);
  assert.equal(net.count(SPOT), 1);
  await env2.app.stop();
});

test('current price: from what is held, never a request (Gladys waits 5 s)', async () => {
  const net = createNet({ [SPOT]: () => json(hvaDay('2026-11-11')) });
  const env = await setup({ config: { refresh_data: false }, net, contracts: [] });
  await env.app.connected();
  const req = (inputs) => ({
    contract: priceRequest([], { inputs }).contract,
    billing_period: priceRequest([]).billing_period,
    cumulative: { day: 0, month: 100, billing_period: 100 },
    max_power_kw: 0,
  });
  const grid = await env.gladys.fake.energyCurrent(req({}));
  close(grid.data.price, 0.464);
  assert.equal(grid.data.valid_until, '2026-11-11T09:00:00.000Z');
  const calls = net.calls.length;
  const spot = await env.gladys.fake.energyCurrent(req({ supply: 'spot' }));
  assert.deepEqual(spot.data, { price: null });
  assert.equal(net.calls.length, calls);
  const wrong = await env.gladys.fake.energyCurrent(req({ grid_company: 'nobody' }));
  assert.deepEqual(wrong.data, { price: null });
  await env.app.stop();
});

// --- quarter tick -----------------------------------------------------------------------

test('the price state every quarter of an hour; stop leaves no timer', async () => {
  const env = await setup({ config: { refresh_data: false } });
  await env.run();
  assert.equal(env.last(F('price')), 0.464);
  // 22:05 local: the night price (Elvia's day price runs to 21:59).
  await env.advance(12 * HOUR + 45 * MINUTE);
  assert.equal(env.last(F('price')), 0.314);
  const count = env.states(F('price')).length;
  await env.advance(HOUR);
  assert.equal(env.states(F('price')).length, count, 'an unchanged value is not published again');
  await env.app.stop();
  assert.equal(env.pending.size, 0);
  await env.advance(DAY);
  assert.equal(env.pending.size, 0);
});

test('spot contracts: today read at the start, tomorrow from 13:00, each once', async () => {
  const net = createNet({
    [SPOT]: (url) =>
      json(
        hvaDay(
          url
            .match(/(\d{4})\/(\d{2})-(\d{2})/)
            .slice(1)
            .join('-'),
        ),
      ),
  });
  const env = await setup({
    config: { refresh_data: false },
    net,
    contracts: [contract({ supply: 'spot' })],
  });
  await env.run(5 * SECOND);
  const days = () => net.calls.map((c) => c.url.slice(-17));
  assert.deepEqual(
    days(),
    ['11-11_NO1.json'].map((d) => `2026/${d}`.slice(-17)),
  );
  await env.advance(4 * HOUR); // 13:20 local
  assert.equal(net.calls.length, 2);
  assert.match(net.calls[1].url, /2026\/11-12_NO1\.json$/);
  await env.advance(3 * HOUR);
  assert.equal(net.calls.length, 2);
  assert.ok(Number.isFinite(env.last(F('price'))));
  await env.app.stop();
});

test('refresh: the rates and the companies used, once a day, conditional, our User-Agent', async () => {
  const net = netWith();
  const stores = memoryStores();
  const env = await setup({ net, stores });
  await env.run(5 * SECOND);
  assert.deepEqual(
    net.calls.map((c) => c.url),
    [RATES, ELVIA],
  );
  assert.ok(net.calls.every((c) => c.headers['User-Agent'] === USER_AGENT));
  // The file read again is used: 30 øre on a working day.
  const ack = await env.gladys.fake.energyPrice(
    priceRequest(intervalsFrom('2026-11-11T08:00:00.000Z', 1)),
  );
  close(ack.data.costs[0].cost, (30 + 8.13) * 0.0125);
  assert.match(statusText(env), /fri-nettleie of 2026-11-10/);
  assert.equal(stores.state.data.live.elvia.etag, '"e1"');
  assert.ok(Math.abs(stores.state.data.refreshAt - (NOW + DAY)) < 5 * SECOND);
  // A day later: asked again with the ETag; 304 keeps the file.
  net.routes[ELVIA] = () => new Response(null, { status: 304 });
  net.routes[RATES] = () => new Response(null, { status: 304 });
  await env.advance(DAY);
  assert.equal(net.calls.length, 4);
  assert.equal(net.calls[3].headers['If-None-Match'], '"e1"');
  assert.equal(net.calls[2].headers['If-None-Match'], '"r1"');
  // A 304 is a successful read: the next one a day later, not an hour.
  await env.advance(2 * HOUR);
  assert.equal(net.calls.length, 4);
  const again = await env.gladys.fake.energyPrice(
    priceRequest(intervalsFrom('2026-11-12T08:00:00.000Z', 1)),
  );
  close(again.data.costs[0].cost, (30 + 8.13) * 0.0125);
  await env.app.stop();
});

test('refresh: a restart never asks sooner than the day; the file read again comes back from /data', async () => {
  const net = netWith();
  const stores = memoryStores();
  const env = await setup({ net, stores });
  await env.run(5 * SECOND);
  await env.app.stop();
  assert.equal(net.calls.length, 2);
  const env2 = await setup({ net, stores, start: NOW + 3 * HOUR });
  await env2.run(5 * SECOND);
  assert.equal(net.calls.length, 2);
  const ack = await env2.gladys.fake.energyPrice(
    priceRequest(intervalsFrom('2026-11-11T08:00:00.000Z', 1)),
  );
  close(ack.data.costs[0].cost, (30 + 8.13) * 0.0125);
  await env2.advance(21 * HOUR);
  assert.equal(net.calls.length, 4);
  await env2.app.stop();
});

test('refresh: a file refused by the checks, not YAML or too large keeps the previous data, again in an hour', async () => {
  const bad = structuredClone(snapshot.companies.elvia.doc);
  bad.tariffer = bad.tariffer.map((t) => ({ ...t, gyldig_fra: 'soon' }));
  const net = netWith({ [ELVIA]: () => plain(stringify(bad)) });
  const stores = memoryStores();
  const env = await setup({ net, stores });
  await env.run(5 * SECOND);
  assert.match(env.lines.join('\n'), /tariffer\/elvia\.yml: refused by the checks/);
  const ack = await env.gladys.fake.energyPrice(
    priceRequest(intervalsFrom('2026-11-11T08:00:00.000Z', 1)),
  );
  close(ack.data.costs[0].cost, (28.99 + 8.13) * 0.0125);
  assert.equal(stores.state.data.refreshAt, NOW + HOUR);
  net.routes[ELVIA] = () => plain('key: [unclosed');
  await env.advance(HOUR);
  assert.match(env.lines.join('\n'), /elvia\.yml: not YAML/);
  net.routes[ELVIA] = () => plain('x'.repeat(600 * 1024));
  await env.advance(HOUR);
  assert.match(env.lines.join('\n'), /elvia\.yml not read \(answer too large\)/);
  net.routes[ELVIA] = () => plain('&a [*a]');
  await env.advance(HOUR);
  assert.equal(net.count(ELVIA), 4);
  const still = await env.gladys.fake.energyPrice(
    priceRequest(intervalsFrom('2026-11-11T08:00:00.000Z', 1)),
  );
  close(still.data.costs[0].cost, (28.99 + 8.13) * 0.0125);
  await env.app.stop();
});

test('refresh: a 503 of GitHub pauses it an hour, doubling, never a storm', async () => {
  const net = netWith({ [RATES]: () => plain('down', 503) });
  const stores = memoryStores();
  const env = await setup({ net, stores });
  await env.run(5 * SECOND);
  // The rates got a 503: the company file is not asked during the pause.
  assert.deepEqual(
    net.calls.map((c) => c.url),
    [RATES],
  );
  assert.equal(stores.state.data.pauses.github.until, NOW + HOUR);
  assert.match(statusText(env), /GitHub \(fri-nettleie\) asks to wait \(HTTP 503\)/);
  await env.advance(HOUR + 10 * SECOND);
  assert.equal(net.count(RATES), 2);
  // The second 503 in a row: two hours.
  const left = stores.state.data.pauses.github.until - env.clock.now;
  assert.ok(left > 2 * HOUR - MINUTE && left <= 2 * HOUR, `${left}`);
  await env.advance(30 * MINUTE);
  assert.equal(net.count(RATES), 2);
  await env.app.stop();
});

// --- /data ------------------------------------------------------------------------------

test('/data unreadable: said, nothing written, read again on its own timer', async () => {
  const stores = memoryStores({
    capacity: {
      contracts: { [CONTRACT_ID]: { intervals: { [Date.parse('2026-11-02T06:00:00Z')]: 3 } } },
    },
  });
  stores.capacity.unreadable = true;
  const env = await setup({ config: { refresh_data: false }, stores });
  await env.run();
  assert.match(statusText(env), /\/data unreadable/);
  await env.gladys.fake.energyPrice(priceRequest(intervalsFrom('2026-11-03T06:00:00.000Z', 2, 1)));
  assert.equal(stores.capacity.saves, 0);
  const loads = stores.capacity.loads;
  await env.advance(10 * SECOND);
  assert.equal(stores.capacity.loads, loads + 1);
  stores.capacity.unreadable = false;
  await env.advance(10 * SECOND);
  assert.doesNotMatch(statusText(env), /unreadable/);
  // What /data held and what came meanwhile are both kept.
  await env.gladys.fake.energyPrice(priceRequest(intervalsFrom('2026-11-04T06:00:00.000Z', 1, 1)));
  const saved = stores.capacity.data.contracts[CONTRACT_ID].intervals;
  assert.equal(saved[Date.parse('2026-11-02T06:00:00Z')], 3);
  assert.equal(saved[Date.parse('2026-11-03T06:30:00Z')], 1);
  await env.app.stop();
});

test('/data hanging: the start goes on after 5 s, the late answer is merged when it comes', async () => {
  const stores = memoryStores();
  let release;
  let reads = 0;
  stores.state.load = () => {
    reads += 1;
    return new Promise((resolve) => (release = resolve));
  };
  const env = await setup({ config: { refresh_data: false }, stores });
  const started = env.app.connected();
  // The pricing answers while /data does not.
  const ack = await env.gladys.fake.energyPrice(
    priceRequest(intervalsFrom('2026-11-11T08:00:00.000Z', 1)),
  );
  assert.equal(ack.success, true);
  await env.advance(5 * SECOND);
  await started;
  assert.match(statusText(env), /^1 contract.*\/data unreadable/);
  assert.equal(env.gladys.fake.discoveredDevices.length, 1);
  // Read again on its timer, never a second read while the first one hangs.
  await env.advance(30 * SECOND);
  assert.equal(reads, 1);
  release({ refreshAt: NOW + HOUR, pauses: {} });
  await env.advance(15 * SECOND);
  assert.doesNotMatch(statusText(env), /unreadable/);
  assert.equal(env.app.state.refreshAt, NOW + HOUR);
  await env.app.stop();
});

// --- Test button ------------------------------------------------------------------------

test('Test: the company, the price, the capacity, NVE compared (one request an hour)', async () => {
  const rows = [];
  for (let h = 0; h < 24; h += 1) {
    const day = h >= 6 && h <= 21;
    for (const [from, yearly] of [
      [0, 1440],
      [2, 2400],
      [5, 4032],
      [10, 5616],
      [15, 7248],
      [20, 8880],
      [25, 16896],
      [50, 24960],
      [75, 33024],
      [100, 65280],
    ]) {
      rows.push({
        time: h,
        energileddEks: day ? 29.99 : 17.99,
        effekttrinnFraKw: from,
        fastleddEks: yearly / 12,
      });
    }
  }
  const net = createNet({ [NVE]: () => json(rows) });
  const env = await setup({ config: { refresh_data: false }, net });
  await env.run();
  await env.gladys.fake.energyPrice(
    priceRequest(intervalsFrom('2026-11-02T06:00:00.000Z', 2, 1.5)),
  );
  const ack = await env.gladys.fake.action('test');
  const msg = ack.data.message.en;
  assert.match(
    msg,
    /^Elvia AS \(data of 2026-06-05\): energy 28\.99 øre\/kWh now without taxes, price now 0\.4640 NOK\/kWh with taxes\./,
  );
  assert.match(msg, /Capacity this month: 3 kW, step 250\.00 NOK\/month\./);
  assert.match(msg, /NVE: same values today\./);
  const call = net.calls[0];
  assert.match(
    call.url,
    /ValgtDato=2026-11-11&Tariffgruppe=Husholdning&FylkeNr=\d{2}&OrganisasjonsNr=980489698/,
  );
  await env.gladys.fake.action('test');
  assert.equal(net.count(NVE), 1);
  await env.advance(HOUR + MINUTE);
  rows[7].energileddEks = 22.99;
  rows.filter((r) => r.time === 7).forEach((r) => (r.energileddEks = 22.99));
  const diff = await env.gladys.fake.action('test');
  assert.match(
    diff.data.message.en,
    /NVE differs today \(7h: 29\.99 \/ 22\.99 øre\); the prices use fri-nettleie\./,
  );
  assert.equal(net.count(NVE), 2);
  net.routes[NVE] = () => json({}, 500);
  await env.advance(HOUR + MINUTE);
  const down = await env.gladys.fake.action('test');
  assert.match(down.data.message.en, /NVE: not compared \(HTTP 500\)\./);
  await env.app.stop();
});

test('Test: a contract with a wrong input says which, without a request', async () => {
  const net = createNet();
  const env = await setup({
    config: { refresh_data: false },
    net,
    contracts: [contract({ tax_zone: 'east' })],
  });
  await env.run();
  const ack = await env.gladys.fake.action('test');
  assert.equal(ack.data.message.en, 'Contract 6f1c2b1e: tax_zone is not a known option');
  assert.equal(net.calls.length, 0);
  await env.app.stop();
});

test('refresh: requests one after the other, a second apart; stop() cancels the one waiting', async () => {
  const at = [];
  const net = netWith();
  for (const url of [RATES, ELVIA]) {
    const route = net.routes[url];
    net.routes[url] = (u, init) => {
      at.push(env.clock.now);
      return route(u, init);
    };
  }
  const env = await setup({ net });
  await env.run(5 * SECOND);
  assert.equal(at.length, 2);
  assert.ok(at[1] - at[0] >= SECOND - 1, `${at[1] - at[0]} ms apart`);
  await env.app.stop();
  // A new process: the rates read, then stop() while the company file waits its turn.
  const env2 = await setup({ net, start: NOW + 2 * DAY });
  const calls = net.calls.length;
  await env2.app.connected();
  await env2.advance(10);
  assert.equal(net.calls.length, calls + 1);
  await env2.app.stop();
  await env2.advance(10 * SECOND);
  assert.equal(net.calls.length, calls + 1, 'nothing leaves after stop()');
  assert.equal(env2.pending.size, 0);
});

test('a refresh due time far in the future (clock changed) is not trusted: read now', async () => {
  const net = netWith();
  const stores = memoryStores({ state: { refreshAt: NOW + 30 * DAY } });
  const env = await setup({ net, stores });
  await env.run(5 * SECOND);
  assert.equal(net.count(ELVIA), 1);
  await env.app.stop();
});

test('spot: one pricing queues at most a month of days, read one at a time', async () => {
  const net = createNet({
    [SPOT]: (url) =>
      json(
        hvaDay(
          url
            .match(/(\d{4})\/(\d{2})-(\d{2})/)
            .slice(1)
            .join('-'),
        ),
      ),
  });
  const env = await setup({ config: { refresh_data: false }, net, contracts: [] });
  await env.app.connected();
  const inputs = { supply: 'spot', customer_group: 'holiday_home' };
  const days = intervalsFrom('2026-10-01T06:00:00.000Z', 40 * 48).filter((_, i) => i % 48 === 0);
  const first = await env.gladys.fake.energyPrice(priceRequest(days, { inputs }));
  assert.equal(first.success, false);
  await env.advance(MINUTE);
  const october = net.calls.filter((c) => !c.url.includes('11-11_NO1')).length;
  assert.equal(october, 32);
  await env.app.stop();
});

test('refresh: the due time written before the requests survives a stop during a hanging read', async () => {
  const stores = memoryStores();
  const net = netWith({ [RATES]: () => new Promise(() => {}) });
  const env = await setup({ net, stores });
  await env.run(5 * SECOND);
  assert.equal(net.count(RATES), 1);
  await env.app.stop();
  const env2 = await setup({ net, stores, start: NOW + 30 * MINUTE });
  await env2.run(5 * SECOND);
  assert.equal(net.count(RATES), 1, 'not read again before an hour');
  await env2.advance(31 * MINUTE);
  assert.equal(net.count(RATES), 2);
  await env2.app.stop();
});

test('refresh: no read while its due time cannot be written to /data', async () => {
  const stores = memoryStores();
  stores.state.unreadable = true;
  const net = netWith();
  const env = await setup({ net, stores });
  await env.run(5 * SECOND);
  assert.equal(net.calls.length, 0);
  await env.app.stop();
  const stores2 = memoryStores();
  stores2.state.failSave = true;
  const env2 = await setup({ net, stores: stores2 });
  await env2.run(5 * SECOND);
  assert.equal(net.calls.length, 0);
  await env2.app.stop();
});

test('a pause in /data longer than 6 hours is not trusted', async () => {
  const net = netWith();
  const stores = memoryStores({
    state: { pauses: { github: { until: NOW + 7 * HOUR, delay: HOUR, status: 503 } } },
  });
  const env = await setup({ net, stores });
  await env.run(5 * SECOND);
  assert.equal(net.count(RATES), 1);
  await env.app.stop();
  const stores2 = memoryStores({
    state: { pauses: { github: { until: NOW + 5 * HOUR, delay: HOUR, status: 503 } } },
  });
  const env2 = await setup({ net, stores: stores2 });
  await env2.run(5 * SECOND);
  assert.equal(net.count(RATES), 1, 'a pause within the bound is kept');
  await env2.app.stop();
});

test('refresh: a company file with a YAML alias is refused as not YAML', async () => {
  const doc = structuredClone(snapshot.companies.elvia.doc);
  const last = doc.tariffer[doc.tariffer.length - 1];
  last.energiledd.unntak[0].pris = 30;
  const yaml = `---\n${stringify(doc)}`.replace(
    'netteier: Elvia AS',
    'netteier: &name Elvia AS\nnavn_kopi: *name',
  );
  assert.match(yaml, /\*name/);
  const net = netWith({ [ELVIA]: () => plain(yaml) });
  const env = await setup({ net });
  await env.run(5 * SECOND);
  assert.match(env.lines.join('\n'), /elvia\.yml: not YAML/);
  const ack = await env.gladys.fake.energyPrice(
    priceRequest(intervalsFrom('2026-11-11T08:00:00.000Z', 1)),
  );
  close(ack.data.costs[0].cost, (28.99 + 8.13) * 0.0125);
  await env.app.stop();
});

test('capacity step: no VAT in the north and tiltakssone zones; warnings on zone and old data', async () => {
  const env = await setup({
    config: { refresh_data: false },
    contracts: [contract({ grid_company: 'arva', tax_zone: 'north' })],
  });
  await env.run();
  await env.gladys.fake.energyPrice(
    priceRequest(intervalsFrom('2026-11-02T06:00:00.000Z', 2, 1.5), {
      inputs: { grid_company: 'arva', tax_zone: 'north' },
    }),
  );
  const app = env.app;
  const { settings, company } = app.resolve({ grid_company: 'arva', tax_zone: 'north' });
  const capacity = app.capacityOf(CONTRACT_ID, settings, company);
  const step = company.tariffs.at(-1).capacity.steps.findLast((s) => s.from <= 3);
  close(capacity.monthlyWithVat, step.yearly / 12);
  assert.match(statusText(env), /The data of Arva AS was last checked on 2024-/);
  await env.app.stop();
  const south = await setup({
    config: { refresh_data: false },
    contracts: [contract({ grid_company: 'arva' })],
  });
  await south.run();
  assert.match(statusText(south), /Tax zone "south" does not match the county of Arva AS/);
  // A tariff of this year collected last December is not old data.
  const bkk = await setup({
    config: { refresh_data: false },
    contracts: [contract({ grid_company: 'bkk' })],
  });
  await bkk.run();
  assert.doesNotMatch(statusText(bkk), /last checked/);
  await bkk.app.stop();
  await south.app.stop();
});

test('status: the spot source credited when a contract reads spot prices', async () => {
  const env = await setup({
    config: { refresh_data: false },
    contracts: [contract({ supply: 'spot' })],
  });
  await env.run();
  assert.match(statusText(env), /Strømpriser levert av Hva koster strømmen\.no\./);
  await env.app.stop();
});

test('/data spot file with slots that are not dates: the session starts, the day is ignored', async () => {
  const day = hvaDay('2026-11-10').map((e) => [
    Date.parse(e.time_start),
    Date.parse(e.time_end),
    1,
  ]);
  const stores = memoryStores({
    spot: {
      areas: {
        NO1: {
          '2026-11-10': { slots: [['x', 1, 2], ...day.slice(1)] },
          '2026-11-09': { slots: [[1e20, 2, 3]] },
        },
      },
    },
  });
  const env = await setup({ config: { refresh_data: false }, stores });
  await env.run();
  assert.match(statusText(env), /^1 contract/);
  assert.equal(env.gladys.fake.discoveredDevices.length, 1);
  assert.equal(env.app.spot.NO1, undefined);
  assert.ok(env.pending.size > 0, 'the tick is armed');
  await env.app.stop();
});

test('spot queue: at most 64 days waiting, never after tomorrow, nothing kept after stop()', async () => {
  let release;
  const net = createNet({ [SPOT]: () => new Promise((resolve) => (release = resolve)) });
  const env = await setup({ config: { refresh_data: false }, net, contracts: [] });
  await env.app.connected();
  for (const [i, area] of ['NO2', 'NO3', 'NO5'].entries()) {
    const id = [CONTRACT_ID, OTHER_ID, '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d'][i];
    const days = intervalsFrom('2026-10-05T06:00:00.000Z', 31 * 48).filter((_, k) => k % 48 === 0);
    await env.gladys.fake.energyPrice(
      priceRequest(days, { inputs: { supply: 'spot', price_area: area }, id }),
    );
  }
  // One read in flight, the queue full at 64 (93 days asked).
  assert.equal(net.calls.length, 1);
  assert.equal(env.app.spotQueue.size, 64);
  // Days after tomorrow are never asked.
  const later = intervalsFrom('2026-11-13T06:00:00.000Z', 3 * 48).filter((_, k) => k % 48 === 0);
  env.app.spotQueue.clear();
  await env.gladys.fake.energyPrice(
    priceRequest(later, { inputs: { supply: 'spot', price_area: 'NO4' } }),
  );
  assert.equal(env.app.spotQueue.size, 0);
  // stop() while the read hangs: its answer is neither kept nor written.
  const saves = env.stores.spot.saves;
  await env.app.stop();
  release(json(hvaDay('2026-10-05')));
  await settle();
  assert.equal(env.app.spot.NO2?.['2026-10-05'], undefined);
  assert.equal(env.stores.spot.saves, saves);
});

test('a day the source does not have (404, before yesterday) is asked again after 6 hours, a pause logged once', async () => {
  const net = createNet({ [SPOT]: () => json({ message: 'not found' }, 404) });
  const env = await setup({ config: { refresh_data: false }, net, contracts: [] });
  await env.app.connected();
  const req = () =>
    priceRequest(intervalsFrom('2026-11-02T06:00:00.000Z', 1), { inputs: { supply: 'spot' } });
  const d2 = () => net.calls.filter((c) => c.url.includes('11-02_NO1')).length;
  await env.gladys.fake.energyPrice(req());
  await env.advance(SECOND);
  assert.equal(d2(), 1);
  await env.advance(5 * HOUR);
  await env.gladys.fake.energyPrice(req());
  await env.advance(SECOND);
  assert.equal(d2(), 1);
  await env.advance(HOUR);
  await env.gladys.fake.energyPrice(req());
  await env.advance(SECOND);
  assert.equal(d2(), 2);
  // During a pause: no line per queued day.
  net.routes[SPOT] = () => json({}, 503);
  const days = intervalsFrom('2026-10-10T06:00:00.000Z', 10 * 48).filter((_, k) => k % 48 === 0);
  await env.gladys.fake.energyPrice(priceRequest(days, { inputs: { supply: 'spot' } }));
  await env.advance(MINUTE);
  const lines = env.lines.filter((l) => /Spot prices NO1 2026-10/.test(l));
  assert.ok(lines.length <= 1, lines.join('\n'));
  await env.app.stop();
});

test('/data content that throws while read: ignored, the session starts', async () => {
  const stores = memoryStores();
  stores.state.load = async () => ({
    get refreshAt() {
      throw new Error('broken');
    },
  });
  const env = await setup({ config: { refresh_data: false }, stores });
  await env.run();
  assert.match(statusText(env), /^1 contract/);
  assert.match(env.lines.join('\n'), /\/data state: unexpected content ignored/);
  assert.ok(env.pending.size > 0);
  await env.app.stop();
});
