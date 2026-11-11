// -----------------------------------------------------------------------------
// The integration: the contracts of the "nettleie-no" template, their delegated
// pricing, the capacity step they reach, the daily refresh of the fri-nettleie
// files they use, the spot prices when a contract needs them, the devices and
// the status. index.js only wires the SDK handlers to it (src/handlers.js).
//
// Clocks: the wall clock gives the local time of the prices (a tariff is a
// local-time rule) and the due times kept in /data across restarts; the
// waits of this process (pauses, retries, request spacing) use the monotonic
// clock. Requests to one service go one after the other, REQUEST_GAP apart;
// a 429 or a 5xx pauses that service (Retry-After, else 1 h doubling up to
// 6 h), kept in /data.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { parse as parseYaml } from 'yaml';
import { Catalog, CompanyError, loadSnapshot } from './catalog.js';
import { peakOf, emptyRecord, monthKwh, recordIntervals } from './capacity.js';
import { normalizeConfig } from './config.js';
import {
  CONTRACTS_INTERVAL,
  HOUR,
  MINUTE,
  PAUSE_MAX,
  PAUSE_MIN,
  RATES_PATH,
  RAW_BASE,
  REFRESH_INTERVAL,
  REFRESH_RETRY,
  REQUEST_GAP,
  RETRY_MAX,
  RETRY_MIN,
  SPOT_DAYS_PER_ASK,
  SPOT_FIRST_DAY,
  SPOT_QUEUE_MAX,
  SPOT_RETRY,
  SPOT_TOMORROW_HOUR,
  STORE_RETRY,
  STORE_WAIT,
  TEST_CONTRACTS,
  TICK,
} from './constants.js';
import { InputError, TEMPLATE_KEY, readInputs } from './contract.js';
import { buildDevice, buildStates, idsOf, validContractId } from './devices.js';
import { HttpError, getJson, getText } from './http.js';
import { join, text } from './i18n.js';
import { compareDay, nveUrl, parseNveDay } from './nve.js';
import { SpotMissing, currentPrice, priceIntervals } from './pricing.js';
import { RateError, checkRates, taxesOn } from './rates.js';
import { checkSpotCache, daysOf, parseSpotDay, priceIn, pruneSpot, spotUrl } from './spot.js';
import { FileStore } from './store.js';
import {
  COMPUTED_METHODS,
  TariffError,
  capacityStep,
  checkCompany,
  energyPrice,
  tariffOn,
} from './tariffs.js';
import { nextDate, oslo, osloMidnight } from './time.js';

// Nordland, Troms, Finnmark: no VAT on household electricity (north or tiltakssone zone).
const NORTHERN_COUNTIES = ['18', '55', '56'];
const SERVICES = {
  github: 'GitHub (fri-nettleie)',
  spot: 'Hva koster strømmen.no',
  nve: 'NVE',
};
const defaultTimers = { setTimeout, clearTimeout };
const defaultMonotonic = () => performance.timeOrigin + performance.now();

/** A short, safe text of an error for the status and the logs (never a stack). */
export function problemOf(err) {
  if (err instanceof CompanyError) {
    return err.suggestions.length
      ? `${err.message} (did you mean: ${err.suggestions.join(', ')}?)`
      : `${err.message} (see the list in the documentation)`;
  }
  if (err instanceof TariffError && err.names?.length) {
    return `${err.message}; fill "Tariff name" with one of: ${err.names.join(', ')}`;
  }
  if (
    err instanceof InputError ||
    err instanceof TariffError ||
    err instanceof RateError ||
    err instanceof SpotMissing ||
    err instanceof HttpError
  ) {
    return err.message;
  }
  return 'internal error, see the logs';
}

export class NettleieApp {
  constructor({
    gladys,
    logger = createLogger({ name: 'nettleie' }),
    now = Date.now,
    monotonic = defaultMonotonic,
    timers = defaultTimers,
    fetchImpl = (...args) => globalThis.fetch(...args),
    stores = {
      state: new FileStore({ name: 'nettleie-state.json' }),
      spot: new FileStore({ name: 'nettleie-spot.json' }),
      capacity: new FileStore({ name: 'nettleie-capacity.json' }),
    },
    snapshot = loadSnapshot(),
  }) {
    this.gladys = gladys;
    this.log = logger;
    this.now = now;
    this.monotonic = monotonic;
    this.timers = timers;
    this.fetchImpl = fetchImpl;
    this.stores = stores;
    this.catalog = new Catalog(snapshot);
    this.config = normalizeConfig();
    /** id -> { id, inputs, status } of the contracts of the template. */
    this.contracts = new Map();
    this.contractsUnread = false;
    /** id -> capacity record ({ intervals }). */
    this.capacity = new Map();
    this.spot = {};
    /** "date" -> monotonic time before which the day is not asked again. */
    this.spotWait = new Map();
    this.spotQueue = new Set();
    this.spotDraining = null;
    /** id -> short problem text of the last pricing (cleared by a success). */
    this.problems = new Map();
    this.nveCache = new Map();
    this.state = { refreshAt: 0, pauses: {}, live: {}, rates: null };
    /** service -> monotonic end of its pause. */
    this.pauseEnds = {};
    this.loaded = { state: false, spot: false, capacity: false };
    this.storeReads = {};
    this.unreadable = false;
    this.lanes = {};
    this.timerIds = {};
    this.sleeps = new Set();
    this.gen = 0;
    this.stopped = true;
    this.configDelay = 0;
    this.contractsDelay = 0;
    this.lastStatus = undefined;
  }

  // --- Timers ------------------------------------------------------------------------

  setTimer(name, ms, fn) {
    this.clearTimer(name);
    const gen = this.gen;
    this.timerIds[name] = this.timers.setTimeout(
      () => {
        delete this.timerIds[name];
        if (this.stopped || gen !== this.gen) return;
        Promise.resolve()
          .then(fn)
          .catch((err) => this.log.error(`${name} failed (${err?.name ?? 'Error'})`));
      },
      Math.max(0, ms),
    );
  }

  clearTimer(name) {
    if (this.timerIds[name] !== undefined) {
      this.timers.clearTimeout(this.timerIds[name]);
      delete this.timerIds[name];
    }
  }

  stale(gen) {
    return this.stopped || gen !== this.gen;
  }

  // --- Lifecycle -----------------------------------------------------------------------

  /** Every (re)connection to Gladys: the config (retried for ever), then start. */
  async connected() {
    const gen = ++this.gen;
    this.stopped = false;
    this.lastStatus = undefined;
    // What Gladys holds may be older than this process: published again.
    this.gladys.forgetPublishedStates?.();
    this.clearTimer('config');
    let config;
    try {
      config = await this.gladys.getConfig();
    } catch (err) {
      if (this.stale(gen)) return;
      this.configDelay = Math.min(RETRY_MAX, Math.max(RETRY_MIN, this.configDelay * 2));
      this.log.warn(
        `Configuration not read (${err?.name ?? 'Error'}): again in ${this.configDelay / 1000} s`,
      );
      await this.setStatus(false, text('configUnread'));
      this.setTimer('config', this.configDelay, () => this.connected());
      return;
    }
    if (this.stale(gen)) return;
    this.configDelay = 0;
    await this.start(config);
  }

  async start(rawConfig) {
    this.clearAllTimers();
    const gen = ++this.gen;
    this.stopped = false;
    this.config = normalizeConfig(rawConfig);
    await this.loadStores();
    if (this.stale(gen)) return;
    await this.loadContracts();
    if (this.stale(gen)) return;
    await this.publishDevices();
    this.scheduleRefresh();
    this.setTimer('tick', 0, () => this.tick());
    await this.updateStatus();
  }

  async stop() {
    this.stopped = true;
    this.gen += 1;
    this.clearAllTimers();
    // The requests waiting their turn wake up now and see the stop.
    for (const wait of this.sleeps) {
      this.timers.clearTimeout(wait.id);
      wait.resolve();
    }
    this.sleeps.clear();
    await Promise.all(Object.values(this.stores).map((s) => s.flush?.())).catch(() => {});
  }

  clearAllTimers() {
    for (const name of Object.keys(this.timerIds)) this.clearTimer(name);
  }

  /** Waits `ms` on a timer that stop() cancels (the wait then ends at once). */
  sleep(ms) {
    return new Promise((resolve) => {
      const wait = { resolve };
      wait.id = this.timers.setTimeout(() => {
        this.sleeps.delete(wait);
        resolve();
      }, ms);
      this.sleeps.add(wait);
    });
  }

  // --- /data ---------------------------------------------------------------------------

  /**
   * Reads the stores not read yet, each waited for STORE_WAIT at most (a slow
   * /data never holds the start); one read per store at a time. A store
   * unreadable or still reading is read again on its own timer; a late
   * answer is merged when it comes.
   */
  async loadStores() {
    const gen = this.gen;
    const names = ['state', 'spot', 'capacity'];
    await Promise.all(names.map((name) => this.loadStore(name)));
    if (this.stale(gen)) return;
    this.unreadable = names.some((name) => !this.loaded[name]);
    if (this.unreadable) {
      this.setTimer('store', STORE_RETRY, async () => {
        await this.loadStores();
        await this.updateStatus();
      });
    }
  }

  /** One store: true once read (now or by an earlier read). */
  async loadStore(name) {
    if (this.loaded[name]) return true;
    let read = this.storeReads[name];
    if (!read) {
      read = this.stores[name].load().then(
        (data) => {
          delete this.storeReads[name];
          if (this.loaded[name]) return true;
          this.loaded[name] = true;
          this.merge(name, data);
          return true;
        },
        (err) => {
          delete this.storeReads[name];
          this.log.warn(
            `/data ${name} unreadable (${err?.message ?? 'error'}): not written until it reads`,
          );
          return false;
        },
      );
      this.storeReads[name] = read;
    }
    let timer;
    const late = new Promise((resolve) => {
      timer = this.timers.setTimeout(() => resolve(false), STORE_WAIT);
    });
    try {
      return await Promise.race([read, late]);
    } finally {
      this.timers.clearTimeout(timer);
    }
  }

  /** What /data held, merged under what this process already knows. */
  merge(name, data) {
    if (name === 'state') {
      const refreshAt = Number(data.refreshAt);
      // A due time far in the future is not trusted (clock changed): due now.
      this.state.refreshAt =
        Number.isFinite(refreshAt) && refreshAt <= this.now() + REFRESH_INTERVAL ? refreshAt : 0;
      for (const [service, pause] of Object.entries(data.pauses ?? {})) {
        if (!(service in SERVICES) || this.state.pauses[service]) continue;
        const until = Number(pause?.until);
        if (Number.isFinite(until) && until > this.now() && until <= this.now() + PAUSE_MAX) {
          this.state.pauses[service] = {
            until,
            delay: Math.min(PAUSE_MAX, Number(pause.delay) || PAUSE_MIN),
            status: Number(pause.status) || 0,
          };
          // The wall time only carries the pause across the restart: this
          // process waits on its monotonic clock.
          this.pauseEnds[service] = this.monotonic() + (until - this.now());
        }
      }
      for (const [slug, entry] of Object.entries(data.live ?? {})) {
        if (!this.catalog.paths[slug] || this.catalog.live.has(slug)) continue;
        const { company } = checkCompany(entry?.doc);
        if (company && company.tariffs.length > 0) {
          this.catalog.setLive(slug, company, entry.etag ?? null, Number(entry.at) || 0);
          this.state.live[slug] = entry;
        }
      }
      if (data.rates && !this.catalog.liveRates) {
        const rates = checkRates(data.rates.doc);
        if (rates) {
          this.catalog.setLiveRates(rates, data.rates.etag ?? null, Number(data.rates.at) || 0);
          this.state.rates = data.rates;
        }
      }
    } else if (name === 'spot') {
      const cache = checkSpotCache(data.areas);
      for (const [area, days] of Object.entries(cache)) {
        this.spot[area] = { ...days, ...(this.spot[area] ?? {}) };
      }
    } else if (name === 'capacity') {
      for (const [id, record] of Object.entries(data.contracts ?? {})) {
        if (!validContractId(id) || !record || typeof record.intervals !== 'object') continue;
        const mine = this.capacity.get(id) ?? emptyRecord();
        for (const [key, kwh] of Object.entries(record.intervals)) {
          if (!(key in mine.intervals) && Number.isFinite(kwh) && kwh >= 0) {
            mine.intervals[key] = kwh;
          }
        }
        this.capacity.set(id, mine);
      }
    }
  }

  /** Saves one store; never while it has not been read (it would erase it). */
  /** Saves one store; true when written. Never while it has not been read (it would erase it). */
  async save(name) {
    if (!this.loaded[name]) return false;
    let data;
    if (name === 'state') data = { v: 1, ...this.state };
    else if (name === 'spot') data = { v: 1, areas: this.spot };
    else data = { v: 1, contracts: Object.fromEntries(this.capacity) };
    try {
      await this.stores[name].save(data);
      return true;
    } catch (err) {
      this.log.warn(`/data ${name} not written (${err?.code ?? err?.name ?? 'Error'})`);
      return false;
    }
  }

  // --- Contracts -----------------------------------------------------------------------

  async loadContracts() {
    const gen = this.gen;
    let list;
    try {
      list = await this.gladys.getEnergyContracts();
    } catch (err) {
      if (this.stale(gen)) return;
      this.contractsUnread = true;
      this.contractsDelay = Math.min(RETRY_MAX, Math.max(RETRY_MIN, this.contractsDelay * 2));
      this.log.warn(
        `Contracts not read (${err?.name ?? 'Error'}): again in ${this.contractsDelay / 1000} s`,
      );
      this.setTimer('contracts', this.contractsDelay, async () => {
        await this.loadContracts();
        await this.publishDevices();
        await this.updateStatus();
      });
      return;
    }
    if (this.stale(gen)) return;
    this.contractsUnread = false;
    this.contractsDelay = 0;
    const next = new Map();
    for (const c of Array.isArray(list) ? list : []) {
      if (c?.template_key !== TEMPLATE_KEY || !validContractId(c.id)) continue;
      if (c.status === 'expired' || c.status === 'orphaned') continue;
      next.set(c.id, { id: c.id, inputs: c.inputs ?? {}, status: c.status });
    }
    this.contracts = next;
    for (const id of this.problems.keys()) if (!next.has(id)) this.problems.delete(id);
    this.setTimer('contracts', CONTRACTS_INTERVAL, async () => {
      await this.loadContracts();
      await this.updateStatus();
    });
  }

  /** The settings of a contract: `{ settings, slug, company }`; throws on a wrong input. */
  resolve(inputs) {
    const settings = readInputs(inputs);
    const slug = this.catalog.resolve(settings.company);
    return { settings, slug, company: this.catalog.company(slug) };
  }

  context(company) {
    return {
      company,
      rates: this.catalog.rates(),
      spot: (area, ms) => priceIn(this.spot[area]?.[oslo(ms).date], ms),
    };
  }

  // --- Delegated pricing ---------------------------------------------------------------

  async energyPrice({ contract, cumulative_before: before, intervals = [] }) {
    if (contract?.template_key !== TEMPLATE_KEY) {
      throw new Error(
        `template ${String(contract?.template_key).slice(0, 64)} is not this integration's`,
      );
    }
    const id = contract.id;
    if (validContractId(id) && !this.contracts.has(id)) {
      this.contracts.set(id, { id, inputs: contract.inputs ?? {}, status: 'active' });
    } else if (validContractId(id)) {
      this.contracts.get(id).inputs = contract.inputs ?? {};
    }
    if (!Array.isArray(intervals) || intervals.length === 0) return [];
    // The consumption feeds the capacity step, whatever the pricing gives.
    if (validContractId(id)) this.record(id, intervals);
    try {
      const { settings, company } = this.resolve(contract.inputs);
      try {
        const costs = priceIntervals(
          intervals,
          Number(before?.month),
          settings,
          this.context(company),
        );
        if (this.problems.delete(id)) this.updateStatus().catch(() => {});
        return costs;
      } catch (err) {
        // Never a wait here: the days missing are read in the background and
        // Gladys asks again at its next run (30 minutes at most).
        if (err instanceof SpotMissing) {
          this.wantSpot(
            err.area,
            daysOf(intervals.map((i) => Date.parse(i?.starts_at)).filter(Number.isFinite)),
          );
        }
        throw err;
      }
    } catch (err) {
      const problem = problemOf(err);
      if (validContractId(id)) this.problems.set(id, problem);
      this.log.warn(`Contract ${String(id).slice(0, 36)} not priced: ${problem}`);
      this.updateStatus().catch(() => {});
      throw new Error(problem, { cause: err });
    }
  }

  /** The current price, from what is held (never a request: Gladys waits 5 s). */
  async energyCurrent({ contract, cumulative }) {
    try {
      const { settings, company } = this.resolve(contract?.inputs);
      return currentPrice(this.now(), Number(cumulative?.month), settings, this.context(company));
    } catch {
      return { price: null };
    }
  }

  record(id, intervals) {
    const record = this.capacity.get(id) ?? emptyRecord();
    recordIntervals(
      record,
      intervals.map((i) => ({ start: Date.parse(i?.starts_at), kwh: i?.kwh })),
      this.now(),
    );
    this.capacity.set(id, record);
    this.save('capacity').catch(() => {});
    this.publishContract(id).catch(() => {});
  }

  /** The capacity of a contract this month: `{ kw, monthlyWithVat, next, method }` or null. */
  capacityOf(id, settings, company) {
    const local = oslo(this.now());
    const tariff = tariffOn(company, {
      group: settings.group,
      name: settings.tariffName,
      date: local.date,
    });
    const { method } = tariff.capacity;
    if (!COMPUTED_METHODS.includes(method)) return { method, kw: null };
    const peak = peakOf(this.capacity.get(id) ?? emptyRecord(), local.month, method);
    if (!peak) return { method, kw: null };
    const step = capacityStep(tariff.capacity, peak.kw);
    let monthlyWithVat = null;
    if (step) {
      try {
        monthlyWithVat =
          step.monthly * (1 + taxesOn(this.catalog.rates(), settings.zone, local.date).vat);
      } catch {
        monthlyWithVat = null;
      }
    }
    return { method, kw: peak.kw, monthlyWithVat, next: step ? step.next : null };
  }

  // --- Devices -------------------------------------------------------------------------

  devicesToPublish() {
    const devices = [];
    for (const { id, inputs } of this.contracts.values()) {
      let companyName;
      try {
        companyName = this.resolve(inputs).company.name;
      } catch {
        companyName = String(inputs?.grid_company ?? '?').slice(0, 60);
      }
      devices.push(buildDevice(this.gladys, { id, companyName }));
    }
    return devices;
  }

  async publishDevices() {
    try {
      await this.gladys.publishDiscoveredDevices(this.devicesToPublish());
    } catch (err) {
      this.log.warn(`Discovery not published (${err?.name ?? 'Error'})`);
    }
  }

  /** Discovery: the contracts listed again, never a request outside Gladys. */
  async scan() {
    await this.loadContracts();
    await this.publishDevices();
  }

  async publishContract(id) {
    const contract = this.contracts.get(id);
    if (!contract || this.stopped) return;
    let price;
    let capacity;
    try {
      const { settings, company } = this.resolve(contract.inputs);
      const record = this.capacity.get(id) ?? emptyRecord();
      try {
        price = currentPrice(
          this.now(),
          monthKwh(record, oslo(this.now()).month),
          settings,
          this.context(company),
        ).price;
      } catch {
        price = null;
      }
      try {
        capacity = this.capacityOf(id, settings, company);
      } catch {
        capacity = null;
      }
    } catch {
      return;
    }
    const states = buildStates(this.gladys, id, { price, capacity });
    if (states.length === 0) return;
    try {
      await this.gladys.publishChangedStates(states);
    } catch (err) {
      this.log.warn(`States not published (${err?.name ?? 'Error'})`);
    }
  }

  async onDeviceCreated(device) {
    for (const id of this.contracts.keys()) {
      if (device?.external_id === idsOf(this.gladys, id).device) await this.publishContract(id);
    }
  }

  // --- Quarter tick: states and spot prices --------------------------------------------

  async tick() {
    const gen = this.gen;
    const now = this.now();
    for (const id of this.contracts.keys()) {
      await this.publishContract(id);
      if (this.stale(gen)) return;
    }
    const local = oslo(now);
    const dates = [local.date];
    if (local.h >= SPOT_TOMORROW_HOUR) dates.push(nextDate(local.date));
    for (const area of this.spotAreas()) this.wantSpot(area, dates);
    // Next tick at the next quarter of the wall clock (+5 s, after the change).
    const quarter = 15 * MINUTE;
    this.setTimer('tick', Math.min(TICK, quarter - (now % quarter) + 5000), () => this.tick());
  }

  /** The areas of the contracts that read spot prices. */
  spotAreas() {
    const areas = new Set();
    for (const { inputs } of this.contracts.values()) {
      try {
        const settings = readInputs(inputs);
        if (settings.supply !== 'grid_only') areas.add(settings.area);
      } catch {
        // a wrong input is reported by its pricing
      }
    }
    return [...areas].sort();
  }

  /**
   * Queues the days of an area that are not held for a read in the
   * background (one at a time, on the spot lane), never awaited. A day not
   * published yet or that failed is not asked again before SPOT_RETRY; a day
   * before the history of the source or after tomorrow is never asked.
   */
  wantSpot(area, dates) {
    const today = oslo(this.now()).date;
    const tomorrow = nextDate(today);
    for (const date of dates.slice(0, SPOT_DAYS_PER_ASK)) {
      if (date < SPOT_FIRST_DAY || date > tomorrow) continue;
      if (this.spot[area]?.[date]) continue;
      const key = `${area}|${date}`;
      const wait = this.spotWait.get(key);
      if (wait !== undefined && this.monotonic() < wait) continue;
      if (this.spotQueue.size >= SPOT_QUEUE_MAX) break;
      this.spotQueue.add(key);
    }
    if (!this.spotDraining && this.spotQueue.size > 0) {
      this.spotDraining = this.drainSpot().finally(() => {
        this.spotDraining = null;
      });
    }
  }

  async drainSpot() {
    const gen = this.gen;
    while (this.spotQueue.size > 0 && !this.stale(gen)) {
      const key = this.spotQueue.values().next().value;
      this.spotQueue.delete(key);
      const [area, date] = key.split('|');
      if (this.spot[area]?.[date]) continue;
      let answer;
      try {
        answer = await this.request('spot', spotUrl(date, area), { json: true, timeoutMs: 10_000 });
      } catch (err) {
        this.spotWait.set(key, this.monotonic() + SPOT_RETRY);
        // 404: the day is not published yet (tomorrow before 13:00).
        if (err?.status !== 404) {
          this.log.warn(`Spot prices ${area} ${date} not read (${err?.message ?? 'error'})`);
        }
        continue;
      }
      if (this.stale(gen)) return;
      const slots = answer.data === undefined ? null : parseSpotDay(answer.data, date);
      if (!slots) {
        // Not the whole day: never kept in part.
        this.spotWait.set(key, this.monotonic() + SPOT_RETRY);
        this.log.warn(`Spot prices ${area} ${date}: not a whole day, not kept`);
        continue;
      }
      (this.spot[area] ??= {})[date] = { slots, at: this.now() };
      pruneSpot(this.spot, oslo(this.now()).date);
      await this.save('spot');
    }
  }

  // --- Requests: one lane per service, paused after a 429/5xx --------------------------

  pauseOf(service) {
    const end = this.pauseEnds[service];
    return end !== undefined && end > this.monotonic() ? this.state.pauses[service] : null;
  }

  request(service, url, { json = false, headers = {}, accept, maxBytes, timeoutMs } = {}) {
    const lane = (this.lanes[service] ??= { tail: Promise.resolve(), last: -Infinity });
    const run = async () => {
      const paused = this.pauseOf(service);
      if (paused) {
        throw new HttpError('paused', `${SERVICES[service]} paused after HTTP ${paused.status}`);
      }
      const gap = lane.last + REQUEST_GAP - this.monotonic();
      if (gap > 0) await this.sleep(gap);
      // Stopped while waiting its turn: nothing leaves after stop().
      if (this.stopped) throw new HttpError('stopped', 'integration stopped');
      lane.last = this.monotonic();
      const options = {
        headers,
        accept: accept ?? (json ? 'application/json' : 'text/plain'),
        maxBytes,
        timeoutMs,
        now: this.now,
        timers: this.timers,
      };
      try {
        const result = json
          ? await getJson(this.fetchImpl, url, options)
          : await getText(this.fetchImpl, url, options);
        if (this.state.pauses[service]) {
          delete this.state.pauses[service];
          delete this.pauseEnds[service];
          this.save('state').catch(() => {});
        }
        return result;
      } catch (err) {
        if (
          err instanceof HttpError &&
          err.code === 'status' &&
          (err.status === 429 || err.status >= 500)
        ) {
          const previous = this.state.pauses[service];
          const delay = previous ? Math.min(PAUSE_MAX, previous.delay * 2) : PAUSE_MIN;
          const wait = Math.min(PAUSE_MAX, Math.max(err.retryAfter ?? delay, 60_000));
          this.state.pauses[service] = { until: this.now() + wait, delay, status: err.status };
          this.pauseEnds[service] = this.monotonic() + wait;
          this.save('state').catch(() => {});
        }
        throw err;
      } finally {
        lane.last = this.monotonic();
      }
    };
    const job = lane.tail.then(run, run);
    lane.tail = job.catch(() => {});
    return job;
  }

  // --- Daily refresh of fri-nettleie ---------------------------------------------------

  scheduleRefresh() {
    if (!this.config.refresh_data) return;
    const due = Math.max(0, this.state.refreshAt - this.now());
    this.setTimer('refresh', Math.min(due, REFRESH_INTERVAL), () => this.refresh());
  }

  /** The slugs the contracts use (resolved), in order. */
  usedSlugs() {
    const slugs = new Set();
    for (const { inputs } of this.contracts.values()) {
      try {
        slugs.add(this.resolve(inputs).slug);
      } catch {
        // reported by the pricing
      }
    }
    return [...slugs].sort();
  }

  async refresh() {
    const gen = this.gen;
    // Due time written before the requests: a restart never asks sooner.
    this.state.refreshAt = this.now() + REFRESH_RETRY;
    if (!(await this.save('state'))) {
      // Not written (/data unreadable or read-only): no read, or every restart
      // would read again. The shipped data stays; tried again in an hour.
      if (!this.stale(gen)) this.setTimer('refresh', REFRESH_RETRY, () => this.refresh());
      return;
    }
    let ok = await this.refreshFile('rates', RATES_PATH);
    for (const slug of this.usedSlugs()) {
      if (this.stale(gen)) return;
      ok = (await this.refreshFile(slug, this.catalog.paths[slug])) && ok;
    }
    if (this.stale(gen)) return;
    if (ok) this.state.refreshAt = this.now() + REFRESH_INTERVAL;
    await this.save('state');
    this.scheduleRefresh();
    await this.updateStatus();
  }

  /** Reads one file again; true when it was read (changed or not). */
  async refreshFile(slug, path) {
    const previous = slug === 'rates' ? this.state.rates : this.state.live[slug];
    let answer;
    try {
      answer = await this.request('github', `${RAW_BASE}${path}`, {
        headers: previous?.etag ? { 'If-None-Match': previous.etag } : {},
        accept: 'text/plain',
        maxBytes: 512 * 1024,
      });
    } catch (err) {
      this.log.warn(`fri-nettleie ${path} not read (${err?.message ?? 'error'})`);
      return false;
    }
    if (answer.status === 304) return true;
    let doc;
    try {
      doc = parseYaml(answer.text, { maxAliasCount: 0, uniqueKeys: true, prettyErrors: false });
    } catch {
      this.log.warn(`fri-nettleie ${path}: not YAML, the previous data stays`);
      return false;
    }
    const at = this.now();
    if (slug === 'rates') {
      const rates = checkRates(doc);
      if (!rates) {
        this.log.warn(`fri-nettleie ${path}: refused by the checks, the previous rates stay`);
        return false;
      }
      this.catalog.setLiveRates(rates, answer.etag, at);
      this.state.rates = { doc, etag: answer.etag, at };
      return true;
    }
    const { company, problems } = checkCompany(doc);
    if (problems.length) this.log.warn(`fri-nettleie ${path}: ${problems.slice(0, 5).join('; ')}`);
    if (!company || company.tariffs.length === 0) {
      this.log.warn(`fri-nettleie ${path}: refused by the checks, the previous data stays`);
      return false;
    }
    this.catalog.setLive(slug, company, answer.etag, at);
    this.state.live[slug] = { doc, etag: answer.etag, at };
    return true;
  }

  // --- Status --------------------------------------------------------------------------

  dataDate() {
    const dates = this.usedSlugs().map((s) => this.catalog.company(s).updated);
    if (dates.length > 0) return dates.sort()[0];
    return String(this.catalog.source?.committed ?? '').slice(0, 10);
  }

  /**
   * Warnings about the contracts that still price: a company's data not
   * checked since before this year, a tax zone that does not match the county
   * of the company (from the NVE list).
   */
  warnings() {
    const out = [];
    const seen = new Set();
    for (const { inputs } of this.contracts.values()) {
      let resolved;
      try {
        resolved = this.resolve(inputs);
      } catch {
        continue;
      }
      for (const w of this.warningsFor(resolved, seen)) out.push(w);
    }
    return out;
  }

  warningsFor({ slug, company, settings }, seen = new Set()) {
    const out = [];
    const year = oslo(this.now()).y;
    // A tariff carried over from an earlier year (open, not dated this year)
    // whose file was not checked this year: still used, but said.
    const yearStart = `${year}-01-01`;
    if (!seen.has(slug) && company.updated < yearStart) {
      let from = yearStart;
      try {
        from = tariffOn(company, {
          group: settings.group,
          name: settings.tariffName,
          date: oslo(this.now()).date,
        }).from;
      } catch {
        // no tariff today: reported by the pricing
      }
      if (from < yearStart) {
        out.push(text('stale', { company: company.name, date: company.updated }));
      }
    }
    seen.add(slug);
    const county = this.catalog.nve[slug]?.county;
    if (county && NORTHERN_COUNTIES.includes(county) === (settings.zone === 'south')) {
      out.push(text('zoneMismatch', { company: company.name, zone: settings.zone }));
    }
    return out;
  }

  async updateStatus() {
    if (this.stopped) return;
    const count = this.contracts.size;
    const parts = [
      count === 0
        ? text('noContract', { date: this.dataDate() })
        : text('ready', { count, date: this.dataDate() }),
    ];
    const problem = [...this.problems.values()][0];
    if (problem) parts.push(text('problem', { problem }));
    for (const warning of this.warnings().slice(0, 2)) parts.push(warning);
    if (this.spotAreas().length > 0) parts.push(text('spotCredit'));
    for (const service of Object.keys(this.state.pauses)) {
      const pause = this.pauseOf(service);
      if (pause) {
        const time = new Date(pause.until).toISOString().slice(11, 16);
        parts.push(
          text('paused', { service: SERVICES[service], status: pause.status, time: `${time} UTC` }),
        );
      }
    }
    if (this.unreadable) parts.push(text('storage'));
    if (this.contractsUnread) parts.push(text('contractsUnread'));
    await this.setStatus(true, join(...parts));
  }

  async setStatus(connected, message) {
    const key = `${connected}|${message.en}`;
    if (key === this.lastStatus) return;
    this.lastStatus = key;
    try {
      await this.gladys.setConnectionStatus(connected, message);
    } catch (err) {
      this.lastStatus = undefined;
      this.log.warn(`Status not sent (${err?.name ?? 'Error'})`);
    }
  }

  // --- Test button ---------------------------------------------------------------------

  async testConnection() {
    const date = this.dataDate();
    if (this.contracts.size === 0) {
      return text('testNone', { date, count: this.catalog.slugs.length });
    }
    const lines = [];
    for (const { id, inputs } of [...this.contracts.values()].slice(0, TEST_CONTRACTS)) {
      lines.push(await this.testContract(id, inputs));
    }
    return {
      en: lines.map((l) => l.en).join('\n'),
      fr: lines.map((l) => l.fr).join('\n'),
    };
  }

  async testContract(id, inputs) {
    let resolved;
    try {
      resolved = this.resolve(inputs);
    } catch (err) {
      return text('testError', { id: id.slice(0, 8), problem: problemOf(err) });
    }
    const { settings, slug, company } = resolved;
    const now = this.now();
    const local = oslo(now);
    let tariff;
    try {
      tariff = tariffOn(company, {
        group: settings.group,
        name: settings.tariffName,
        date: local.date,
      });
    } catch (err) {
      return text('testError', { id: id.slice(0, 8), problem: problemOf(err) });
    }
    let price;
    try {
      price = currentPrice(
        now,
        monthKwh(this.capacity.get(id) ?? emptyRecord(), local.month),
        settings,
        this.context(company),
      ).price.toFixed(4);
    } catch (err) {
      price = `? (${problemOf(err)})`;
    }
    const parts = [
      text('testContract', {
        company: company.name,
        date: company.updated,
        ore: energyPrice(tariff, local).ore,
        price,
      }),
    ];
    const capacity = this.capacityOf(id, settings, company);
    if (Number.isFinite(capacity?.kw)) {
      parts.push(
        text('testCapacity', {
          kw: capacity.kw,
          fee: Number.isFinite(capacity.monthlyWithVat) ? capacity.monthlyWithVat.toFixed(2) : '?',
        }),
      );
    } else if (!COMPUTED_METHODS.includes(capacity?.method)) {
      parts.push(text('testNoCapacity', { method: capacity?.method ?? '?' }));
    }
    parts.push(await this.compareWithNve(slug, settings.group, tariff, local.date));
    parts.push(...this.warningsFor(resolved));
    return join(...parts);
  }

  /** fri-nettleie against NVE for today (one request per company and hour at most). */
  async compareWithNve(slug, group, tariff, date) {
    const ref = this.catalog.nve[slug];
    if (!ref) return text('testNveNone', { reason: 'company not in the NVE list' });
    const key = `${slug}|${group}|${date}`;
    const cached = this.nveCache.get(key);
    let nve;
    if (cached && this.monotonic() - cached.at < HOUR) {
      nve = cached.nve;
    } else {
      try {
        const answer = await this.request(
          'nve',
          nveUrl({ date, group, county: ref.county, org: ref.org }),
          { json: true, maxBytes: 1024 * 1024 },
        );
        nve = parseNveDay(answer.data);
      } catch (err) {
        return text('testNveNone', { reason: err?.message ?? 'error' });
      }
      this.nveCache.set(key, { nve, at: this.monotonic() });
    }
    if (!nve) return text('testNveNone', { reason: 'no data for that day' });
    const energy = {};
    const enova = this.catalog.rates()?.enova ?? 0;
    const start = osloMidnight(date);
    for (let t = start; oslo(t).date === date; t += HOUR) {
      const local = oslo(t);
      // NVE's energileddEks holds the Enova levy (without VAT and consumption
      // tax); fri-nettleie leaves it out: added here so equal tariffs compare equal.
      energy[local.h] = Math.round((energyPrice(tariff, local).ore + enova) * 1e6) / 1e6;
    }
    const ours = {
      energy,
      steps: tariff.capacity.steps.map((s) => ({ from: s.from, monthly: s.yearly / 12 })),
    };
    const result = compareDay(ours, nve);
    if (result.same) return text('testNveSame');
    const detail = [
      ...result.energyDiffs.slice(0, 2).map((d) => `${d.hour}h: ${d.ours} / ${d.nve} øre`),
      ...result.stepDiffs
        .slice(0, 2)
        .map((d) => `${d.from} kW: ${d.ours.toFixed(2)} / ${d.nve ?? '-'} NOK`),
    ].join(', ');
    return text('testNveDiff', { detail });
  }
}
