# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for
human contributors.

## What this is

A Gladys Assistant **external integration** of type `device` (Node.js 22+,
ESM, no build step, sandboxed Docker container, `@gladysassistant/integration-sdk`
0.16). It offers one delegated **energy contract** template, "nettleie-no":
the Norwegian grid tariff of the user's grid company (fri-nettleie data, CC BY
4.0) with the taxes, optionally the spot price with the strømstøtte or
Norgespris. A device per contract shows the price now and the capacity step.
Unofficial. Read-only: nothing is ever commanded.

## Commands

```bash
npm install
npm test                                  # node --test (or gi test)
npm run lint && npm run format:check
node scripts/snapshot.mjs <fri-nettleie clone> <NVE list .json>
memcap node scripts/mutants.mjs           # mutation check, one mutant at a time
```

## Architecture

```
index.js              SDK wiring only (src/handlers.js)
src/app.js            NettleieApp: lifecycle, contracts, delegated pricing,
                      capacity, spot reads, daily refresh, status, Test
src/tariffs.js        the fri-nettleie format: checks, tariff of a date,
                      energy price at a local hour, capacity step (pure)
src/pricing.js        the cost of the 30-minute intervals, current price (pure)
src/rates.js          taxes by zone and date, strømstøtte, Norgespris (pure)
src/capacity.js       hourly peaks from the priced intervals (pure)
src/catalog.js        snapshot + files read again; company from an input
src/contract.js       template key and inputs (pure)
src/time.js           Europe/Oslo local time (pure); src/holidays.js
src/spot.js           Nord Pool day-ahead parser and cache (pure)
src/nve.js            NVE tariff API, Test button comparison (pure)
src/http.js           the only network access (User-Agent, bounds, deadline)
src/store.js          /data files (state, spot, capacity)
src/snapshot/         fri-nettleie snapshot (scripts/snapshot.mjs)
```

## Rules

- **Never guess a price.** An unknown tariff, tax rate, scheme date or spot
  price throws: the core gives the interval no cost and asks again. Never a
  zero, never the last rate carried on.
- **The capacity step is not a kWh price.** The core engine cannot bill steps
  (its `demand` is per kW) and a delegated cost is the energy only: the step
  is shown (device, Test), never added to the interval costs.
- **Keys are forever**: template key `nettleie-no`, its input keys and option
  values, feature keys, the config key.
- **Sources**: one request at a time per service, REQUEST_GAP apart, 429/5xx
  pause kept in /data; fri-nettleie at most once a day (due time in /data);
  the current price never makes a request (5 s budget).
- **Attribution**: fri-nettleie CC BY 4.0 (docs, notices, status data date),
  NVE NLOD. Update both docs tables when the snapshot changes.
- **Rates to update every year**: `SUPPORT.thresholdByYear` and `NORGESPRIS`
  in `src/rates.js` (the taxes come from fri-nettleie's `satser.yml`).
- Bilingual texts (en/fr), CHANGELOG `[Unreleased]`, versions by the Release
  workflow only.
