import logger from '../utils/logger.js';

// Countries where real-money betting/gaming is restricted. Override via the
// BLOCKED_COUNTRIES env var (comma-separated ISO 3166-1 alpha-2 codes).
const DEFAULT_BLOCKED_COUNTRIES = ['US', 'CN', 'IR', 'KP', 'SY', 'CU', 'MM', 'SD'];

function blockedCountries() {
  if (!process.env.BLOCKED_COUNTRIES) return DEFAULT_BLOCKED_COUNTRIES;
  return process.env.BLOCKED_COUNTRIES
    .split(',')
    .map((c) => c.trim().toUpperCase())
    .filter(Boolean);
}

// Reverse geocoding is done via Nominatim (OpenStreetMap). No API key needed.
// The endpoint can be swapped via the REVERSE_GEOCODER_URL env var.
const REVERSE_GEOCODER_URL =
  process.env.REVERSE_GEOCODER_URL || 'https://nominatim.openstreetmap.org/reverse';

const SIM_GEO_CACHE = new Map();
const SIM_GEO_CACHE_TTL_MS = 10 * 60 * 1000;
const SIM_GEO_CACHE_MAX = 1000;

function isDevSimulationActive() {
  return process.env.NODE_ENV === 'development' && process.env.SIMULATION_ENABLED === 'true';
}

export class GeoService {
  static async __lookupCoordinates(lat, lng, { fetchFn = fetch } = {}) {
    const url = `${REVERSE_GEOCODER_URL}?lat=${lat}&lon=${lng}&format=jsonv2&accept-language=en`;
    const res = await fetchFn(url, {
      headers: {
        'User-Agent': 'DraughtBet (backend geolocation check; contact support@draughtbet.com)',
        'Accept': 'application/json'
      }
    });
    if (!res.ok) {
      throw new Error(`Geocoder responded with status ${res.status}`);
    }
    return res.json();
  }

  /**
   * Resolve GPS coordinates to a country code (ISO 3166-1 alpha-2, lowercase).
   * Returns null when the country cannot be determined.
   */
  static async resolveCountryCode(lat, lng) {
    const simMode = isDevSimulationActive();
    const cacheKey = `${Number(lat).toFixed(2)},${Number(lng).toFixed(2)}`;
    if (simMode) {
      const cached = SIM_GEO_CACHE.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) {
        return cached.code;
      }
    }

    try {
      const data = await this.__lookupCoordinates(lat, lng);
      const code = data?.address?.country_code;
      if (!code || typeof code !== 'string' || code.length !== 2) return null;
      const normalized = code.toLowerCase();
      if (simMode) {
        if (SIM_GEO_CACHE.size >= SIM_GEO_CACHE_MAX) {
          SIM_GEO_CACHE.clear();
        }
        SIM_GEO_CACHE.set(cacheKey, { code: normalized, expiresAt: Date.now() + SIM_GEO_CACHE_TTL_MS });
      }
      return normalized;
    } catch (err) {
      logger.error({ err, event: 'reverse_geocode_failed' }, 'Reverse geocoding failed');
      // Strictly in dev simulation mode, fall back cleanly on third-party geocoder 429 throttling
      if (simMode && Number(lat) >= 4 && Number(lat) <= 14 && Number(lng) >= 2.5 && Number(lng) <= 15) {
        SIM_GEO_CACHE.set(cacheKey, { code: 'ng', expiresAt: Date.now() + SIM_GEO_CACHE_TTL_MS });
        return 'ng';
      }
      return null;
    }
  }

  static isCountryAllowed(countryCode) {
    if (!countryCode) return false;
    const blocked = blockedCountries();
    return !blocked.includes(countryCode.toUpperCase());
  }

  static async geolocate(lat, lng) {
    const countryCode = await this.resolveCountryCode(lat, lng);
    return {
      countryCode,
      allowed: this.isCountryAllowed(countryCode)
    };
  }
}