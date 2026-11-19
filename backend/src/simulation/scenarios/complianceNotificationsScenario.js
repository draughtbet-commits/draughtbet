/**
 * Compliance, Safer-Play & Player Notifications Scenario
 * Exercises KYC status/start, high-stakes safer-play limits, and notification
 * read & bulk read-all receipts.
 */
export async function runComplianceNotificationsScenario(runner, userState) {
  userState.currentActivity = 'COMPLIANCE_SAFER_PLAY';

  // 1. Check KYC status and initiate ID_DOCUMENT verification
  const kycRes = await runner.apiCall(userState, 'GET', '/verification/status');
  const currentKyc = kycRes.json?.kycStatus;
  if (currentKyc !== 'VERIFIED' && currentKyc !== 'PENDING') {
    const startRes = await runner.apiCall(
      userState,
      'POST',
      '/verification/start',
      { body: { type: 'ID_DOCUMENT' } },
      [200, 201, 409, 429]
    );
    if ((startRes.status === 200 || startRes.status === 201) && userState.index <= 25) {
      runner.logActivity(`${userState.label} verified KYC (ID_DOCUMENT)`, {
        userIndex: userState.index,
        event: 'kyc.start'
      });
    }
  }

  // 2. High-stakes Safer-Play ceilings so PRO/MASTER matches and high deposits work cleanly
  await runner.apiCall(userState, 'GET', '/safer-play/profile');
  await runner.apiCall(
    userState,
    'PUT',
    '/safer-play/deposit-limit',
    { body: { amountMinorUnits: '500000000' } },
    [200, 400]
  );
  await runner.apiCall(
    userState,
    'PUT',
    '/safer-play/stake-limit',
    { body: { amountMinorUnits: '50000000' } },
    [200, 400]
  );

  // 3. Notifications list + individual/bulk read receipts
  const notifRes = await runner.apiCall(userState, 'GET', '/notifications?page=1&limit=20');
  const notifications = notifRes.json?.notifications ?? [];
  const firstUnread = notifications.find((n) => !n.isRead);
  if (firstUnread) {
    await runner.apiCall(
      userState,
      'PATCH',
      `/notifications/${firstUnread.id}/read`,
      {},
      [200]
    );
  }
  if (userState.index % 10 === 0) {
    await runner.apiCall(userState, 'PATCH', '/notifications/read-all', {}, [200]);
  }

  userState.completedWorkflows += 1;
  userState.currentActivity = 'IDLE';
  return { ok: true };
}
