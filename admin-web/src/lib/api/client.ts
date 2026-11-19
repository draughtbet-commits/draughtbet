import type { ApiErrorResponse } from './types';

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000/api/v1';
const ACCESS_TOKEN_KEY = 'draughtbet_admin_token';
const REFRESH_TOKEN_KEY = 'draughtbet_admin_refresh';

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

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');
    return JSON.parse(atob(padded)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

class ApiClient {
  private accessToken: string | null = null;
  private refreshToken: string | null = null;
  private refreshInFlight: Promise<boolean> | null = null;

  constructor() {
    if (typeof window !== 'undefined') {
      this.syncTokensFromStorage();
      window.addEventListener('storage', (ev) => {
        if (ev.key === ACCESS_TOKEN_KEY || ev.key === REFRESH_TOKEN_KEY || ev.key === null) {
          this.syncTokensFromStorage();
        }
      });
    }
  }

  private syncTokensFromStorage() {
    if (typeof window === 'undefined') return;
    this.accessToken = localStorage.getItem(ACCESS_TOKEN_KEY);
    this.refreshToken = localStorage.getItem(REFRESH_TOKEN_KEY);
  }

  setTokens(accessToken: string | null, refreshToken: string | null) {
    this.accessToken = accessToken;
    this.refreshToken = refreshToken;
    if (typeof window !== 'undefined') {
      if (accessToken) localStorage.setItem(ACCESS_TOKEN_KEY, accessToken);
      else localStorage.removeItem(ACCESS_TOKEN_KEY);

      if (refreshToken) localStorage.setItem(REFRESH_TOKEN_KEY, refreshToken);
      else localStorage.removeItem(REFRESH_TOKEN_KEY);
    }
  }

  getAccessToken() {
    if (typeof window !== 'undefined') {
      this.syncTokensFromStorage();
    }
    return this.accessToken;
  }

  getRefreshToken() {
    if (typeof window !== 'undefined') {
      this.syncTokensFromStorage();
    }
    return this.refreshToken;
  }

  getAccessTokenExpiryMs(): number | null {
    const token = this.getAccessToken();
    if (!token) return null;
    const payload = decodeJwtPayload(token);
    return typeof payload?.exp === 'number' ? payload.exp * 1000 : null;
  }

  clearAuth() {
    this.setTokens(null, null);
  }

  async ensureFreshToken(minRemainingMs = 3 * 60 * 1000): Promise<boolean> {
    const expMs = this.getAccessTokenExpiryMs();
    if (!this.getRefreshToken()) return false;
    if (expMs !== null && expMs - Date.now() > minRemainingMs) {
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
    const token = this.getAccessToken();
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'x-app-version': '2.1.0',
      ...(options.headers as Record<string, string>)
    };

    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    let response: Response;
    try {
      response = await fetch(url, { ...options, headers });
    } catch (networkErr: unknown) {
      throw new ApiError(
        networkErr instanceof Error ? networkErr.message : 'Network error: cannot reach backend',
        0,
        { error: 'Network error: backend unreachable' }
      );
    }

    // Handle 401 with single-flight token refresh retry (avoids single-use rotation races)
    if (
      response.status === 401 &&
      retryOn401 &&
      this.getRefreshToken() &&
      !endpoint.includes('/auth/login') &&
      !endpoint.includes('/auth/refresh')
    ) {
      const refreshed = await this.tryRefresh();
      if (refreshed) {
        return this.request<T>(endpoint, options, false);
      } else {
        this.clearAuth();
        if (typeof window !== 'undefined') {
          window.dispatchEvent(new CustomEvent('draughtbet:auth-expired'));
        }
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

    return response.json();
  }

  private async tryRefresh(): Promise<boolean> {
    if (this.refreshInFlight) {
      return this.refreshInFlight;
    }

    this.refreshInFlight = (async () => {
      this.syncTokensFromStorage();
      const currentRefresh = this.refreshToken;
      const currentAccess = this.accessToken;
      if (!currentRefresh || !currentAccess) return false;

      const payload = decodeJwtPayload(currentAccess);
      const userId =
        (typeof payload?.userId === 'string' && payload.userId) ||
        (typeof payload?.sub === 'string' && payload.sub) ||
        null;
      if (!userId) return false;

      try {
        const res = await fetch(`${API_BASE_URL}/auth/refresh`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-app-version': '2.1.0'
          },
          body: JSON.stringify({ userId, refreshToken: currentRefresh })
        });
        if (!res.ok) return false;
        const data = await res.json();
        if (data.accessToken) {
          this.setTokens(data.accessToken, data.refreshToken || currentRefresh);
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
    return this.request<T>(endpoint, { credentials: 'omit', ...options, method: 'GET' });
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
