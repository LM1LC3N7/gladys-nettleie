// -----------------------------------------------------------------------------
// The app against the SDK's fake Gladys, a scripted network (fake fetch by
// URL) and a virtual clock that only moves when the test says so (each read
// of the monotonic clock moves 1 µs, so a decision reading it twice is
// caught). Nothing touches the network.
// -----------------------------------------------------------------------------

import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { NettleieApp } from '../../src/app.js';
import { registerHandlers } from '../../src/handlers.js';
import { createMemoryStore } from '../../src/store.js';

export const SELECTOR = 'nettleie';
export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
// Wednesday 11 November 2026, 09:20 in Oslo (UTC+1).
export const NOW = Date.parse('2026-11-11T08:20:00Z');
export const CONTRACT_ID = '6f1c2b1e-4d3a-4c1b-9a8e-0b1c2d3e4f50';
export const OTHER_ID = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
export const DEVICE = (id = CONTRACT_ID) => `ext:${SELECTOR}:contract:${id}`;
export const F = (key, id = CONTRACT_ID) => `ext:${SELECTOR}:contract:${id}:${key}`;

export function contract(inputs = {}, id = CONTRACT_ID, extra = {}) {
  return {
    id,
    template_key: 'nettleie-no',
    template_version: '2026-11-11',
    pricing_mode: 'delegated',
    inputs: { grid_company: 'Elvia', ...inputs },
    valid_from: '2026-01-01',
    valid_to: null,
    timezone: 'Europe/Oslo',
    currency: 'NOK',
    billing_period_start_day: 1,
    status: 'active',
    ...extra,
  };
}

/** Lets every pending promise run (a few event-loop turns). */
export async function settle(turns = 20) {
  for (let i = 0; i < turns; i += 1) await new Promise((r) => setImmediate(r));
}

export function createFakeClock(start) {
  const clock = { now: start };
  let nextId = 1;
  const pending = new Map();
  const timers = {
    setTimeout(fn, ms) {
      const id = nextId++;
      pending.set(id, { fn, at: clock.now + Math.max(0, Number(ms) || 0) });
      return id;
    },
    clearTimeout(id) {
      pending.delete(id);
    },
  };
  async function advance(ms) {
    const target = clock.now + ms;
    await settle();
    for (let i = 0; i < 100_000; i += 1) {
      let next;
      for (const [id, timer] of pending) {
        if (timer.at <= target && (!next || timer.at < next.timer.at)) next = { id, timer };
      }
      if (!next) break;
      pending.delete(next.id);
      clock.now = Math.max(clock.now, next.timer.at);
      next.timer.fn();
      await settle();
    }
    clock.now = Math.max(clock.now, target);
    await settle();
  }
  return { clock, timers, pending, advance };
}

/**
 * A scripted network: `routes` maps a URL prefix to a function
 * `(url, init) => Response | Promise<Response>`; an unknown URL is a network
 * error. `calls` records every request (url, headers).
 */
export function createNet(routes = {}) {
  const net = {
    routes,
    calls: [],
    fetch: async (url, init = {}) => {
      net.calls.push({ url, headers: init.headers ?? {} });
      const prefix = Object.keys(net.routes)
        .filter((p) => url.startsWith(p))
        .sort((a, b) => b.length - a.length)[0];
      if (!prefix) throw Object.assign(new Error('offline'), { code: 'ENOTFOUND' });
      return net.routes[prefix](url, init);
    },
    count: (prefix) => net.calls.filter((c) => c.url.startsWith(prefix)).length,
  };
  return net;
}

export const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

export const plain = (body, status = 200, headers = {}) =>
  new Response(body, { status, headers: { 'content-type': 'text/plain', ...headers } });

export function memoryStores(initial = {}) {
  return {
    state: createMemoryStore(initial.state ?? {}),
    spot: createMemoryStore(initial.spot ?? {}),
    capacity: createMemoryStore(initial.capacity ?? {}),
  };
}

export async function setup({
  config = {},
  contracts = [contract()],
  stores = memoryStores(),
  net = createNet(),
  start = NOW,
  devices = [],
  getConfig,
  getEnergyContracts,
} = {}) {
  const gladys = createFakeGladys({
    selector: SELECTOR,
    config,
    devices,
    energyContracts: contracts,
  });
  await gladys.connect();
  if (getConfig) gladys.getConfig = getConfig;
  if (getEnergyContracts) gladys.getEnergyContracts = getEnergyContracts;
  const fake = createFakeClock(start);
  let drift = 0;
  const lines = [];
  const log = (...args) => lines.push(args.map(String).join(' '));
  const app = new NettleieApp({
    gladys,
    logger: { info: log, warn: log, error: log, debug: log },
    now: () => fake.clock.now,
    monotonic: () => fake.clock.now + (drift += 0.001),
    timers: fake.timers,
    fetchImpl: net.fetch,
    stores,
  });
  registerHandlers(gladys, app, { error: log });
  return {
    app,
    gladys,
    net,
    stores,
    lines,
    clock: fake.clock,
    pending: fake.pending,
    advance: fake.advance,
    async run(ms = 1 * SECOND) {
      await app.connected();
      await fake.advance(ms);
    },
    status: () => gladys.fake.connectionStatus,
    last: (id) => gladys.fake.lastState(id),
    states: (id) => gladys.fake.states.filter((s) => s.device_feature_external_id === id),
  };
}

/** The 30-minute intervals from `startIso`, `count` of them, `kwh` each (or a function). */
export function intervalsFrom(startIso, count, kwh = 1) {
  const start = Date.parse(startIso);
  return Array.from({ length: count }, (_, i) => ({
    starts_at: new Date(start + i * 30 * MINUTE).toISOString(),
    kwh: typeof kwh === 'function' ? kwh(i) : kwh,
    max_power_kw: 0,
  }));
}

/** A delegated pricing request of the fake core. */
export function priceRequest(intervals, { inputs, monthBefore = 0, id = CONTRACT_ID } = {}) {
  const c = contract(inputs, id);
  return {
    contract: {
      id: c.id,
      template_key: c.template_key,
      inputs: c.inputs,
      currency: 'NOK',
      timezone: 'Europe/Oslo',
      billing_period_start_day: 1,
    },
    billing_period: { starts_at: '2026-10-31T23:00:00.000Z', ends_at: '2026-11-30T23:00:00.000Z' },
    cumulative_before: { day: 0, month: monthBefore, billing_period: monthBefore },
    intervals,
  };
}

/** A Nord Pool answer for a day: every quarter at `price(i)` NOK/MWh for the areas. */
export function nordPoolDay(date, areas = ['NO1'], price = () => 1000) {
  const start = Date.parse(`${date}T00:00:00+01:00`);
  const entries = [];
  for (let i = 0; i < 96; i += 1) {
    const s = start + i * 15 * MINUTE;
    entries.push({
      deliveryStart: new Date(s).toISOString(),
      deliveryEnd: new Date(s + 15 * MINUTE).toISOString(),
      entryPerArea: Object.fromEntries(areas.map((a) => [a, price(i, a)])),
    });
  }
  return { deliveryDateCET: date, currency: 'NOK', multiAreaEntries: entries, areaStates: [] };
}
