# gladys-nettleie

Unofficial [Gladys Assistant](https://gladysassistant.com) integration: the
**Norwegian grid tariffs** (nettleie) of every grid company as a delegated
**energy contract**: energy part by local hour, day type and month,
consumption tax, Enova levy and VAT by zone, and optionally the spot price
with the **strømstøtte**, or **Norgespris**. A device per contract shows the
**capacity step** (kapasitetsledd) reached this month. Never tested with a
real Gladys contract: see the documentation.

- Documentation: [English](docs/en.md), [français](docs/fr.md).
- Data: [fri-nettleie](https://github.com/kraftsystemet/fri-nettleie) by Fri
  nettleie (kraftsystemet), CC BY 4.0; NVE tariff API (NLOD) for the
  comparison of the Test button; spot prices: Strømpriser levert av Hva koster
  strømmen.no. See
  [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
- Requires Gladys 5.2.0 or later (energy contracts).

## Development

```bash
npm install
npm test            # node --test
npm run lint
npm run format:check
node scripts/snapshot.mjs <fri-nettleie clone> <NVE list .json>   # new data snapshot
node scripts/mutants.mjs                                          # mutation check (memcap)
```

The release (version, image, GitHub Release) is made by the Release workflow
of the template. Licensed under the Apache License 2.0.
