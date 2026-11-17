import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Formats minor units (kobo) into standard Naira format.
 * Canonical currency rule: backend stores minor units (BigInt/integer string).
 * Never float in calculations.
 */
export function formatNaira(minorUnits: string | number | bigint | null | undefined): string {
  if (minorUnits === null || minorUnits === undefined) return '₦0.00';
  const kobo = typeof minorUnits === 'string' ? BigInt(minorUnits) : BigInt(minorUnits);
  const isNegative = kobo < BigInt(0);
  const absKobo = isNegative ? -kobo : kobo;
  const naira = absKobo / BigInt(100);
  const remKobo = absKobo % BigInt(100);
  const formattedNaira = Number(naira).toLocaleString('en-NG');
  const formattedKobo = remKobo.toString().padStart(2, '0');
  return `${isNegative ? '-' : ''}₦${formattedNaira}.${formattedKobo}`;
}

export function formatDate(isoString: string | null | undefined): string {
  if (!isoString) return '—';
  try {
    const d = new Date(isoString);
    return new Intl.DateTimeFormat('en-GB', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    }).format(d);
  } catch {
    return isoString;
  }
}

