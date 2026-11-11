// -----------------------------------------------------------------------------
// The tariff model of fri-nettleie (https://github.com/kraftsystemet/fri-nettleie,
// data CC BY 4.0, format of tariff.cue and tariff-eksempel.yml): one document
// per grid company, a list of tariffs per period and customer group, each
// with an energy part (`energiledd`, øre/kWh without taxes, a base price and
// exceptions by hours, days and months) and a capacity part (`fastledd`, NOK
// per YEAR without taxes, by steps of the customer's peak power).
//
// Every document is checked field by field before use (it comes from the
// network): a tariff that does not match the format is dropped with a reason,
// never guessed, so its dates have no price rather than a wrong one. Pure.
// -----------------------------------------------------------------------------

import { hasControl } from './contract.js';
import { isHoliday } from './holidays.js';

export const GROUPS = ['husholdning', 'fritid'];
export const METHODS = ['TRE_DØGNMAX_MND', 'FEM_VEKTET_ÅR', 'OV_TREFASE', 'MND_MAX', 'UKJENT'];
/** The methods whose step the module can compute from hourly consumption. */
export const COMPUTED_METHODS = ['TRE_DØGNMAX_MND', 'MND_MAX'];
const KNOWN_GROUPS = new Set(['husholdning', 'fritid', 'liten_næring']);
const DAY_WORDS = new Set([
  'mandag',
  'tirsdag',
  'onsdag',
  'torsdag',
  'fredag',
  'lørdag',
  'søndag',
  'ukedag',
  'helg',
  'helligdager',
  'fridag',
  'virkedag',
  'alle',
]);
export const MONTHS = [
  'januar',
  'februar',
  'mars',
  'april',
  'mai',
  'juni',
  'juli',
  'august',
  'september',
  'oktober',
  'november',
  'desember',
];
const WEEKDAY_NAMES = ['mandag', 'tirsdag', 'onsdag', 'torsdag', 'fredag', 'lørdag', 'søndag'];
const DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const LIMITS = { tariffs: 200, exceptions: 32, steps: 64, text: 200, sources: 20 };

const isText = (v, max = LIMITS.text) =>
  typeof v === 'string' && v.length > 0 && v.length <= max && !hasControl(v);
const isNumber = (v, min, max) =>
  typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
const isDate = (v) => typeof v === 'string' && DATE.test(v) && !Number.isNaN(Date.parse(v));

class FormatError extends Error {}
const fail = (message) => {
  throw new FormatError(message);
};

/** "6-21", "22-5", "7", "6-9,16-21" -> the list of local hours (an upper bound is included). */
export function parseHours(value) {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 23) {
    return [value];
  }
  if (!isText(value, 64)) fail('timer');
  const hours = new Set();
  for (const part of value.split(',')) {
    const match = /^\s*(\d{1,2})\s*(?:-\s*(\d{1,2})\s*)?$/.exec(part);
    if (!match) fail(`timer "${value}"`);
    const start = Number(match[1]);
    const end = match[2] === undefined ? start : Number(match[2]);
    if (start > 23 || end > 23) fail(`timer "${value}"`);
    // A span over midnight ("22-5") is written as such in 12 files.
    for (let h = start; ; h = (h + 1) % 24) {
      hours.add(h);
      if (h === end) break;
    }
  }
  return [...hours].sort((a, b) => a - b);
}

function checkException(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('unntak');
  if (!isNumber(raw.pris, -1000, 1000)) fail('unntak.pris');
  const out = { name: isText(raw.navn, 64) ? raw.navn : '', price: raw.pris };
  if (raw.timer !== undefined && raw.timer !== null) out.hours = parseHours(raw.timer);
  if (raw.dager !== undefined && raw.dager !== null) {
    if (!Array.isArray(raw.dager) || raw.dager.length > 13) fail('dager');
    for (const day of raw.dager) if (!DAY_WORDS.has(day)) fail(`dager "${String(day)}"`);
    if (raw.dager.length > 0) out.days = [...raw.dager];
  }
  const months = raw['måneder'];
  if (months !== undefined && months !== null) {
    if (!Array.isArray(months) || months.length > 12) fail('måneder');
    for (const m of months) if (!MONTHS.includes(m) && m !== 'alle') fail(`måneder "${m}"`);
    if (months.length > 0 && !months.includes('alle')) out.months = [...months];
  }
  return out;
}

function checkCapacity(raw) {
  if (!raw || typeof raw !== 'object') fail('fastledd');
  if (!METHODS.includes(raw.metode)) fail(`fastledd.metode "${String(raw.metode)}"`);
  const included = raw.terskel_inkludert;
  if (included !== true && included !== false && included !== null) fail('terskel_inkludert');
  if (!Array.isArray(raw.terskler) || raw.terskler.length === 0) fail('terskler');
  if (raw.terskler.length > LIMITS.steps) fail('terskler');
  const steps = raw.terskler.map((s) => {
    if (!s || !isNumber(s.terskel ?? 0, 0, 100_000) || !isNumber(s.pris, 0, 10_000_000)) {
      fail('terskel');
    }
    return { from: s.terskel ?? 0, yearly: s.pris };
  });
  steps.sort((a, b) => a.from - b.from);
  for (let i = 1; i < steps.length; i += 1) {
    if (steps[i].from === steps[i - 1].from) fail('terskel twice');
  }
  return { method: raw.metode, included, steps };
}

function checkTariff(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('tariff');
  if (!Array.isArray(raw.kundegrupper) || raw.kundegrupper.length === 0) fail('kundegrupper');
  for (const g of raw.kundegrupper) if (!KNOWN_GROUPS.has(g)) fail(`kundegruppe "${String(g)}"`);
  if (!isDate(raw.gyldig_fra)) fail('gyldig_fra');
  if (raw.gyldig_til !== undefined && raw.gyldig_til !== null) {
    if (!isDate(raw.gyldig_til) || raw.gyldig_til <= raw.gyldig_fra) fail('gyldig_til');
  }
  if (raw.navn !== undefined && raw.navn !== null && !isText(raw.navn, 64)) fail('navn');
  const energy = raw.energiledd;
  if (!energy || !isNumber(energy.grunnpris, -1000, 1000)) fail('energiledd.grunnpris');
  if (energy.unntak !== undefined && energy.unntak !== null) {
    if (!Array.isArray(energy.unntak) || energy.unntak.length > LIMITS.exceptions) fail('unntak');
  }
  return {
    groups: raw.kundegrupper.filter((g) => GROUPS.includes(g)),
    from: raw.gyldig_fra,
    to: raw.gyldig_til ?? null,
    name: raw.navn ?? null,
    base: energy.grunnpris,
    exceptions: (energy.unntak ?? []).map(checkException),
    capacity: checkCapacity(raw.fastledd),
  };
}

/**
 * A company document (parsed YAML or JSON) -> `{ company, problems }`:
 * `company` = { name, gln, updated, sources, tariffs } or null when the
 * document itself is unusable; `problems` lists the tariffs dropped.
 */
export function checkCompany(raw) {
  const problems = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { company: null, problems: ['not a document'] };
  }
  if (!isText(raw.netteier)) return { company: null, problems: ['netteier'] };
  if (!isDate(raw.sist_oppdatert)) return { company: null, problems: ['sist_oppdatert'] };
  const gln = Array.isArray(raw.gln) ? raw.gln.filter((g) => /^7080\d{9}$/.test(String(g))) : [];
  if (!Array.isArray(raw.tariffer) || raw.tariffer.length > LIMITS.tariffs) {
    return { company: null, problems: ['tariffer'] };
  }
  const tariffs = [];
  raw.tariffer.forEach((t, i) => {
    try {
      const tariff = checkTariff(t);
      if (tariff.groups.length > 0) tariffs.push(tariff);
    } catch (err) {
      if (!(err instanceof FormatError)) throw err;
      problems.push(`tariff ${i + 1}: ${err.message}`);
    }
  });
  const sources = Array.isArray(raw.kilder)
    ? raw.kilder.filter((s) => isText(s, 500) && /^https?:\/\//.test(s)).slice(0, LIMITS.sources)
    : [];
  return {
    company: {
      name: raw.netteier.trim(),
      gln: gln.map(String),
      updated: raw.sist_oppdatert,
      sources,
      tariffs,
    },
    problems,
  };
}

export class TariffError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'TariffError';
    this.code = code;
    Object.assign(this, details);
  }
}

/**
 * The tariff of a company in force on a local date for a customer group
 * (and a tariff name when the company has several at once). Throws a
 * TariffError `no_tariff` or `ambiguous` (with the names to choose from).
 */
export function tariffOn(company, { group, name, date }) {
  const matching = company.tariffs.filter(
    (t) => t.groups.includes(group) && t.from <= date && (t.to === null || date < t.to),
  );
  const wanted = typeof name === 'string' && name.trim() ? name.trim().toLowerCase() : '';
  const chosen = wanted
    ? matching.filter((t) => (t.name ?? '').toLowerCase() === wanted)
    : matching;
  if (chosen.length === 1) return chosen[0];
  if (chosen.length === 0) {
    throw new TariffError(
      'no_tariff',
      `${company.name}: no ${group} tariff${wanted ? ` "${name.trim()}"` : ''} on ${date}`,
      { names: [...new Set(matching.map((t) => t.name).filter(Boolean))] },
    );
  }
  throw new TariffError('ambiguous', `${company.name}: several ${group} tariffs on ${date}`, {
    names: [...new Set(chosen.map((t) => t.name ?? '?'))],
  });
}

function matchesDays(days, local) {
  if (!days) return true;
  const weekend = local.weekday >= 6;
  const holiday = isHoliday(local.date);
  for (const day of days) {
    if (day === 'alle') return true;
    if (day === WEEKDAY_NAMES[local.weekday - 1]) return true;
    if (day === 'ukedag' && !weekend) return true;
    if (day === 'helg' && weekend) return true;
    if (day === 'helligdager' && holiday) return true;
    if (day === 'fridag' && (weekend || holiday)) return true;
    if (day === 'virkedag' && !weekend && !holiday) return true;
  }
  return false;
}

/**
 * The energy price of a tariff at a local time (`oslo()` parts), in øre/kWh
 * without taxes, and the name of the rule that gave it. The exceptions are
 * read in order and the last one matching wins (fri-nettleie's prissignal).
 */
export function energyPrice(tariff, local) {
  let price = tariff.base;
  let rule = null;
  for (const ex of tariff.exceptions) {
    if (ex.hours && !ex.hours.includes(local.h)) continue;
    if (ex.months && !ex.months.includes(MONTHS[local.mo - 1])) continue;
    if (!matchesDays(ex.days, local)) continue;
    price = ex.price;
    rule = ex.name || null;
  }
  return { ore: price, rule };
}

/**
 * The capacity step of a peak (kW) under a tariff: `{ index, from, next,
 * monthly }` (`monthly` = NOK per month without taxes, the yearly price / 12;
 * `next` = the threshold of the next step or null). Null when the peak or the
 * threshold rule is unknown (a peak exactly on a threshold whose side is not
 * known).
 */
export function capacityStep(capacity, kw) {
  if (!Number.isFinite(kw) || kw < 0) return null;
  const { steps, included } = capacity;
  let index = 0;
  for (let i = 1; i < steps.length; i += 1) {
    const from = steps[i].from;
    if (kw > from || (kw === from && included === true)) index = i;
    else if (kw === from && included === null) return null;
  }
  return {
    index,
    from: steps[index].from,
    next: index + 1 < steps.length ? steps[index + 1].from : null,
    monthly: steps[index].yearly / 12,
  };
}
