/**
 * Bank account masking and minimal-disclosure serializers.
 * Ensures full account numbers and internal provider recipient references
 * are never exposed in player-facing API responses, admin responses, errors, or logs.
 */

const MIN_VISIBLE_DIGITS = 4;

/**
 * Extracts the last 4 digits from an account number string.
 */
export const getAccountNumberLast4 = (accountNumber) => {
  if (typeof accountNumber !== 'string') return null;
  const trimmed = accountNumber.trim();
  if (!trimmed) return null;
  const digits = trimmed.replace(/\D/g, '');
  if (digits.length >= MIN_VISIBLE_DIGITS) {
    return digits.slice(-MIN_VISIBLE_DIGITS);
  }
  return trimmed.length >= MIN_VISIBLE_DIGITS ? trimmed.slice(-MIN_VISIBLE_DIGITS) : null;
};

/**
 * Masks an account number so only the last 4 characters are visible,
 * e.g. "0123456789" -> "******6789". Short values (<= 4 chars) are fully
 * masked as "****" so they can never be returned verbatim.
 */
export const maskAccountNumber = (accountNumber) => {
  if (typeof accountNumber !== 'string') return null;
  const trimmed = accountNumber.trim();
  if (!trimmed) return null;
  if (trimmed.length <= MIN_VISIBLE_DIGITS) {
    return '*'.repeat(Math.max(4, trimmed.length));
  }
  const last4 = trimmed.slice(-MIN_VISIBLE_DIGITS);
  const maskedPrefix = '*'.repeat(Math.max(4, trimmed.length - MIN_VISIBLE_DIGITS));
  return `${maskedPrefix}${last4}`;
};

/**
 * Minimal player-facing bank account view. Never returns raw accountNumber,
 * internal provider recipientRef, or internal metadata.
 */
export const serializeBankAccountForPlayer = (bankAccount) => {
  if (!bankAccount) return null;
  const masked = maskAccountNumber(bankAccount.accountNumber);
  const last4 = getAccountNumberLast4(bankAccount.accountNumber);
  return {
    id: bankAccount.id,
    gateway: bankAccount.gateway,
    bankCode: bankAccount.bankCode,
    bankName: bankAccount.bankName,
    accountNumber: masked,
    maskedAccountNumber: masked,
    accountNumberLast4: last4,
    accountName: bankAccount.accountName,
    isDefault: Boolean(bankAccount.isDefault),
    verifiedAt: bankAccount.verifiedAt ?? null,
    createdAt: bankAccount.createdAt ?? null
  };
};

/**
 * Sanitized admin-facing bank account view. Masks accountNumber and strips
 * internal provider recipientRef tokens while preserving verification metadata.
 */
export const serializeBankAccountForAdmin = (bankAccount) => {
  if (!bankAccount) return null;
  const masked = maskAccountNumber(bankAccount.accountNumber);
  const last4 = getAccountNumberLast4(bankAccount.accountNumber);
  return {
    id: bankAccount.id,
    gateway: bankAccount.gateway,
    bankCode: bankAccount.bankCode,
    bankName: bankAccount.bankName,
    accountNumber: masked,
    maskedAccountNumber: masked,
    accountNumberLast4: last4,
    accountName: bankAccount.accountName,
    verifiedName: bankAccount.verifiedName ?? bankAccount.accountName ?? null,
    isDefault: Boolean(bankAccount.isDefault),
    verifiedAt: bankAccount.verifiedAt ?? null,
    createdAt: bankAccount.createdAt ?? null
  };
};
