// -----------------------------------------------------------------------------
// The public charges on the grid bill and the two state schemes, by date.
//
// Taxes: the rates file of fri-nettleie (`satser.yml`: VAT, consumption tax
// "forbruksavgift" by start date, Enova levy), bundled and refreshed with the
// tariffs. A rate is only used for a year the file covers (the year it was
// last verified, or the year of its latest rate): a later year is unknown,
// never the last rate carried on.
//
// Tax zones (a choice of the contract, from the area of the grid company):
//   south       consumption tax and 25 % VAT (south of Nordland);
//   north       consumption tax, no VAT (Nordland, the rest of Troms);
//   tiltakssone neither (Finnmark and the Nord-Troms municipalities).
// The Enova levy (1 øre/kWh for households) applies everywhere.
//
// Strømstøtte (Forskrift om strømstønad, FOR-2025-09-08-1791 § 5): 90 % of
// the hourly spot price above a threshold (75 øre/kWh without VAT in 2025,
// 77 in 2026), at most 5,000 kWh per month and metering point, households
// only (not holiday homes). Norgespris (FOR-2025-09-08-1790, from 1 October
// 2025 to 31 December 2029): 40 øre/kWh without VAT, a price set only up to
// 31 December 2026, at most 5,000 kWh per month for a home
// and 1,000 for a holiday home; beyond, the spot price. Outside the dates
// below, the scheme is unknown: no price is invented. Pure.
// -----------------------------------------------------------------------------

export const ZONES = ['south', 'north', 'tiltakssone'];

export const SUPPORT = {
  rate: 0.9,
  capKwh: 5000,
  // Threshold in NOK/kWh without VAT, by year: a year not listed is unknown.
  thresholdByYear: { 2025: 0.75, 2026: 0.77 },
};

export const NORGESPRIS = {
  from: '2025-10-01',
  until: '2026-12-31',
  price: 0.4,
  capKwh: { husholdning: 5000, fritid: 1000 },
};

export class RateError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RateError';
    this.code = 'rates_unknown';
  }
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const isRate = (v, max) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= max;

/** The rates file (parsed YAML or JSON) -> the checked rates, or null. */
export function checkRates(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const vat = raw.mva?.sats;
  const enova = raw.enova?.husholdning_ore_per_kwh;
  const list = raw.forbruksavgift?.satser;
  const verified = raw.sist_verifisert;
  if (!isRate(vat, 1) || !isRate(enova, 100) || !Array.isArray(list) || list.length === 0) {
    return null;
  }
  if (typeof verified !== 'string' || !DATE.test(verified) || list.length > 100) return null;
  const consumptionTax = [];
  for (const entry of list) {
    if (!entry || typeof entry.fra !== 'string' || !DATE.test(entry.fra)) return null;
    if (!isRate(entry.ore_per_kwh, 1000)) return null;
    consumptionTax.push({ from: entry.fra, ore: entry.ore_per_kwh });
  }
  consumptionTax.sort((a, b) => (a.from < b.from ? -1 : 1));
  const lastYear = Math.max(
    Number(verified.slice(0, 4)),
    Number(consumptionTax[consumptionTax.length - 1].from.slice(0, 4)),
  );
  return { vat, enova, consumptionTax, verified, coversUntil: `${lastYear}-12-31` };
}

/**
 * The taxes of a local date in a zone: `{ vat (fraction), taxOre (consumption
 * tax + Enova, øre/kWh without VAT) }`. Throws a RateError outside the years
 * the rates file covers.
 */
export function taxesOn(rates, zone, date) {
  if (!ZONES.includes(zone)) throw new RateError(`unknown tax zone "${zone}"`);
  if (!rates || date > rates.coversUntil || date < rates.consumptionTax[0].from) {
    throw new RateError(`no tax rates for ${date}`);
  }
  let consumption = 0;
  for (const entry of rates.consumptionTax) if (entry.from <= date) consumption = entry.ore;
  return {
    vat: zone === 'south' ? rates.vat : 0,
    // Rounded: 7.13 + 1 must stay 8.13 (øre with two decimals at most).
    taxOre: Math.round(((zone === 'tiltakssone' ? 0 : consumption) + rates.enova) * 1e6) / 1e6,
  };
}

/** The strømstøtte threshold (NOK/kWh without VAT) of a local date; throws when unknown. */
export function supportThreshold(date) {
  const threshold = SUPPORT.thresholdByYear[Number(date.slice(0, 4))];
  if (threshold === undefined) throw new RateError(`no strømstøtte threshold for ${date}`);
  return threshold;
}

/** Whether Norgespris exists on a local date; throws after its known end. */
export function norgesprisOn(date) {
  if (date < NORGESPRIS.from) {
    throw new RateError(`Norgespris did not exist on ${date}`);
  }
  if (date > NORGESPRIS.until) throw new RateError(`Norgespris unknown after ${NORGESPRIS.until}`);
  return NORGESPRIS.price;
}
