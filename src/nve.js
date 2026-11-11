// -----------------------------------------------------------------------------
// The tariff API of NVE (the Norwegian Water Resources and Energy Directorate,
// https://nettleietariffer.dataplattform.nve.no, open, no key): what the grid
// companies reported to the regulator, hour by hour for one day. Used only by
// the test button, to compare the fri-nettleie tariff of a contract with what
// NVE holds for the same day; the prices always come from fri-nettleie (NVE
// is updated when the companies report, sometimes months late). Pure.
// -----------------------------------------------------------------------------

export const NVE_URL =
  'https://nettleietariffer.dataplattform.nve.no/v1/NettleiePerOmradePrTimeHusholdningFritidEffekttariffer';

export const NVE_GROUPS = { husholdning: 'Husholdning', fritid: 'Hytter og fritidshus' };

export function nveUrl({ date, group, county, org }) {
  const url = new URL(NVE_URL);
  url.search = new URLSearchParams({
    ValgtDato: date,
    Tariffgruppe: NVE_GROUPS[group],
    FylkeNr: county,
    OrganisasjonsNr: org,
  }).toString();
  return url.toString();
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/**
 * The answer of one day -> `{ energy: { [hour]: øre }, steps: [{ from, monthly }] }`
 * (without taxes), or null when it holds nothing usable.
 */
export function parseNveDay(rows) {
  if (!Array.isArray(rows) || rows.length === 0 || rows.length > 2000) return null;
  const energy = {};
  const steps = new Map();
  for (const row of rows) {
    const hour = row?.time;
    const ore = num(row?.energileddEks);
    if (Number.isInteger(hour) && hour >= 0 && hour <= 23 && ore !== undefined) {
      energy[hour] = ore;
    }
    const from = num(row?.effekttrinnFraKw);
    const monthly = num(row?.fastleddEks);
    if (from !== undefined && monthly !== undefined) steps.set(from, monthly);
  }
  if (Object.keys(energy).length === 0) return null;
  return {
    energy,
    steps: [...steps.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([from, m]) => ({ from, monthly: m })),
  };
}

/**
 * Compares the fri-nettleie values of one day (`ours`: { energy: { [hour]: øre },
 * steps: [{ from, monthly }] }) with NVE's: `{ same, energyDiffs, stepDiffs }`
 * (a difference above 0.01 øre/kWh or 1 NOK per month counts).
 */
export function compareDay(ours, nve) {
  const energyDiffs = [];
  for (let h = 0; h < 24; h += 1) {
    if (ours.energy[h] === undefined || nve.energy[h] === undefined) continue;
    if (Math.abs(ours.energy[h] - nve.energy[h]) > 0.01) {
      energyDiffs.push({ hour: h, ours: ours.energy[h], nve: nve.energy[h] });
    }
  }
  const stepDiffs = [];
  for (const step of ours.steps) {
    const other = nve.steps.find((s) => s.from === step.from);
    if (!other) stepDiffs.push({ from: step.from, ours: step.monthly, nve: null });
    else if (Math.abs(other.monthly - step.monthly) > 1) {
      stepDiffs.push({ from: step.from, ours: step.monthly, nve: other.monthly });
    }
  }
  return { same: energyDiffs.length === 0 && stepDiffs.length === 0, energyDiffs, stepDiffs };
}
