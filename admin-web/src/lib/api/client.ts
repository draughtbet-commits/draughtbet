import type { ApiErrorResponse } from './types';

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000/api/v1';

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

class ApiClient {
  private accessToken: string | null = null;
  private refreshToken: string | null = null;

  constructor() {
    if (typeof window !== 'undefined') {
      this.accessToken = localStorage.getItem('draughtbet_admin_token');
      this.refreshToken = localStorage.getItem('draughtbet_admin_refresh');
    }
  }

  setTokens(accessToken: string | null, refreshToken: string | null) {
    this.accessToken = accessToken;
    this.refreshToken = refreshToken;
    if (typeof window !== 'undefined') {
      if (accessToken) localStorage.setItem('draughtbet_admin_token', accessToken);
      else localStorage.removeItem('draughtbet_admin_token');

      if (refreshToken) localStorage.setItem('draughtbet_admin_refresh', refreshToken);
      else localStorage.removeItem('draughtbet_admin_refresh');
    }
  }

  getAccessToken() {
    return this.accessToken;
  }

  clearAuth() {
    this.setTokens(null, null);
  }

  async request<T>(
    endpoint: string,
    options: RequestInit = {},
    retryOn401 = true
  ): Promise<T> {
    const url = endpoint.startsWith('http') ? endpoint : `${API_BASE_URL}${endpoint}`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'x-app-version': '2.1.0',
      ...(options.headers as Record<string, string>)
    };

    if (this.accessToken) {
      headers['Authorization'] = `Bearer ${this.accessToken}`;
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

    // Handle 401 token refresh retry
    if (response.status === 401 && retryOn401 && this.refreshToken && !endpoint.includes('/auth/login')) {
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
    if (!this.refreshToken || !this.accessToken) return false;
    let userId: string | null = null;
    try {
      const parts = this.accessToken.split('.');
      if (parts.length === 3) {
        const payload = JSON.parse(atob(parts[1]));
        userId = payload.userId || payload.sub || null;
      }
    } catch {
      return false;
    }
    if (!userId) return false;

    try {
      const res = await fetch(`${API_BASE_URL}/auth/refresh`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-app-version': '2.1.0'
        },
        body: JSON.stringify({ userId, refreshToken: this.refreshToken })
      });
      if (!res.ok) return false;
      const data = await res.json();
      if (data.accessToken) {
        this.setTokens(data.accessToken, data.refreshToken || this.refreshToken);
        return true;
      }
      return false;
    } catch {
      return false;
    }
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

