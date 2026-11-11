// -----------------------------------------------------------------------------
// Day-ahead spot prices of the Norwegian areas (NO1 to NO5), in NOK, from the
// public data portal of Nord Pool (https://data.nordpoolgroup.com, no key, 15-
// minute slots, about six weeks of history; the same reading as the
// gladys-nord-pool integration of the same author). Needed only by a contract
// whose supply is "spot" or "norgespris" (beyond its cap). Unofficial: not
// affiliated with Nord Pool.
//
// The prices are kept per area and market day (the CET date, which is also
// Norway's) for 62 days, so a recalculation of the last month is priced from
// what was read, never re-fetched. Pure, except the cache object.
// -----------------------------------------------------------------------------

import { AREA_OPTIONS } from './contract.js';

export const SPOT_URL = 'https://dataportal-api.nordpoolgroup.com/api/DayAheadPrices';
export const KEEP_DAYS = 62;

/** The URL of one market day of the given areas, in NOK. */
export function spotUrl(date, areas) {
  const url = new URL(SPOT_URL);
  url.search = new URLSearchParams({
    date,
    market: 'DayAhead',
    deliveryArea: areas.join(','),
    currency: 'NOK',
  }).toString();
  return url.toString();
}

const MAX_SLOTS = 200;

/**
 * A DayAheadPrices answer -> `{ [area]: [[start, end, price NOK/kWh]] }` for
 * the Norwegian areas asked (slots sorted, 15 or 60 minutes long). Entries
 * that are not numbers are left out; an area without any slot is absent.
 */
export function parseSpotDay(answer, areas) {
  const out = {};
  const entries = Array.isArray(answer?.multiAreaEntries) ? answer.multiAreaEntries : [];
  if (answer && answer.currency !== undefined && answer.currency !== 'NOK') return out;
  for (const entry of entries.slice(0, MAX_SLOTS)) {
    const start = Date.parse(entry?.deliveryStart ?? '');
    const end = Date.parse(entry?.deliveryEnd ?? '');
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    if (end - start > 60 * 60_000) continue;
    for (const area of areas) {
      const perMwh = entry?.entryPerArea?.[area];
      if (typeof perMwh !== 'number' || !Number.isFinite(perMwh)) continue;
      if (Math.abs(perMwh) > 100_000) continue;
      // Two decimals per MWh become five per kWh: round the float noise away.
      (out[area] ??= []).push([start, end, Math.round(perMwh * 100) / 100_000]);
    }
  }
  for (const slots of Object.values(out)) slots.sort((a, b) => a[0] - b[0]);
  return out;
}

/** The spot cache: `{ [area]: { [date]: { slots, at } } }`, checked when read from /data. */
export function checkSpotCache(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const area of AREA_OPTIONS) {
    const days = raw[area];
    if (!days || typeof days !== 'object') continue;
    for (const [date, day] of Object.entries(days)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Array.isArray(day?.slots)) continue;
      const slots = day.slots.filter(
        (s) =>
          Array.isArray(s) &&
          s.length === 3 &&
          s.every((v) => typeof v === 'number' && Number.isFinite(v)) &&
          s[1] > s[0],
      );
      if (slots.length > 0 && slots.length <= MAX_SLOTS) {
        (out[area] ??= {})[date] = { slots, at: Number(day.at) || 0 };
      }
    }
  }
  return out;
}

/** The price of the slot holding `ms` in a cached day, or undefined. */
export function priceIn(day, ms) {
  if (!day) return undefined;
  for (const [start, end, price] of day.slots) {
    if (start <= ms && ms < end) return price;
  }
  return undefined;
}

/** Drops the days older than KEEP_DAYS before `today` ("YYYY-MM-DD"). */
export function pruneSpot(cache, today) {
  const limit = new Date(Date.parse(`${today}T00:00:00Z`) - KEEP_DAYS * 86_400_000)
    .toISOString()
    .slice(0, 10);
  for (const days of Object.values(cache)) {
    for (const date of Object.keys(days)) if (date < limit) delete days[date];
  }
  return cache;
}
