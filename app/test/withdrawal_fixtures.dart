import 'package:draughts_arena/models/withdrawal_flow.dart';

const withdrawalBanksFixture = [
  WithdrawalBankAccount(
    id: 'bank-1',
    bankCode: '011',
    bankName: 'First Bank',
    accountName: 'WISDOM RAPTOR',
    maskedAccountNumber: '••••1234',
    isDefault: true,
  ),
  WithdrawalBankAccount(
    id: 'bank-2',
    bankCode: '058',
    bankName: 'GTBank',
    accountName: 'WISDOM RAPTOR',
    maskedAccountNumber: '••••5678',
  ),
];

// The contract has no withdrawal quote, so the flow carries the player's own
// amount plus the server's eligibility verdict.
final withdrawalIntentFixture = WithdrawalIntent(
  amountMinorUnits: 500000,
  currency: 'NGN',
  eligibility: WithdrawalEligibility.eligible,
  idempotencyKey: 'withdrawal-idempotency-test-only',
);

/// An allowed §4 eligibility report.
final withdrawalEligibilityAllowedFixture = WithdrawalEligibilityReport(
  allowed: true,
  requirements: const [
    'eligibility:on_file',
    'country:allowed',
    'kyc:verified',
  ],
);

/// A §4 report blocked on KYC, carrying the canonical gate code and the
/// server's own message.
final withdrawalEligibilityKycFixture = WithdrawalEligibilityReport(
  allowed: false,
  errorCode: 'KycRequiredError',
  message: 'Identity verification is required before withdrawal.',
);

WithdrawalData withdrawalDataFixture({
  WithdrawalStatus status = WithdrawalStatus.pendingReview,
  String? failureReason,
}) => WithdrawalData(
  id: 'withdrawal-row-1',
  reference: 'wit-00000000-0000-4000-8000-000000000001',
  amountMinorUnits: 500000,
  currency: 'NGN',
  status: status,
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
  updatedAt: DateTime.utc(2026, 9, 19, 9, 43),
);
