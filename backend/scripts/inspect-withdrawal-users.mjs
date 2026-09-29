// Inspects the users the withdrawal drive depends on: balance, KYC state and
// saved bank accounts. Read-only.
import prisma from '../src/utils/db.js';
import { getWalletBalance } from '../src/modules/wallet/service.js';

const users = await prisma.user.findMany({
  select: {
    id: true,
    email: true,
    kycStatus: true,
    ageVerified: true,
    isBanned: true,
    bankAccounts: {
      select: { bankCode: true, accountName: true, verifiedAt: true, recipientRef: true },
    },
  },
  orderBy: { createdAt: 'asc' },
  take: 12,
});

for (const u of users) {
  const balance = await getWalletBalance(u.id);
  console.log(
    `${u.email} | kyc=${u.kycStatus} age=${u.ageVerified} banned=${u.isBanned} | ` +
      `avail=${balance?.availableMinor ?? '-'} pending=${balance?.withdrawalPendingMinor ?? '-'} | ` +
      `banks=${
        u.bankAccounts
          .map((b) => `${b.bankCode}:${b.verifiedAt ? 'verified' : 'unverified'}/${b.recipientRef ?? 'no-ref'}`)
          .join(',') || 'none'
      }`
  );
}

const admins = await prisma.user.findMany({
  where: { isAdmin: true },
  select: { email: true, adminRoleAssignments: { select: { role: { select: { name: true } } } } },
  take: 6,
});
console.log('\nstaff:');
for (const a of admins) {
  console.log(`  ${a.email}: ${a.adminRoleAssignments.map((r) => r.role.name).join(',') || 'NO ROLES'}`);
}

await prisma.$disconnect();
