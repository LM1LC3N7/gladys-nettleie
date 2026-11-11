// -----------------------------------------------------------------------------
// On a real clock (sped up): the device states every quarter of an hour,
// never faster; the daily refresh of fri-nettleie once a day, never faster.
// Cleanup in t.after: a failing test never leaves the app running.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { stringify } from 'yaml';
import { NettleieApp } from '../src/app.js';
import { loadSnapshot } from '../src/catalog.js';
import { registerHandlers } from '../src/handlers.js';
import { contract, createNet, memoryStores, plain } from './helpers/app.js';
import { measurePeriod, realClock, spyOn } from './helpers/realclock.js';

const RAW = 'https://raw.githubusercontent.com/kraftsystemet/fri-nettleie/main/';
const snapshot = loadSnapshot();

async function start(t, { speed, config, net = createNet() }) {
  const clock = realClock({ speed, start: Date.parse('2026-11-11T08:20:00Z') });
  const gladys = createFakeGladys({ selector: 'nettleie', config, energyContracts: [contract()] });
  await gladys.connect();
  const quiet = () => {};
  const app = new NettleieApp({
    gladys,
    logger: { info: quiet, warn: quiet, error: quiet, debug: quiet },
    now: clock.now,
    monotonic: clock.monotonic,
    timers: clock.timers,
    fetchImpl: net.fetch,
    stores: memoryStores(),
  });
  registerHandlers(gladys, app, { error: quiet });
  t.after(async () => {
    await app.stop();
    clock.close();
  });
  return { app, clock, net };
}

test('real clock: the quarter tick every 15 minutes, never faster', async (t) => {
  const speed = 1000;
  const { app, clock } = await start(t, { speed, config: { refresh_data: false } });
  const calls = spyOn(app, 'tick', clock);
  await app.connected();
  // The first tick runs at the start, the second at the next quarter: then 15 min.
  await measurePeriod(calls, { count: 3, period: 15 * 60_000, speed, skip: 1 });
  await app.stop();
  assert.equal(clock.pending, 0);
});

test('real clock: fri-nettleie read once a day, never faster', async (t) => {
  const speed = 40_000;
  const net = createNet({
    [`${RAW}docs/`]: () => plain(stringify(snapshot.rates)),
    [`${RAW}tariffer/`]: () => plain(stringify(snapshot.companies.elvia.doc)),
  });
  const { app, clock } = await start(t, { speed, config: {}, net });
  const calls = spyOn(app, 'refresh', clock);
  await app.connected();
  await measurePeriod(calls, { count: 2, period: 24 * 3600_000, speed });
  // Two files per round, nothing else.
  assert.ok(net.calls.length >= 4 && net.calls.length <= 6, `${net.calls.length} requests`);
});
