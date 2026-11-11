# Third-party notices

This integration is licensed under the Apache License 2.0 (see `LICENSE`). It
contains no code taken from another project: the tariff model, the pricing
and the clients are written for it, from the public descriptions of the data.

## fri-nettleie data (CC BY 4.0)

The grid tariffs (`src/snapshot/fri-nettleie.json`, and the files the
integration reads again from GitHub) and the tax rates (`satser.yml`) come
from **fri-nettleie** (<https://github.com/kraftsystemet/fri-nettleie>), by
**Fri nettleie** (kraftsystemet), under the Creative Commons Attribution 4.0
International license (<https://creativecommons.org/licenses/by/4.0/>).
Snapshot: commit `58a0d20121a8ad196a1c0867bf7ac2535365e0d9` of 10 November
2026; the date of each company's data ("sist_oppdatert") is shown by the
integration.

Changes made to the data: the YAML files are converted to JSON and checked
field by field (a tariff that does not match the format is left out), the
companies are matched to the NVE list by name, the yearly capacity prices are
shown per month, and the consumption tax, the Enova levy and VAT are added to
the prices.

The code of fri-nettleie (MIT) was read to follow its reading of the format
(`scripts/prissignal.py`: the last matching exception wins, spans over
midnight, working days); none of it is copied.

## NVE tariff data (NLOD)

The Test button compares the tariffs with the API of the Norwegian Water
Resources and Energy Directorate (NVE,
<https://nettleietariffer.dataplattform.nve.no>), and the snapshot holds the
organisation numbers and counties of its list of grid companies. Contains
data under the Norwegian Licence for Open Government Data (NLOD) made
available by NVE (<https://data.norge.no/nlod/>).

## Spot prices: Hva koster strømmen.no

Strømpriser levert av Hva koster strømmen.no (<https://www.hvakosterstrommen.no>).
The spot prices (only for the "spot" and "norgespris" supplies) are read from
its open API (<https://www.hvakosterstrommen.no/strompris-api>), "fritt
tilgjengelig for hvem som helst, til hva som helst", which asks to be credited
as the source. The site publishes the ENTSO-E day-ahead prices converted to
NOK with the Norges Bank rate of the day. Changes made: none to the prices; a
half hour takes the price of its hour.

## References read, not copied

- Strømkalkulator (<https://github.com/fredrik-lindseth/Stromkalkulator>,
  MIT): read to check the rules of the strømstøtte (threshold by year, 90 %,
  5,000 kWh a month, no support for holiday homes) and of Norgespris (40 øre
  without VAT, 5,000 / 1,000 kWh a month), and the tax zones. No code taken.
- The regulation on strømstønad (FOR-2025-09-08-1791) and the government
  pages on Norgespris.

## npm dependencies

- `@gladysassistant/integration-sdk` (Apache-2.0).
- `yaml` (ISC), to read the fri-nettleie files.
