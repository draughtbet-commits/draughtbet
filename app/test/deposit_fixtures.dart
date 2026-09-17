import 'package:draughts_arena/models/deposit_flow.dart';

const depositMethodsFixture = [
  DepositPaymentMethod(
    id: 'server-card-method',
    label: 'Card',
    description: 'Pay securely with a saved or new card',
    maskedInstrument: '•••• 4242',
  ),
  DepositPaymentMethod(
    id: 'server-bank-method',
    label: 'Bank Transfer',
    description: 'Transfer from your bank account',
  ),
];

final depositQuoteFixture = DepositQuote(
  id: 'quote-7845',
  amountMinorUnits: 200000,
  feeMinorUnits: 0,
  totalMinorUnits: 200000,
  currency: 'NGN',
  paymentMethods: depositMethodsFixture,
  idempotencyKey: 'test-only-idempotency-key',
  expiresAt: DateTime.utc(2026, 9, 17, 10),
);

DepositIntentData depositIntentFixture({
  DepositStatus status = DepositStatus.pending,
  String? failureReason,
}) => DepositIntentData(
  reference: 'DBT78456213',
  amountMinorUnits: 200000,
  feeMinorUnits: 0,
  totalMinorUnits: 200000,
  currency: 'NGN',
  status: status,
  paymentMethodLabel: 'Card',
  maskedInstrument: '•••• 4242',
  authorizationUrl: Uri.parse('https://checkout.example.test/session'),
  failureReason: failureReason,
  createdAt: DateTime.utc(2026, 9, 17, 9, 41),
  updatedAt: DateTime.utc(2026, 9, 17, 9, 43),
  availableBalanceMinorUnits: status == DepositStatus.successful
      ? 3445000
      : null,
  transactionId: status == DepositStatus.successful ? 'tx-verified-1' : null,
);
