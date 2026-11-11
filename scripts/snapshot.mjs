// -----------------------------------------------------------------------------
// Builds src/snapshot/fri-nettleie.json, the data shipped in the image, from a
// local clone of https://github.com/kraftsystemet/fri-nettleie (data CC BY 4.0)
// and the list of grid companies of the NVE tariff API (organisation number
// and county, used by the test button to compare with NVE). Not part of the
// image, not run by the CI.
// Run: node scripts/snapshot.mjs <fri-nettleie clone> <NVE monthly list .json>
//   (the list: GET https://nettleietariffer.dataplattform.nve.no/v1/
//    NettleiePerOmradePrManedHusholdningFritidEffekttariffer?FraDato=<YYYY-MM-01>
//    &Tariffgruppe=Husholdning&Kundegruppe=2)
// -----------------------------------------------------------------------------

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { normalizeName } from '../src/catalog.js';
import { checkRates } from '../src/rates.js';
import { checkCompany } from '../src/tariffs.js';

const [clone, nveFile] = process.argv.slice(2);
if (!clone || !nveFile) {
  console.error('usage: node scripts/snapshot.mjs <fri-nettleie clone> <NVE list .json>');
  process.exit(2);
}
const git = (...args) => execFileSync('git', ['-C', clone, ...args], { encoding: 'utf8' }).trim();
const RATES = 'docs/llm-v2-innsamling-skill/skills/samle-tariff/references/satser.yml';

const companies = {};
for (const dir of ['tariffer', 'tariffer/old']) {
  for (const file of readdirSync(join(clone, dir)).sort()) {
    if (!file.endsWith('.yml')) continue;
    const slug = file.slice(0, -4);
    const doc = parse(readFileSync(join(clone, dir, file), 'utf8'));
    const { company, problems } = checkCompany(doc);
    if (!company) {
      console.log(`skipped ${dir}/${file}: ${problems.join(', ')}`);
      continue;
    }
    if (problems.length) console.log(`${dir}/${file}: dropped ${problems.join('; ')}`);
    if (companies[slug]) throw new Error(`two files named ${slug}`);
    companies[slug] = { path: `${dir}/${file}`, doc };
  }
}

const rates = parse(readFileSync(join(clone, RATES), 'utf8'));
if (!checkRates(rates)) throw new Error('satser.yml does not pass the checks');

// NVE names are upper case ("ELVIA AS"); a few differ from the fri-nettleie name.
const ALIASES = {
  tnett: 'TELEMARK NETT AS',
  meloy: 'MELØY ENERGI AS',
  'area-alle': 'AREA NETT AS',
  'area-lega': 'AREA NETT AS',
  'area-luostejok': 'AREA NETT AS',
  'area-nettinord': 'AREA NETT AS',
};
const strip = (n) => normalizeName(n).replace(/ nett$/, '');
const nveRows = JSON.parse(readFileSync(nveFile, 'utf8'));
const byName = new Map();
for (const row of nveRows) {
  // "ARVA AS*" is a second line of ARVA AS: the plain name is kept.
  if (!row.konsesjonar.endsWith('*') && !byName.has(row.konsesjonar)) {
    byName.set(row.konsesjonar, row);
  }
}
const nve = {};
for (const [slug, { doc }] of Object.entries(companies)) {
  let row = ALIASES[slug] ? byName.get(ALIASES[slug]) : undefined;
  if (!row) {
    const rows = [...byName.values()].filter(
      (r) =>
        normalizeName(r.konsesjonar) === normalizeName(doc.netteier) ||
        strip(r.konsesjonar) === strip(doc.netteier),
    );
    if (rows.length === 1) row = rows[0];
  }
  if (row) nve[slug] = { org: row.organisasjonsnr, county: row.fylkeNr, name: row.konsesjonar };
  else console.log(`no NVE match for ${slug} (${doc.netteier})`);
}

const out = {
  source: {
    repository: 'https://github.com/kraftsystemet/fri-nettleie',
    commit: git('rev-parse', 'HEAD'),
    committed: git('log', '-1', '--format=%cI'),
    license: 'CC-BY-4.0',
    nve_list: nveRows[0]?.datoId ?? null,
  },
  rates,
  companies,
  nve,
};
const target = fileURLToPath(new URL('../src/snapshot/fri-nettleie.json', import.meta.url));
writeFileSync(target, `${JSON.stringify(out)}\n`);
console.log(
  `${Object.keys(companies).length} companies, ${Object.keys(nve).length} matched to NVE`,
);
