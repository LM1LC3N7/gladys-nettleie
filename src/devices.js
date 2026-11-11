// -----------------------------------------------------------------------------
// One Gladys device per contract of the template (found in Discovery once the
// contract exists): the price now and the capacity step of the month. The
// external id is the contract id (a UUID given by Gladys); keys are forever.
// Pure.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES,
  DEVICE_FEATURE_TYPES,
  DEVICE_FEATURE_UNITS,
} from '@gladysassistant/integration-sdk';
import { TEXTS } from './i18n.js';

export const DEVICE_TYPE = 'contract';
export const FEATURE = {
  PRICE: 'price',
  CAPACITY: 'capacity',
  CAPACITY_FEE: 'capacity_fee',
  NEXT_STEP: 'next_step',
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether a contract id can name a device (a UUID, nothing else). */
export const validContractId = (id) => typeof id === 'string' && UUID.test(id);

export const idsOf = (gladys, contractId) => gladys.externalIds(DEVICE_TYPE, contractId);

export function buildDevice(gladys, { id, companyName }) {
  const ids = idsOf(gladys, id);
  const currency = (key) => ({
    name: TEXTS[key].en,
    category: DEVICE_FEATURE_CATEGORIES.CURRENCY,
    type: DEVICE_FEATURE_TYPES.CURRENCY.DECIMAL,
  });
  const power = (key) => ({
    name: TEXTS[key].en,
    category: DEVICE_FEATURE_CATEGORIES.ENERGY_SENSOR,
    type: DEVICE_FEATURE_TYPES.ENERGY_SENSOR.POWER,
    unit: DEVICE_FEATURE_UNITS.KILOWATT,
  });
  const features = [
    { key: FEATURE.PRICE, ...currency('featurePrice'), min: -10, max: 50 },
    { key: FEATURE.CAPACITY, ...power('featureCapacity'), min: 0, max: 10_000 },
    { key: FEATURE.CAPACITY_FEE, ...currency('featureCapacityFee'), min: 0, max: 1_000_000 },
    { key: FEATURE.NEXT_STEP, ...power('featureNextStep'), min: 0, max: 100_000 },
  ].map(({ key, ...f }) => ({
    ...f,
    external_id: ids.feature(key),
    read_only: true,
    has_feedback: false,
    keep_history: true,
  }));
  return {
    name: `Nettleie ${companyName}`.slice(0, 100),
    external_id: ids.device,
    params: [{ name: 'CONTRACT', value: id }],
    should_poll: false,
    features,
  };
}

const round = (v, digits) => Math.round(v * 10 ** digits) / 10 ** digits;

/**
 * The states of a contract device from what is known: `{ price, capacity }`
 * (`price` NOK/kWh or null; `capacity` = { kw, monthlyWithVat, next } or
 * null). An unknown value is not published.
 */
export function buildStates(gladys, id, { price, capacity }) {
  const ids = idsOf(gladys, id);
  const states = [];
  const push = (key, value) =>
    states.push({ device_feature_external_id: ids.feature(key), state: value });
  if (typeof price === 'number' && Number.isFinite(price)) push(FEATURE.PRICE, round(price, 5));
  if (capacity && Number.isFinite(capacity.kw)) {
    push(FEATURE.CAPACITY, round(capacity.kw, 3));
    if (Number.isFinite(capacity.monthlyWithVat)) {
      push(FEATURE.CAPACITY_FEE, round(capacity.monthlyWithVat, 2));
    }
    if (Number.isFinite(capacity.next)) push(FEATURE.NEXT_STEP, capacity.next);
  }
  return states;
}
