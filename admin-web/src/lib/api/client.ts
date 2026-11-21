import type { ApiErrorResponse } from './types';

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000/api/v1';
const LEGACY_STORAGE_KEYS = [
  'draughtbet_admin_token',
  'draughtbet_admin_refresh'
] as const;
const CSRF_COOKIE_NAME = 'db_csrf_token';
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export class ApiError extends Error {
  statusCode: number;
  data: ApiErrorResponse;

  constructor(message: string, statusCode: number, data: ApiErrorResponse) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.data = data;
  }
}

export function readCookieValue(name: string): string | null {
  if (typeof document === 'undefined' || !document.cookie) return null;
  const pairs = document.cookie.split(';');
  for (const pair of pairs) {
    const idx = pair.indexOf('=');
    if (idx <= 0) continue;
    const key = pair.slice(0, idx).trim();
    if (key === name) {
      const raw = pair.slice(idx + 1).trim();
      try {
        return decodeURIComponent(raw);
      } catch {
        return raw;
      }
    }
  }
  return null;
}

/**
 * Purges any legacy JWT/refresh tokens from localStorage or sessionStorage
 * so no bearer tokens remain readable by browser scripts.
 */
export function purgeLegacyTokenStorage() {
  if (typeof window === 'undefined') return;
  for (const key of LEGACY_STORAGE_KEYS) {
    try {
      window.localStorage.removeItem(key);
    } catch {
      // ignore storage access restrictions
    }
    try {
      window.sessionStorage.removeItem(key);
    } catch {
      // ignore storage access restrictions
    }
  }
}

/**
 * Cookie-authenticated API client for the Draught Bet Admin Console.
 *
 * Security invariants:
 * - Access & refresh JWTs live exclusively in server-set `HttpOnly` cookies
 *   (`db_admin_access` and `db_admin_refresh`); JavaScript never stores or reads
 *   tokens in `localStorage`, `sessionStorage`, or memory.
 * - Every request sends `credentials: 'include'` and `X-Auth-Mode: cookie`.
 * - Every state-changing request attaches the signed double-submit `X-CSRF-Token`
 *   header paired with the `db_csrf_token` cookie.
 * - 401 responses trigger a single-flight cookie refresh (`POST /auth/refresh`)
 *   to avoid refresh-token rotation races and reuse detection false positives.
 */
class ApiClient {
  private csrfToken: string | null = null;
  private accessExpiresAtMs: number | null = null;
  private refreshInFlight: Promise<boolean> | null = null;
  private csrfInFlight: Promise<string | null> | null = null;

  constructor() {
    purgeLegacyTokenStorage();
  }

  setSessionMetadata({
    expiresAt,
    expiresIn,
    csrfToken
  }: {
    expiresAt?: string | null;
    expiresIn?: number | null;
    csrfToken?: string | null;
  }) {
    if (csrfToken) {
      this.csrfToken = csrfToken;
    }
    if (expiresAt) {
      const parsed = Date.parse(expiresAt);
      if (Number.isFinite(parsed)) {
        this.accessExpiresAtMs = parsed;
      }
    } else if (typeof expiresIn === 'number' && Number.isFinite(expiresIn) && expiresIn > 0) {
      this.accessExpiresAtMs = Date.now() + expiresIn * 1000;
    }
  }

  clearAuth() {
    this.csrfToken = null;
    this.accessExpiresAtMs = null;
    purgeLegacyTokenStorage();
  }

  getCsrfToken(): string | null {
    const fromCookie = readCookieValue(CSRF_COOKIE_NAME);
    if (fromCookie) {
      this.csrfToken = fromCookie;
      return fromCookie;
    }
    return this.csrfToken;
  }

  async ensureCsrfToken(): Promise<string | null> {
    const existing = this.getCsrfToken();
    if (existing) return existing;

    if (this.csrfInFlight) {
      return this.csrfInFlight;
    }

    this.csrfInFlight = (async () => {
      try {
        const res = await fetch(`${API_BASE_URL}/auth/csrf`, {
          method: 'GET',
          credentials: 'include',
          headers: {
            'x-app-version': '2.1.0',
            'x-auth-mode': 'cookie'
          }
        });
        if (!res.ok) return null;
        const data = (await res.json().catch(() => ({}))) as { csrfToken?: string };
        if (data.csrfToken) {
          this.csrfToken = data.csrfToken;
          return data.csrfToken;
        }
        return this.getCsrfToken();
      } catch {
        return null;
      }
    })().finally(() => {
      this.csrfInFlight = null;
    });

    return this.csrfInFlight;
  }

  async ensureFreshToken(minRemainingMs = 3 * 60 * 1000): Promise<boolean> {
    if (this.accessExpiresAtMs !== null && this.accessExpiresAtMs - Date.now() > minRemainingMs) {
      return true;
    }
    return this.tryRefresh();
  }

  async request<T>(
    endpoint: string,
    options: RequestInit = {},
    retryOn401 = true
  ): Promise<T> {
    const url = endpoint.startsWith('http') ? endpoint : `${API_BASE_URL}${endpoint}`;
    const method = (options.method || 'GET').toUpperCase();
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'x-app-version': '2.1.0',
      'x-auth-mode': 'cookie',
      ...(options.headers as Record<string, string>)
    };

    if (MUTATING_METHODS.has(method)) {
      const csrf = this.getCsrfToken() || (await this.ensureCsrfToken());
      if (csrf) {
        headers['X-CSRF-Token'] = csrf;
      }
    }

    let response: Response;
    try {
      response = await fetch(url, {
        ...options,
        method,
        credentials: 'include',
        headers
      });
    } catch (networkErr: unknown) {
      throw new ApiError(
        networkErr instanceof Error ? networkErr.message : 'Network error: cannot reach backend',
        0,
        { error: 'Network error: backend unreachable' }
      );
    }

    // Handle 401 with single-flight HttpOnly cookie refresh retry
    if (
      response.status === 401 &&
      retryOn401 &&
      !endpoint.includes('/auth/login') &&
      !endpoint.includes('/auth/refresh') &&
      !endpoint.includes('/auth/logout')
    ) {
      const refreshed = await this.tryRefresh();
      if (refreshed) {
        return this.request<T>(endpoint, options, false);
      }
      this.clearAuth();
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('draughtbet:auth-expired'));
      }
    }

    if (!response.ok) {
      let errorData: ApiErrorResponse = {};
      try {
        errorData = await response.json();
      } catch {
        errorData = { error: response.statusText || 'Request failed' };
      }
      const message =
        errorData.error ||
        errorData.message ||
        (Array.isArray(errorData.errors) ? errorData.errors[0]?.message : null) ||
        `HTTP Error ${response.status}`;
      throw new ApiError(message, response.status, errorData);
    }

    if (response.status === 204) {
      return {} as T;
    }

    const payload = (await response.json()) as T & {
      csrfToken?: string;
      expiresAt?: string;
      expiresIn?: number;
    };
    if (payload && typeof payload === 'object') {
      if (payload.csrfToken || payload.expiresAt || payload.expiresIn) {
        this.setSessionMetadata({
          csrfToken: payload.csrfToken,
          expiresAt: payload.expiresAt,
          expiresIn: payload.expiresIn
        });
      }
    }
    return payload;
  }

  async tryRefresh(): Promise<boolean> {
    if (this.refreshInFlight) {
      return this.refreshInFlight;
    }

    this.refreshInFlight = (async () => {
      try {
        const csrf = this.getCsrfToken() || (await this.ensureCsrfToken());
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
          'x-app-version': '2.1.0',
          'x-auth-mode': 'cookie'
        };
        if (csrf) {
          headers['X-CSRF-Token'] = csrf;
        }

        const res = await fetch(`${API_BASE_URL}/auth/refresh`, {
          method: 'POST',
          credentials: 'include',
          headers,
          body: JSON.stringify({})
        });
        if (!res.ok) return false;
        const data = (await res.json().catch(() => ({}))) as {
          authenticated?: boolean;
          csrfToken?: string;
          expiresAt?: string;
          expiresIn?: number;
        };
        if (data.authenticated) {
          this.setSessionMetadata({
            csrfToken: data.csrfToken,
            expiresAt: data.expiresAt,
            expiresIn: data.expiresIn
          });
          return true;
        }
        return false;
      } catch {
        return false;
      }
    })().finally(() => {
      this.refreshInFlight = null;
    });

    return this.refreshInFlight;
  }

  get<T>(endpoint: string, options?: RequestInit) {
    return this.request<T>(endpoint, { ...options, method: 'GET' });
  }

  post<T>(endpoint: string, body?: unknown, options?: RequestInit) {
    return this.request<T>(endpoint, {
      ...options,
      method: 'POST',
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
  }

  patch<T>(endpoint: string, body?: unknown, options?: RequestInit) {
    return this.request<T>(endpoint, {
      ...options,
      method: 'PATCH',
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
  }

  delete<T>(endpoint: string, options?: RequestInit) {
    return this.request<T>(endpoint, { ...options, method: 'DELETE' });
  }
}

export const apiClient = new ApiClient();
