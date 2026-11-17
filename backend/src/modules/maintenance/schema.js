import net from 'node:net';
import { z } from 'zod';
import { ADMIN_ROLES } from '../rbac/permissions.js';

export const MAINTENANCE_SCOPES = Object.freeze([
  'FULL_PLATFORM',
  'GAMEPLAY_ONLY',
  'MATCHMAKING_ONLY',
  'FINANCIAL_ONLY'
]);

/**
 * Maximum scheduled maintenance window duration (7 days / 168 hours) to prevent
 * accidental indefinite lockouts from mistyped end dates.
 */
export const MAX_MAINTENANCE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Surfaces that are PERMANENTLY EXEMPT from maintenance blocks so administrators
 * can always authenticate, exercise RBAC, monitor health, and recover the platform.
 */
export const PROTECTED_EXEMPT_PREFIXES = Object.freeze([
  '/health',
  '/ready',
  '/webhooks',
  '/api/v1/auth',
  '/api/v1/admin',
  '/api/v1/maintenance'
]);

/**
 * Maps each MaintenanceScope to the player API route prefixes it restricts when active.
 */
export const SCOPE_RESTRICTED_PREFIXES = Object.freeze({
  FULL_PLATFORM: Object.freeze([
    '/api/v1/matches',
    '/api/v1/matchmaking',
    '/api/v1/callouts',
    '/api/v1/wallet',
    '/api/v1/verification',
    '/api/v1/safer-play',
    '/api/v1/notifications',
    '/api/v1/me'
  ]),
  GAMEPLAY_ONLY: Object.freeze([
    '/api/v1/matches',
    '/api/v1/matchmaking',
    '/api/v1/callouts'
  ]),
  MATCHMAKING_ONLY: Object.freeze([
    '/api/v1/matchmaking',
    '/api/v1/callouts'
  ]),
  FINANCIAL_ONLY: Object.freeze([
    '/api/v1/wallet'
  ])
});

export const DEFAULT_MAINTENANCE_STATE = Object.freeze({
  id: 'singleton',
  active: false,
  scope: 'FULL_PLATFORM',
  headline: 'Platform Under Scheduled Maintenance',
  message:
    'We are performing essential system updates. Gameplay and financial operations will resume shortly.',
  allowedIps: [],
  allowedRoles: ['SUPER_ADMIN'],
  startsAt: null,
  endsAt: null
});

const UNSAFE_HTML_REGEX = /<\s*\/?\s*[a-zA-Z!][^>]*>|javascript\s*:|vbscript\s*:|data\s*:\s*text\/html|\bon[a-z]+\s*=/i;

export function isValidIpOrCidr(candidate) {
  if (typeof candidate !== 'string') return false;
  const trimmed = candidate.trim();
  if (!trimmed) return false;

  if (trimmed.includes('/')) {
    const [ipPart, prefixPart] = trimmed.split('/');
    const ipVersion = net.isIP(ipPart);
    if (!ipVersion) return false;
    const prefix = Number(prefixPart);
    if (!Number.isInteger(prefix) || prefix < 0) return false;
    return ipVersion === 4 ? prefix <= 32 : prefix <= 128;
  }

  return net.isIP(trimmed) !== 0;
}

export const MaintenanceScopeSchema = z.enum(MAINTENANCE_SCOPES);
export const AdminRoleEnumSchema = z.enum(ADMIN_ROLES);

export const SafeBannerTextSchema = (fieldName, minLen, maxLen) =>
  z
    .string()
    .trim()
    .min(minLen, `${fieldName} must be at least ${minLen} characters`)
    .max(maxLen, `${fieldName} cannot exceed ${maxLen} characters`)
    .refine((val) => !UNSAFE_HTML_REGEX.test(val), {
      message: `${fieldName} cannot contain HTML tags, scripts, or executable URI schemes`
    });

export const AllowedIpSchema = z
  .string()
  .trim()
  .refine((val) => isValidIpOrCidr(val), {
    message: 'Each allowed IP entry must be a valid IPv4/IPv6 address or CIDR range'
  });

export const MaintenanceConfigInputSchema = z
  .object({
    active: z.boolean().optional(),
    scope: MaintenanceScopeSchema.optional(),
    headline: SafeBannerTextSchema('Headline', 3, 140).optional(),
    message: SafeBannerTextSchema('Maintenance message', 10, 1000).optional(),
    allowedIps: z
      .array(AllowedIpSchema)
      .max(50, 'Cannot configure more than 50 allowed IP entries')
      .transform((arr) => Array.from(new Set(arr)))
      .optional(),
    allowedRoles: z
      .array(AdminRoleEnumSchema)
      .min(1, 'At least SUPER_ADMIN must be included in allowedRoles')
      .transform((arr) => Array.from(new Set(arr)))
      .optional(),
    startsAt: z.union([z.string().datetime(), z.date(), z.null()]).optional(),
    endsAt: z.union([z.string().datetime(), z.date(), z.null()]).optional(),
    reason: z
      .string()
      .trim()
      .min(5, 'A reason of at least 5 characters is required')
      .max(500)
      .optional(),
    changeReason: z
      .string()
      .trim()
      .min(5, 'A change reason of at least 5 characters is required')
      .max(500)
      .optional()
  })
  .superRefine((data, ctx) => {
    // Lockout Protection 1: allowedRoles must ALWAYS include SUPER_ADMIN if specified
    if (Array.isArray(data.allowedRoles) && !data.allowedRoles.includes('SUPER_ADMIN')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['allowedRoles'],
        message:
          'Lockout protection: SUPER_ADMIN must always be included in allowedRoles so platform administrators cannot lock themselves out'
      });
    }

    // Lockout Protection 2: Validate scheduled window ordering and maximum duration
    const start = data.startsAt ? new Date(data.startsAt) : null;
    const end = data.endsAt ? new Date(data.endsAt) : null;

    if (start && Number.isNaN(start.getTime())) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['startsAt'],
        message: 'startsAt must be a valid ISO-8601 timestamp'
      });
    }
    if (end && Number.isNaN(end.getTime())) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['endsAt'],
        message: 'endsAt must be a valid ISO-8601 timestamp'
      });
    }

    if (start && end && !Number.isNaN(start.getTime()) && !Number.isNaN(end.getTime())) {
      if (end.getTime() <= start.getTime()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['endsAt'],
          message: 'Maintenance window endsAt must be strictly after startsAt'
        });
      } else if (end.getTime() - start.getTime() > MAX_MAINTENANCE_WINDOW_MS) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['endsAt'],
          message: 'Scheduled maintenance window cannot exceed 7 days (168 hours)'
        });
      }
    }
  });
