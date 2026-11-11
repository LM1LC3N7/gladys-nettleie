# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

## [0.1.1] - 2026-11-11

### Added

- The "Nettleie (Norway)" contract template (delegated pricing): the energy
  part of the grid tariff of every Norwegian grid company (fri-nettleie data,
  CC BY 4.0) by local hour, day type and month, the consumption tax, the Enova
  levy and VAT by tax zone; optionally the spot price of the area with the
  strømstøtte, or Norgespris, within their monthly caps.
- One device per contract: price now, capacity peak of the month, capacity
  step reached and the threshold of the next one.
- The tariffs of the companies used and the tax rates read again from
  fri-nettleie once a day (conditional requests), the shipped copy as the
  fallback.
- A Test button: company, data date, price now, capacity of the month and a
  comparison with the NVE tariff API.

[Unreleased]: https://github.com/LM1LC3N7/gladys-nettleie/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/LM1LC3N7/gladys-nettleie/releases/tag/v0.1.1
