// -----------------------------------------------------------------------------
// The delegated pricing: the cost of each 30-minute interval of a contract.
//
//   grid      energiledd of the tariff in force (øre/kWh, local hour, day
//             type, month) + consumption tax + Enova levy;
//   supply    nothing ("grid_only"), the spot price of the area + the
//             supplier's markup minus the strømstøtte ("spot"), or the
//             Norgespris + the markup ("norgespris"), each within its
//             monthly cap of kWh, the spot price beyond;
//   VAT       on everything, in the "south" zone only.
//
// The spot price of a 30-minute interval is the mean of its two quarters
// (the meter data is half-hourly: consumption is taken as even inside it);
// the strømstøtte compares the mean of the clock HOUR (four quarters) to its
// threshold, hour by hour as the scheme says. The monthly caps count the kWh
// of the local month: `cumulative_before.month` from Gladys, then the
// intervals of the request in order; an interval crossing a cap is split.
//
// The capacity step is NOT here (see capacity.js): a delegated cost is the
// energy only. Any unknown (no tariff on that date, no tax rate for the
// year, no spot price) throws: the interval gets no cost and Gladys asks
// again at its next run, never a silent zero. A negative total (negative spot
// price) is counted as zero: Gladys takes no credit. Pure.
// -----------------------------------------------------------------------------

import { NORGESPRIS, SUPPORT, norgesprisOn, supportThreshold, taxesOn } from './rates.js';
import { energyPrice, tariffOn } from './tariffs.js';
import { HOUR, MINUTE, oslo, parseInstant } from './time.js';

const QUARTER = 15 * MINUTE;

export class SpotMissing extends Error {
  constructor(area, ms) {
    super(`no ${area} spot price for ${new Date(ms).toISOString()}`);
    this.name = 'SpotMissing';
    this.code = 'spot_missing';
    this.area = area;
    this.at = ms;
  }
}

/** The spot price (NOK/kWh without VAT) of a quarter, or throws SpotMissing. */
function spotAt(spot, area, ms) {
  const price = spot(area, ms);
  if (typeof price !== 'number' || !Number.isFinite(price)) throw new SpotMissing(area, ms);
  return price;
}

const spotOfInterval = (spot, area, start) =>
  (spotAt(spot, area, start) + spotAt(spot, area, start + QUARTER)) / 2;

function spotOfHour(spot, area, start) {
  const hour = Math.floor(start / HOUR) * HOUR;
  let sum = 0;
  for (let q = 0; q < 4; q += 1) sum += spotAt(spot, area, hour + q * QUARTER);
  return sum / 4;
}

/** The monthly cap of kWh of the supply scheme of a contract, or null (no cap). */
export function capOf(settings) {
  if (settings.supply === 'norgespris') return NORGESPRIS.capKwh[settings.group];
  if (settings.supply === 'spot' && settings.group === 'husholdning') return SUPPORT.capKwh;
  return null;
}

/**
 * The prices of an instant (NOK/kWh, VAT included): `{ grid, inCap, outCap,
 * vat, label, ore }` where `inCap` is the supply price of a kWh within the
 * monthly cap and `outCap` beyond it. `outCap` is computed only when asked
 * (it may need a spot price the inCap price does not).
 */
export function pricesAt(start, settings, { company, rates, spot }, { needOut = true } = {}) {
  const local = oslo(start);
  const tariff = tariffOn(company, {
    group: settings.group,
    name: settings.tariffName,
    date: local.date,
  });
  const energy = energyPrice(tariff, local);
  const { vat, taxOre } = taxesOn(rates, settings.zone, local.date);
  const factor = 1 + vat;
  const grid = ((energy.ore + taxOre) / 100) * factor;
  let inCap = 0;
  let outCap = 0;
  let label = 'Nettleie';
  if (settings.supply === 'spot') {
    const price = spotOfInterval(spot, settings.area, start);
    outCap = (price + settings.markup) * factor;
    inCap = outCap;
    if (settings.group === 'husholdning') {
      const threshold = supportThreshold(local.date);
      const hourly = spotOfHour(spot, settings.area, start);
      inCap -= SUPPORT.rate * Math.max(0, hourly - threshold) * factor;
    }
    label = 'Nettleie + spot';
  } else if (settings.supply === 'norgespris') {
    inCap = (norgesprisOn(local.date) + settings.markup) * factor;
    if (needOut) {
      outCap = (spotOfInterval(spot, settings.area, start) + settings.markup) * factor;
    }
    label = 'Nettleie + Norgespris';
  }
  return { grid, inCap, outCap, vat, label, ore: energy.ore, rule: energy.rule, tariff };
}

const round6 = (v) => Math.round(v * 1e6) / 1e6;

/**
 * The costs of the intervals of one request: one `{ starts_at, cost, label }`
 * per interval, in the request order. `monthBefore` = the kWh of the local
 * month before the first interval.
 */
export function priceIntervals(intervals, monthBefore, settings, context) {
  const cap = capOf(settings);
  if (cap !== null && !(Number.isFinite(monthBefore) && monthBefore >= 0)) {
    throw new Error('the kWh of the month before the request are unknown');
  }
  const parsed = intervals.map((interval, index) => {
    const start = parseInstant(interval?.starts_at);
    const kwh = interval?.kwh;
    if (start === undefined || typeof kwh !== 'number' || !Number.isFinite(kwh) || kwh < 0) {
      throw new Error(`interval ${index} is not readable`);
    }
    return { index, start, kwh, startsAt: interval.starts_at };
  });
  const order = [...parsed].sort((a, b) => a.start - b.start);
  const costs = new Array(parsed.length);
  let month = order.length > 0 ? oslo(order[0].start).month : null;
  let used = monthBefore;
  for (const item of order) {
    const local = oslo(item.start);
    if (local.month !== month) {
      // A new local month: its cap starts again from zero.
      month = local.month;
      used = 0;
    }
    let inKwh = item.kwh;
    let outKwh = 0;
    if (cap !== null) {
      inKwh = Math.min(item.kwh, Math.max(0, cap - used));
      outKwh = item.kwh - inKwh;
    }
    used += item.kwh;
    const p = pricesAt(item.start, settings, context, { needOut: outKwh > 0 });
    const total = item.kwh * p.grid + inKwh * p.inCap + outKwh * p.outCap;
    costs[item.index] = {
      starts_at: item.startsAt,
      cost: Math.max(0, round6(total)),
      label: p.label,
    };
  }
  return costs;
}

/**
 * The price of the next kWh at `nowMs` (VAT included) and its next change:
 * `{ price, valid_until, next_price, label }`; throws like the pricing.
 */
export function currentPrice(nowMs, monthUsed, settings, context) {
  const cap = capOf(settings);
  if (cap !== null && !(Number.isFinite(monthUsed) && monthUsed >= 0)) {
    throw new Error('the kWh of the month are unknown');
  }
  const within = cap === null || monthUsed < cap;
  const at = (ms) => {
    const p = pricesAt(Math.floor(ms / (30 * MINUTE)) * 30 * MINUTE, settings, context, {
      needOut: !within,
    });
    return { price: p.grid + (within ? p.inCap : p.outCap), label: p.label };
  };
  const slot = settings.supply === 'grid_only' ? HOUR : 30 * MINUTE;
  const now = at(nowMs);
  const until = Math.floor(nowMs / slot) * slot + slot;
  let next;
  try {
    next = at(until).price;
  } catch {
    next = null;
  }
  return {
    price: round6(now.price),
    valid_until: new Date(until).toISOString(),
    next_price: next === null ? null : round6(next),
    label: now.label,
  };
}
