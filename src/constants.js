// -----------------------------------------------------------------------------
// Constants: identity, sources, schedule, limits.
// -----------------------------------------------------------------------------

import { readFileSync } from 'node:fs';

export const VERSION = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).version;

// The integration's own User-Agent, on every request (never a browser's).
export const USER_AGENT = `gladys-nettleie/${VERSION} (+https://github.com/LM1LC3N7/gladys-nettleie)`;

// fri-nettleie, read again once a day: the files of the companies the
// contracts use and the tax rates, by conditional GET (ETag).
export const RAW_BASE = 'https://raw.githubusercontent.com/kraftsystemet/fri-nettleie/main/';
export const RATES_PATH = 'docs/llm-v2-innsamling-skill/skills/samle-tariff/references/satser.yml';

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;

export const REFRESH_INTERVAL = 24 * HOUR;
// After a failed refresh (network, 404, file refused by the checks).
export const REFRESH_RETRY = HOUR;
// After a 429 or a 5xx: Retry-After when given, else this, doubled up to the max.
export const PAUSE_MIN = HOUR;
export const PAUSE_MAX = 6 * HOUR;
// Requests to one service one after the other, this far apart.
export const REQUEST_GAP = SECOND;

// The device states (price now, capacity) every quarter of an hour.
export const TICK = 15 * MINUTE;
// The contracts listed again from Gladys every hour (and at each Discovery).
export const CONTRACTS_INTERVAL = HOUR;
// getConfig() or getEnergyContracts() that failed: retried, doubling.
export const RETRY_MIN = 10 * SECOND;
export const RETRY_MAX = 10 * MINUTE;
// /data unreadable: read again on its own timer.
export const STORE_RETRY = 10 * SECOND;
// A read of /data waited for at most this long by the start.
export const STORE_WAIT = 5 * SECOND;

// Spot prices: tomorrow's from 13:00 in Norway; a day that failed is asked
// again after SPOT_RETRY; a pricing request fetches at most SPOT_FETCHES days
// within SPOT_BUDGET (Gladys waits 30 s), the rest at its next run.
export const SPOT_TOMORROW_HOUR = 13;
export const SPOT_RETRY = 15 * MINUTE;
export const SPOT_FETCHES = 6;
export const SPOT_BUDGET = 18 * SECOND;

// Test button: NVE compared for at most this many contracts.
export const TEST_CONTRACTS = 3;

export const ACTIONS = { TEST: 'test' };
