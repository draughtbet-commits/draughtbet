/**
 * Auth & Profile Simulation Scenario
 * Exercises geo-locate, registration/login (via ensureSyntheticUserSession),
 * profile read/update, and refresh token rotation through real HTTP routes.
 */
import { ensureSyntheticUserSession } from '../identityManager.js';

const AVATAR_CHOICES = ['draughts_king', 'knight_ng', 'crown_emerald', 'master_20x20', 'checker_pro'];

export async function runAuthProfileScenario(runner, userState) {
  userState.currentActivity = 'AUTH_PROFILE';

  // 1. Register or sign in independently with geo-binding + device fingerprint
  await ensureSyntheticUserSession(runner, userState);

  // 2. Read profile
  await runner.apiCall(userState, 'GET', '/me');

  // 3. Update player avatar via PATCH /me
  const nextAvatar = AVATAR_CHOICES[(userState.index - 1) % AVATAR_CHOICES.length];
  await runner.apiCall(userState, 'PATCH', '/me', {
    body: { avatar: nextAvatar }
  });

  // 4. Refresh token rotation
  if (userState.refreshToken && userState.userId) {
    const refreshed = await runner.apiCall(
      userState,
      'POST',
      '/auth/refresh',
      {
        body: {
          userId: userState.userId,
          refreshToken: userState.refreshToken,
          deviceInfo: {
            model: `SimDevice-${String(userState.index).padStart(2, '0')}`,
            os: 'SimOS 1.0',
            appVersion: '2.1.0'
          }
        }
      },
      [200]
    );
    if (refreshed.json?.accessToken && refreshed.json?.refreshToken) {
      userState.accessToken = refreshed.json.accessToken;
      userState.refreshToken = refreshed.json.refreshToken;
    }
  }

  // 5. Periodically exercise explicit logout + re-login on subset of accounts
  if (userState.index % 5 === 0 && userState.refreshToken) {
    await runner.apiCall(userState, 'POST', '/auth/logout', {
      body: { refreshToken: userState.refreshToken }
    });
    userState.online = false;
    const relogin = await runner.apiCall(userState, 'POST', '/auth/login', {
      body: {
        email: userState.email,
        password: userState.password,
        fingerprintHash: userState.deviceFingerprint,
        deviceInfo: {
          model: `SimDevice-${userState.runId}-${String(userState.index).padStart(2, '0')}`,
          os: 'SimOS 1.0',
          appVersion: '2.1.0'
        }
      }
    });
    if (relogin.json?.accessToken) {
      userState.accessToken = relogin.json.accessToken;
      userState.refreshToken = relogin.json.refreshToken;
      userState.online = true;
    }
  }

  userState.completedWorkflows += 1;
  userState.currentActivity = 'IDLE';
  return { ok: true };
}
