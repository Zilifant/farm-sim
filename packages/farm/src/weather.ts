// Deterministic daily weather. Every reading is a pure counter-hash function
// of (seed, absolute day), so weather needs no stored state, snapshots carry
// nothing, and the forecast can literally compute the future — then blur it
// with lead-time uncertainty so the *player* cannot.
//
// The climate is Midwest-shaped: cold winters, hot Julys, a spring rain
// peak, and enough tail on the temperature noise that late frosts and heat
// waves happen without being scripted events.

import { hashCell } from "@sim/runtime";
import { DAYS_PER_YEAR, dayOfYear } from "./catalog.js";

/** Salt space for weather draws (distinct from market/ops salts). */
const SALT_TEMP = 101;
const SALT_SPREAD = 102;
const SALT_RAIN_CHANCE = 103;
const SALT_RAIN_AMOUNT = 104;
const SALT_FORECAST = 105;

export interface DailyWeather {
  /** Daytime high, °F. */
  readonly high: number;
  /** Overnight low, °F. */
  readonly low: number;
  /** Rainfall, inches. */
  readonly rain: number;
}

export interface ForecastDay {
  /** Days ahead of the issue day (1 = tomorrow). */
  readonly lead: number;
  readonly high: number;
  readonly low: number;
  /** 0..1 chance of rain as reported to the player. */
  readonly rainChance: number;
  /** Expected rainfall if it rains, inches. */
  readonly rainAmount: number;
}

const TWO_PI = Math.PI * 2;

/** Uniform [0, 1) from a hash draw. */
function u01(seedHash: number, day: number, salt: number): number {
  return hashCell(seedHash, day | 0, 0, 0, salt) / 0x100000000;
}

/** Rough normal-ish noise in [-1, 1] (mean 0): average of two uniforms. */
function noise(seedHash: number, day: number, salt: number): number {
  const a = u01(seedHash, day, salt);
  const b = u01(seedHash, day, salt + 1000);
  return a + b - 1;
}

/** Seasonal mean daytime high, °F: ~27 in mid-January, ~87 in mid-July. */
export function seasonalHighMean(doy: number): number {
  return 57 + 30 * Math.cos((TWO_PI * (doy - 196)) / DAYS_PER_YEAR);
}

/** Seasonal chance of a rain day, peaking in late spring. */
export function seasonalRainChance(doy: number): number {
  return 0.24 + 0.1 * Math.cos((TWO_PI * (doy - 135)) / DAYS_PER_YEAR);
}

/** The authoritative weather for an absolute day. */
export function weatherFor(seedHash: number, day: number): DailyWeather {
  const doy = dayOfYear(day);
  const high = seasonalHighMean(doy) + noise(seedHash, day, SALT_TEMP) * 12;
  const spread = 12 + u01(seedHash, day, SALT_SPREAD) * 10;
  const low = high - spread;
  const rainChance = seasonalRainChance(doy);
  const rolls = u01(seedHash, day, SALT_RAIN_CHANCE);
  let rain = 0;
  if (rolls < rainChance) {
    // Exponential-ish amounts: mostly light, occasionally a soaker.
    const u = u01(seedHash, day, SALT_RAIN_AMOUNT);
    rain = Math.min(3.5, -Math.log(1 - u * 0.98) * 0.45);
  }
  return {
    high: Math.round(high * 10) / 10,
    low: Math.round(low * 10) / 10,
    rain: Math.round(rain * 100) / 100,
  };
}

/**
 * The forecast issued on `issueDay` for `lead` days ahead. Confidence decays
 * with lead: near-term forecasts track the real weather closely, far ones
 * regress toward climatology with added jitter. Deterministic — the same
 * issue day always produces the same forecast.
 */
export function forecastFor(seedHash: number, issueDay: number, lead: number): ForecastDay {
  const target = issueDay + lead;
  const actual = weatherFor(seedHash, target);
  const doy = dayOfYear(target);
  // Weight on truth: 0.95 for tomorrow, fading toward 0.25 a week out.
  const w = Math.max(0.25, 0.95 - 0.12 * (lead - 1));
  const jitter = noise(seedHash, issueDay * 16 + lead, SALT_FORECAST) * (1 - w);
  const high = actual.high * w + seasonalHighMean(doy) * (1 - w) + jitter * 10;
  const low = actual.low * w + (seasonalHighMean(doy) - 20) * (1 - w) + jitter * 10;
  const climChance = seasonalRainChance(doy);
  const rainChance = actual.rain > 0.01 ? w * 0.9 + climChance * (1 - w) : (1 - w) * climChance;
  const rainAmount = actual.rain * w + 0.3 * climChance * (1 - w);
  return {
    lead,
    high: Math.round(high),
    low: Math.round(low),
    rainChance: Math.round(rainChance * 100) / 100,
    rainAmount: Math.round(rainAmount * 100) / 100,
  };
}
