import { apiClient } from './client';
import type {
  CookieAuthSessionResponse,
  AdminProfileResponse,
  MfaStatusResponse,
  MfaSetupResponse,
  MfaVerifyResponse,
  MfaRegenerateRecoveryResponse
} from './types';

export const authApi = {
  async login(identifier: string, password: string): Promise<CookieAuthSessionResponse> {
    const isEmail = identifier.includes('@');
    const body = isEmail ? { email: identifier, password } : { phone: identifier, password };
    const session = await apiClient.post<CookieAuthSessionResponse>('/auth/login', body);
    apiClient.setSessionMetadata({
      csrfToken: session.csrfToken,
      expiresAt: session.expiresAt,
      expiresIn: session.expiresIn
    });
    return session;
  },

  async logout(): Promise<void> {
    try {
      await apiClient.post('/auth/logout', {});
    } catch {
      // Best-effort logout on backend; always clear client session state
    } finally {
      apiClient.clearAuth();
    }
  },

  async getAdminMe(): Promise<AdminProfileResponse> {
    return apiClient.get<AdminProfileResponse>('/admin/me');
  },

  async getMfaStatus(): Promise<MfaStatusResponse> {
    return apiClient.get<MfaStatusResponse>('/admin/mfa/status');
  },

  async setupMfa(currentCode?: string): Promise<MfaSetupResponse> {
    return apiClient.post<MfaSetupResponse>(
      '/admin/mfa/setup',
      currentCode ? { currentCode } : {}
    );
  },

  async enableMfa(code: string): Promise<MfaVerifyResponse> {
    return apiClient.post<MfaVerifyResponse>('/admin/mfa/verify', { code });
  },

  async verifyMfaSession(code: string): Promise<MfaVerifyResponse> {
    return apiClient.post<MfaVerifyResponse>('/admin/mfa/verify-session', { code });
  },

  async recoverMfaSession(recoveryCode: string): Promise<MfaVerifyResponse> {
    return apiClient.post<MfaVerifyResponse>('/admin/mfa/recover', { recoveryCode });
  },

  async regenerateRecoveryCodes(code: string): Promise<MfaRegenerateRecoveryResponse> {
    return apiClient.post<MfaRegenerateRecoveryResponse>('/admin/mfa/recovery-codes/regenerate', {
      code
    });
  },

  async disableMfa(code: string): Promise<{ disabled: boolean }> {
    return apiClient.post<{ disabled: boolean }>('/admin/mfa/disable', { code });
  }
};
