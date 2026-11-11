// -----------------------------------------------------------------------------
// The contract template of the manifest (`energy_contracts`, delegated mode)
// and the reading of its inputs. The keys are forever: contracts store them.
// Pure.
// -----------------------------------------------------------------------------

export const TEMPLATE_KEY = 'nettleie-no';

export const GROUP_OPTIONS = { household: 'husholdning', holiday_home: 'fritid' };
export const SUPPLY_OPTIONS = ['grid_only', 'spot', 'norgespris'];
export const ZONE_OPTIONS = ['south', 'north', 'tiltakssone'];
export const AREA_OPTIONS = ['NO1', 'NO2', 'NO3', 'NO4', 'NO5'];
export const MAX_MARKUP = 5;

export class InputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InputError';
    this.code = 'bad_input';
  }
}

const text = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
/** Whether a text holds a control character (C0 or DEL). */
export const hasControl = (s) =>
  [...s].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127);
const has = (v) => v !== undefined && v !== null && v !== '';

/**
 * The inputs of a contract -> `{ company, tariffName, group, zone, supply,
 * area, markup }`. Throws an InputError naming the first wrong input (a
 * wrong input is never replaced by a default: the price would be wrong).
 */
export function readInputs(inputs = {}) {
  const raw = inputs && typeof inputs === 'object' ? inputs : {};
  const company = text(raw.grid_company, 120);
  if (!company || hasControl(company)) {
    throw new InputError('grid_company is empty');
  }
  const groupKey = has(raw.customer_group) ? String(raw.customer_group) : 'household';
  const group = Object.hasOwn(GROUP_OPTIONS, groupKey) ? GROUP_OPTIONS[groupKey] : undefined;
  if (!group) throw new InputError('customer_group is not a known option');
  const zone = has(raw.tax_zone) ? String(raw.tax_zone) : 'south';
  if (!ZONE_OPTIONS.includes(zone)) throw new InputError('tax_zone is not a known option');
  const supply = has(raw.supply) ? String(raw.supply) : 'grid_only';
  if (!SUPPLY_OPTIONS.includes(supply)) throw new InputError('supply is not a known option');
  const area = has(raw.price_area) ? String(raw.price_area) : 'NO1';
  if (!AREA_OPTIONS.includes(area)) throw new InputError('price_area is not a known option');
  let markup = 0;
  if (has(raw.supplier_markup)) {
    markup = typeof raw.supplier_markup === 'number' ? raw.supplier_markup : NaN;
    if (typeof raw.supplier_markup === 'string' && /^-?\d+(\.\d+)?$/.test(raw.supplier_markup)) {
      markup = Number(raw.supplier_markup);
    }
    if (!Number.isFinite(markup) || markup < -1 || markup > MAX_MARKUP) {
      throw new InputError('supplier_markup must be between -1 and 5 NOK/kWh');
    }
  }
  const tariffName = text(raw.tariff_name, 64);
  return { company, tariffName, group, zone, supply, area, markup };
}
