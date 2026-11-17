import { apiClient } from './client';
import { AuthTokens, AdminProfileResponse } from './types';

export const authApi = {
  async login(identifier: string, password: string): Promise<AuthTokens> {
    const isEmail = identifier.includes('@');
    const body = isEmail ? { email: identifier, password } : { phone: identifier, password };
    const tokens = await apiClient.post<AuthTokens>('/auth/login', body);
    apiClient.setTokens(tokens.accessToken, tokens.refreshToken);
    return tokens;
  },

  async logout(): Promise<void> {
    try {
      await apiClient.post('/auth/logout');
    } catch {
      // Best-effort logout on backend
    } finally {
      apiClient.clearAuth();
    }
  },

  async getAdminMe(): Promise<AdminProfileResponse> {
    return apiClient.get<AdminProfileResponse>('/admin/me');
  }
};

