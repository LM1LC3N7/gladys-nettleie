// -----------------------------------------------------------------------------
// The public holidays of Norway (helligdager and offentlige høytidsdager, Act
// of 26 June 1947 and Act of 24 April 1995): what the tariff word `virkedag`
// (a working day: neither weekend nor holiday) and `fridag` need. Easter by
// the Gregorian computus (Meeus / Jones / Butcher). Sundays are weekend days,
// not listed as holidays. Pure.
// -----------------------------------------------------------------------------

const pad = (v) => String(v).padStart(2, '0');

/** Easter Sunday of a year: [month, day]. */
export function easter(year) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return [month, day];
}

const cache = new Map();

/** The holidays of a year, as a Set of "YYYY-MM-DD". */
export function holidaysOf(year) {
  if (cache.has(year)) return cache.get(year);
  const [em, ed] = easter(year);
  const base = Date.UTC(year, em - 1, ed);
  const fromEaster = (days) => {
    const t = new Date(base + days * 86_400_000);
    return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
  };
  const set = new Set([
    `${year}-01-01`, // første nyttårsdag
    fromEaster(-3), // skjærtorsdag
    fromEaster(-2), // langfredag
    fromEaster(0), // første påskedag
    fromEaster(1), // andre påskedag
    `${year}-05-01`, // offentlig høytidsdag
    `${year}-05-17`, // grunnlovsdag
    fromEaster(39), // Kristi himmelfartsdag
    fromEaster(49), // første pinsedag
    fromEaster(50), // andre pinsedag
    `${year}-12-25`, // første juledag
    `${year}-12-26`, // andre juledag
  ]);
  cache.set(year, set);
  return set;
}

/** Whether "YYYY-MM-DD" is a public holiday of Norway. */
export function isHoliday(date) {
  const year = Number(String(date).slice(0, 4));
  return Number.isInteger(year) && holidaysOf(year).has(date);
}
