# TODO

## Before announcing

- [ ] Review r1 (xhigh: energy).
- [ ] Turn on "Private vulnerability reporting" (SECURITY.md points there).
- [ ] Add the `gladys-assistant-integration` topic at publication only.
- [ ] Store fields not set in the manifest (validator rules): `keywords`
      (nettleie, kapasitetsledd, strømstøtte, Norgespris, Norway, grid
      tariff) and `countries` (NO).

## To watch

- [ ] Not tested with a real Gladys contract nor a real Norwegian meter: the
      costs are checked against the published tariffs (Elvia) by the tests.
- [ ] Every January: the strømstøtte threshold of the new year and the end of
      Norgespris (extended or not) in `src/rates.js`; until then the
      contracts using them get no cost (on purpose). The consumption tax comes
      from fri-nettleie's `satser.yml` (read again daily).
- [ ] The capacity step in Gladys: if the core engine gets a stepped
      `demand` (price per step, not per kW), move the step into the template
      and drop the manual "capacity_fee" input. Spec today: `demand` is
      price × kW with `max` or `top3_average`.
- [ ] Strømstøtte per hour on the mean of the quarters: check against a real
      bill (the scheme may move to quarters with the 15-minute settlement).
- [ ] fri-nettleie format changes ("the format is not stable" says the
      project): a file the checks refuse keeps the previous data and is
      logged.
- [ ] NVE differs from fri-nettleie for Elvia on 2026-11-11 (NVE 13.99 /
      21.99 øre, fri-nettleie 16.99 / 28.99 since 2026-07-01): NVE is behind;
      the Test button shows it.

## Decisions

- Version 0.1.0 set by hand (package.json, lock, manifest, docker_image).
- `gladys_version: ">=5.2.0"`: `energy_contracts` (5.2.0), not 5.1.0.
- One delegated template (limit 20): the company is an input (77 companies
  in the snapshot, more than the 64 options a select can hold).
- The capacity step is shown, not billed: the engine cannot express steps
  (checked in `server/lib/energy-contract/tariff.demand.js`: price × kW), a
  delegated cost is the energy only and must be the same on a retry (the step
  is only known at the end of the month). Optional fixed input instead.
- The peak is computed from the kWh Gladys sends for pricing (hourly energy,
  as the companies bill), not from `max_power_kw` (instantaneous).
- Spot prices from the Nord Pool data portal (same reading as
  gladys-nord-pool), only for contracts with spot or Norgespris; kept 62 days.
- NVE only for the Test button comparison (it lags behind the companies).
- A negative total counts as zero (the core takes no credit).
