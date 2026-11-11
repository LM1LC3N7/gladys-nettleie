// -----------------------------------------------------------------------------
// The grid companies: the snapshot of fri-nettleie shipped in the image
// (src/snapshot/fri-nettleie.json, made by scripts/snapshot.mjs from one
// commit of the repository), overridden by the files read again from GitHub
// (src/app.js, once a day, only for the companies a contract uses). A file
// read again is used only when it passes the same checks; otherwise the
// previous one stays.
//
// A contract names its company by the fri-nettleie file name ("elvia",
// "tensio-tn"), a GLN (13 digits), an organisation number (9 digits, through
// the NVE list) or the company name ("Elvia AS", "elvia"). Pure, except the
// overrides it keeps.
// -----------------------------------------------------------------------------

import { readFileSync } from 'node:fs';
import { checkRates } from './rates.js';
import { checkCompany } from './tariffs.js';

export class CompanyError extends Error {
  constructor(message, suggestions = []) {
    super(message);
    this.name = 'CompanyError';
    this.code = 'unknown_company';
    this.suggestions = suggestions;
  }
}

/** "Elvia AS " -> "elvia"; "Høland og Setskog Elverk AS" -> "høland og setskog elverk". */
export function normalizeName(name) {
  return String(name)
    .toLowerCase()
    .normalize('NFC')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\b(as|sa|asa)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function loadSnapshot(url = new URL('./snapshot/fri-nettleie.json', import.meta.url)) {
  return JSON.parse(readFileSync(url, 'utf8'));
}

export class Catalog {
  constructor(snapshot) {
    this.source = snapshot.source;
    this.bundledRates = checkRates(snapshot.rates);
    this.paths = {};
    this.bundled = new Map();
    this.nve = snapshot.nve ?? {};
    for (const [slug, entry] of Object.entries(snapshot.companies ?? {})) {
      const { company } = checkCompany(entry.doc);
      if (!company) continue;
      this.bundled.set(slug, company);
      this.paths[slug] = entry.path;
    }
    /** slug -> { company, etag, at } read again from GitHub. */
    this.live = new Map();
    /** { rates, etag, at } read again from GitHub, or null. */
    this.liveRates = null;
  }

  get slugs() {
    return [...this.bundled.keys()].sort();
  }

  rates() {
    return this.liveRates?.rates ?? this.bundledRates;
  }

  company(slug) {
    return this.live.get(slug)?.company ?? this.bundled.get(slug) ?? null;
  }

  /** The data date of a company: its `sist_oppdatert` and where it was read. */
  dataOf(slug) {
    const live = this.live.get(slug);
    const company = this.company(slug);
    return company
      ? { updated: company.updated, read: live ? live.at : null, commit: this.source?.commit }
      : null;
  }

  /** The slug of a contract input; throws a CompanyError with suggestions. */
  resolve(query) {
    const raw = String(query ?? '').trim();
    if (!raw) throw new CompanyError('no grid company given');
    const lower = raw.toLowerCase();
    if (this.bundled.has(lower)) return lower;
    const digits = raw.replace(/\s+/g, '');
    if (/^7080\d{9}$/.test(digits)) {
      const found = this.slugs.filter((s) => this.company(s).gln.includes(digits));
      if (found.length === 1) return found[0];
    }
    if (/^\d{9}$/.test(digits)) {
      const found = this.slugs.filter((s) => this.nve[s]?.org === digits);
      if (found.length === 1) return found[0];
    }
    const wanted = normalizeName(raw);
    const exact = this.slugs.filter((s) => normalizeName(this.company(s).name) === wanted);
    if (exact.length === 1) return exact[0];
    const near = this.slugs.filter(
      (s) => wanted && (normalizeName(this.company(s).name).includes(wanted) || s.includes(lower)),
    );
    if (near.length === 1 && exact.length === 0) return near[0];
    throw new CompanyError(
      `grid company "${raw.slice(0, 60)}" not found`,
      (exact.length > 1 ? exact : near).slice(0, 6),
    );
  }

  /** Keeps a company read again (already checked); the bundled one stays the fallback. */
  setLive(slug, company, etag, at) {
    this.live.set(slug, { company, etag, at });
  }

  setLiveRates(rates, etag, at) {
    this.liveRates = { rates, etag, at };
  }
}
