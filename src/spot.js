// -----------------------------------------------------------------------------
// Day-ahead spot prices of the Norwegian areas (NO1 to NO5) in NOK/kWh without
// VAT, hour by hour, from the open API of Hva koster strømmen.no
// (https://www.hvakosterstrommen.no/strompris-api, "fritt tilgjengelig for
// hvem som helst, til hva som helst"; credit: "Strømpriser levert av Hva koster
// strømmen.no"). It publishes the ENTSO-E day-ahead prices converted to NOK
// with the Norges Bank rate of the day, one static JSON file per area and
// local day, history from 1 December 2021. Hourly prices are what the bill,
// the strømstøtte and Norgespris use. Needed only by a contract whose supply
// is "spot" or "norgespris" (beyond its cap).
//
// A day is kept only whole: every hour (or quarter) from local midnight to the
// next one, 23, 24 or 25 hours. The days read are kept 62 days. Pure, except
// the cache object.
// -----------------------------------------------------------------------------

import { AREA_OPTIONS } from './contract.js';
import { HOUR, MINUTE, nextDate, oslo, osloMidnight, parseInstant } from './time.js';

export const SPOT_BASE = 'https://www.hvakosterstrommen.no/api/v1/prices/';
export const KEEP_DAYS = 62;
const MAX_SLOTS = 100;
const SLOT_LENGTHS = [15 * MINUTE, HOUR];

/** The URL of one local day of one area. */
export function spotUrl(date, area) {
  if (!AREA_OPTIONS.includes(area) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error('bad spot day');
  }
  return `${SPOT_BASE}${date.slice(0, 4)}/${date.slice(5, 7)}-${date.slice(8, 10)}_${area}.json`;
}

/**
 * The answer of one local day -> `[[start, end, price NOK/kWh]]` sorted, or
 * null when it is not exactly that whole day: every slot of one length (15
 * or 60 minutes), contiguous from the local midnight to the next one, a
 * finite NOK price on each.
 */
export function parseSpotDay(answer, date) {
  if (!Array.isArray(answer) || answer.length === 0 || answer.length > MAX_SLOTS) return null;
  const from = osloMidnight(date);
  const to = osloMidnight(nextDate(date));
  if (from === undefined || to === undefined) return null;
  const slots = [];
  for (const entry of answer) {
    const start = parseInstant(entry?.time_start);
    const end = parseInstant(entry?.time_end);
    const price = entry?.NOK_per_kWh;
    if (start === undefined || end === undefined) return null;
    if (typeof price !== 'number' || !Number.isFinite(price) || Math.abs(price) > 100) return null;
    slots.push([start, end, Math.round(price * 100_000) / 100_000]);
  }
  slots.sort((a, b) => a[0] - b[0]);
  const length = slots[0][1] - slots[0][0];
  if (!SLOT_LENGTHS.includes(length)) return null;
  let at = from;
  for (const [start, end] of slots) {
    if (start !== at || end - start !== length) return null;
    at = end;
  }
  return at === to ? slots : null;
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
      const slots = parseSpotDay(
        day.slots.map((s) =>
          Array.isArray(s)
            ? {
                time_start: new Date(s[0]).toISOString(),
                time_end: new Date(s[1]).toISOString(),
                NOK_per_kWh: s[2],
              }
            : null,
        ),
        date,
      );
      if (slots) (out[area] ??= {})[date] = { slots, at: Number(day.at) || 0 };
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

/** The local days of a list of instants ("YYYY-MM-DD"), sorted, distinct. */
export const daysOf = (instants) => [...new Set(instants.map((ms) => oslo(ms).date))].sort();
