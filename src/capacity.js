// -----------------------------------------------------------------------------
// The capacity step ("kapasitetsledd", "effekttrinn") of a contract, from the
// consumption Gladys sends for pricing. The grid companies place a customer
// on a step from its hourly consumption (kWh in a clock hour, read as kW):
//   TRE_DØGNMAX_MND  the mean of the three highest hours on three different
//                    days of the month (the most common rule);
//   MND_MAX          the highest hour of the month.
// The other methods of fri-nettleie (FEM_VEKTET_ÅR over 12 months, OV_TREFASE
// by fuse size) cannot be computed from the meter: their step stays unknown.
//
// The Gladys rule engine cannot bill a step (its `demand` component is a price
// per kW, never a step) and a delegated cost is the energy only: the module
// therefore SHOWS the step (sensors, test button), it never adds it to the
// interval costs. Pure, except the record it keeps.
// -----------------------------------------------------------------------------

import { HOUR, MINUTE, oslo, osloMidnight, previousMonth } from './time.js';

const HALF_HOUR = 30 * MINUTE;

/** An empty record of one contract: kWh per 30-minute interval start (ms). */
export const emptyRecord = () => ({ intervals: {} });

/**
 * Adds priced intervals (`{ starts_at (ms), kwh }`) to a record, then keeps
 * only the current and the previous local month of `nowMs`. A repeated
 * interval replaces the old value (a recalculation sends corrected kWh).
 */
export function recordIntervals(record, intervals, nowMs) {
  const month = oslo(nowMs).month;
  const keepFrom = osloMidnight(`${previousMonth(month)}-01`);
  for (const { start, kwh } of intervals) {
    if (!Number.isFinite(start) || !Number.isFinite(kwh) || kwh < 0) continue;
    if (start < keepFrom || start > nowMs + HOUR) continue;
    record.intervals[start] = kwh;
  }
  for (const key of Object.keys(record.intervals)) {
    if (Number(key) < keepFrom) delete record.intervals[key];
  }
  return record;
}

/**
 * The hours of a local month: `[{ start, kwh, date, complete }]` (both
 * halves of a clock hour summed; `complete` when both are known).
 */
export function hoursOf(record, month) {
  const hours = new Map();
  for (const [key, kwh] of Object.entries(record.intervals)) {
    const start = Number(key);
    const local = oslo(start);
    if (local.month !== month) continue;
    const hour = Math.floor(start / HOUR) * HOUR;
    const entry = hours.get(hour) ?? { start: hour, kwh: 0, halves: 0, date: local.date };
    entry.kwh += kwh;
    entry.halves += start % HOUR === 0 || start % HOUR === HALF_HOUR ? 1 : 0;
    hours.set(hour, entry);
  }
  return [...hours.values()].map((h) => ({
    start: h.start,
    kwh: h.kwh,
    date: h.date,
    complete: h.halves >= 2,
  }));
}

/**
 * The peak of a local month by a method, in kW: `{ kw, days, hours, kwh }`
 * (`days` = the days it is the mean of, `kwh` = the month's total so far),
 * or null when the method is not computed or nothing is known yet.
 */
export function peakOf(record, month, method) {
  const hours = hoursOf(record, month);
  if (hours.length === 0) return null;
  const kwh = hours.reduce((sum, h) => sum + h.kwh, 0);
  if (method === 'MND_MAX') {
    const top = hours.reduce((a, b) => (b.kwh > a.kwh ? b : a));
    return { kw: round(top.kwh), days: [top.date], hours: hours.length, kwh: round(kwh) };
  }
  if (method !== 'TRE_DØGNMAX_MND') return null;
  const byDay = new Map();
  for (const h of hours) {
    if (!byDay.has(h.date) || byDay.get(h.date) < h.kwh) byDay.set(h.date, h.kwh);
  }
  const top = [...byDay.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
  const mean = top.reduce((sum, [, v]) => sum + v, 0) / top.length;
  return {
    kw: round(mean),
    days: top.map(([d]) => d),
    hours: hours.length,
    kwh: round(kwh),
  };
}

/** The kWh of a local month known so far. */
export function monthKwh(record, month) {
  return round(hoursOf(record, month).reduce((sum, h) => sum + h.kwh, 0));
}

const round = (v) => Math.round(v * 1000) / 1000;
