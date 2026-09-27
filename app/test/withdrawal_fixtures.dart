import 'package:draughts_arena/models/withdrawal_flow.dart';

final withdrawalBanksFixture = [
  WithdrawalBankAccount(
    id: 'bank-1',
    gateway: 'PAYSTACK',
    bankCode: '011',
    bankName: 'First Bank',
    accountName: 'WISDOM RAPTOR',
    maskedAccountNumber: '••••1234',
    verifiedAt: DateTime.utc(2026, 9, 18),
    isDefault: true,
  ),
  WithdrawalBankAccount(
    id: 'bank-2',
    gateway: 'PAYSTACK',
    bankCode: '058',
    bankName: 'GTBank',
    accountName: 'WISDOM RAPTOR',
    maskedAccountNumber: '••••5678',
    verifiedAt: DateTime.utc(2026, 9, 18),
  ),
];

final withdrawalQuoteFixture = WithdrawalQuote(
  id: 'withdrawal-quote-1',
  amountMinorUnits: 500000,
  currency: 'NGN',
  eligibility: WithdrawalEligibility.eligible,
  availableBalanceMinorUnits: 3245000,
  feeMinorUnits: 0,
  netAmountMinorUnits: 500000,
  idempotencyKey: 'withdrawal-idempotency-test-only',
  expiresAt: DateTime.utc(2026, 9, 19, 10),
);

WithdrawalData withdrawalDataFixture({
  WithdrawalStatus status = WithdrawalStatus.pendingReview,
  String? failureReason,
  DateTime? updatedAt,
}) => WithdrawalData(
  id: 'withdrawal-1',
  reference: 'WDR21456789',
  amountMinorUnits: 500000,
  currency: 'NGN',
  status: status,
  serverStatus: switch (status) {
    WithdrawalStatus.pendingReview => 'PENDING_REVIEW',
    WithdrawalStatus.approved => 'APPROVED',
    WithdrawalStatus.processing => 'PROCESSING',
    WithdrawalStatus.successful => 'COMPLETED',
    WithdrawalStatus.failed => 'FAILED',
    WithdrawalStatus.reversed => 'RELEASED',
    WithdrawalStatus.unknown => 'FUTURE_STATUS',
  },
  gateway: 'PAYSTACK',
  bankAccountId: 'bank-1',
  feeMinorUnits: 0,
  netAmountMinorUnits: 500000,
  availableBalanceMinorUnits:
      status == WithdrawalStatus.successful ||
          status == WithdrawalStatus.reversed
      ? 2745000
      : null,
  bankAccount: withdrawalBanksFixture.first,
  failureReason: failureReason,
  transactionId: status == WithdrawalStatus.successful ? 'tx-wdr-1' : null,
  createdAt: DateTime.utc(2026, 9, 19, 9, 41),
  updatedAt: updatedAt ?? DateTime.utc(2026, 9, 19, 9, 43),
);
