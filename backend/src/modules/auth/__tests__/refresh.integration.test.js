// Real-PostgreSQL + real-Redis refresh-rotation integration test.
// Skipped by default; run (start a postgres + redis container first):
//   DATABASE_URL=postgresql://test:test@127.0.0.1:5544/testpostgres?schema=public \
//   REDIS_URL=redis://127.0.0.1:6379/0 \
//   RUN_REDIS_INTEGRATION=1 node --experimental-vm-modules node_modules/jest/bin/jest.js \
//     --forceExit src/modules/auth/__tests__/refresh.integration.test.js
import prisma from '../../../utils/db.js';
import redis from '../../../utils/redis.js';
import { AuthService } from '../service.js';

const describeIntegration =
  process.env.RUN_REDIS_INTEGRATION === '1' ? describe : describe.skip;

describeIntegration('Refresh token rotation (real PostgreSQL + real Redis)', () => {
  const userIds = [];

  const makeUser = async () => {
    const user = await prisma.user.create({
      data: {
        email: `refresh-${Date.now()}-${Math.random()}@test.local`,
        passwordHash: 'x',
        isBanned: false
      }
    });
    await prisma.wallet.create({ data: { userId: user.id } });
    userIds.push(user.id);
    return user;
  };

  afterAll(async () => {
    for (const id of userIds) await AuthService.revokeAllRefreshTokens(id).catch(() => {});
    await prisma.wallet.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.$disconnect();
    redis?.disconnect?.('flush');
  });

  it('two simultaneous refreshes from one token yield exactly one valid successor', async () => {
    const user = await makeUser();
    const { refreshToken } = await AuthService.issueTokens(user.id);

    const [a, b] = await Promise.allSettled([
      AuthService.refresh(user.id, refreshToken),
      AuthService.refresh(user.id, refreshToken)
    ]);

    const fulfilled = [a, b].filter((r) => r.status === 'fulfilled');
    const rejected = [a, b].filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason.message).toBe('Invalid or expired refresh token');

    const successor = fulfilled[0].value.refreshToken;
    expect(successor).not.toBe(refreshToken);
    expect(await redis.exists(`refresh:${user.id}:${successor}`)).toBe(1);

    // Only the successor and no other family member is live from this token.
    expect(await redis.keys(`refresh:${user.id}:*`)).toHaveLength(1);
  });

  it('reuse of a consumed token is rejected and never grants a successor', async () => {
    const user = await makeUser();
    const { refreshToken } = await AuthService.issueTokens(user.id);
    const rotated = await AuthService.refresh(user.id, refreshToken);

    await expect(AuthService.refresh(user.id, refreshToken))
      .rejects.toThrow('Invalid or expired refresh token');

    // The granted successor is intact; the reused token produced nothing new.
    expect(await redis.exists(`refresh:${user.id}:${rotated.refreshToken}`)).toBe(1);
    expect(await redis.keys(`refresh:${user.id}:*`)).toHaveLength(1);
  });

  it('revocation clears every refresh token a user holds', async () => {
    const user = await makeUser();
    await AuthService.issueTokens(user.id);
    await AuthService.issueTokens(user.id);
    expect(await redis.keys(`refresh:${user.id}:*`)).toHaveLength(2);

    await AuthService.revokeAllRefreshTokens(user.id);
    expect(await redis.keys(`refresh:${user.id}:*`)).toHaveLength(0);
  });
});