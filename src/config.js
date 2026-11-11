// -----------------------------------------------------------------------------
// The integration configuration (manifest `config_schema`): one switch. The
// contracts carry everything else (company, group, zone, supply). Pure.
// -----------------------------------------------------------------------------

export const DEFAULT_CONFIG = {
  // Read the tariffs of the companies used again from fri-nettleie once a day.
  refresh_data: true,
};

export function normalizeConfig(raw = {}) {
  const value = raw?.refresh_data;
  return {
    refresh_data: !(value === false || value === 'false' || value === 0 || value === '0'),
  };
}
