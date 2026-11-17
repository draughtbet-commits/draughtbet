import { z } from 'zod';

export const NOTIFICATION_CATEGORIES = Object.freeze([
  'TRANSACTIONAL',
  'GAMEPLAY',
  'ACCOUNT',
  'COMPLIANCE',
  'MARKETING_SYSTEM'
]);

export const NOTIFICATION_CHANNELS = Object.freeze([
  'IN_APP',
  'PUSH',
  'EMAIL'
]);

/**
 * Authoritative runtime capability descriptor for each notification channel in the repository.
 * Does not claim external providers exist where only in-app or mock fallback is wired.
 */
export const CHANNEL_CAPABILITIES = Object.freeze({
  IN_APP: Object.freeze({
    channel: 'IN_APP',
    implemented: true,
    deliveryMode: 'POSTGRES_AND_SOCKET_OUTBOX',
    description: 'Persisted to PostgreSQL Notification table and delivered in real time via Socket.IO outbox drainer'
  }),
  PUSH: Object.freeze({
    channel: 'PUSH',
    implemented: false,
    deliveryMode: 'MOCK_FCM_FALLBACK',
    description: 'Outbox drainer logs offline push fallback ([MOCK FCM]); external FCM provider SDK is not wired'
  }),
  EMAIL: Object.freeze({
    channel: 'EMAIL',
    implemented: false,
    deliveryMode: 'TEMPLATE_ONLY',
    description: 'Supported in template schema and preview; no external email delivery provider is implemented in repository'
  })
});

export const TEMPLATE_CODE_REGEX = /^[A-Z][A-Z0-9_]{1,63}$/;
export const VARIABLE_NAME_REGEX = /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/;

export const FORBIDDEN_VARIABLE_NAMES = Object.freeze([
  '__proto__',
  'constructor',
  'prototype',
  'password',
  'passwordHash',
  'refreshToken',
  'refreshTokenHash',
  'secret',
  'secretEnc',
  'jwtSecret',
  'apiKey'
]);

/**
 * Canonical system notification codes from 03_BACKEND_SPEC.md and their mandatory variables.
 */
export const SYSTEM_TEMPLATE_REQUIRED_VARIABLES = Object.freeze({
  DEPOSIT_CONFIRMED: ['amount'],
  WITHDRAWAL_APPROVED: ['amount'],
  WITHDRAWAL_REJECTED: ['amount', 'reason'],
  CALLOUT_RECEIVED: ['challengerName', 'stakeAmount'],
  CALLOUT_ACCEPTED: ['opponentName', 'stakeAmount'],
  MATCH_FOUND: ['matchId', 'stakeAmount'],
  MATCH_ENDED_WIN: ['matchId', 'payoutAmount'],
  MATCH_ENDED_LOSS: ['matchId'],
  DISCONNECT_WARNING: ['graceSeconds'],
  ACCOUNT_SUSPENDED: ['reason']
});

/**
 * Unsafe HTML / XSS / injection patterns rejected in template titles and bodies.
 */
const UNSAFE_CONTENT_PATTERNS = [
  { regex: /<\s*\/?\s*[a-zA-Z!][^>]*>/i, reason: 'Raw HTML tags are not permitted in notification templates' },
  { regex: /javascript\s*:/i, reason: 'javascript: URIs are not permitted in notification templates' },
  { regex: /vbscript\s*:/i, reason: 'vbscript: URIs are not permitted in notification templates' },
  { regex: /data\s*:\s*text\/html/i, reason: 'data:text/html payloads are not permitted' },
  { regex: /\bon[a-z]+\s*=/i, reason: 'Inline event handler attributes are not permitted' },
  { regex: /\$\{[^}]*\}/, reason: 'JavaScript template literal expressions (${...}) are not permitted; use {{variableName}}' }
];

/**
 * Safer-play compliance: predatory / loss-chasing phrases that are prohibited in player notifications.
 */
const PREDATORY_GAMBLING_PATTERNS = [
  /win\s+back\s+your\s+loss/i,
  /chase\s+your\s+loss/i,
  /recover\s+your\s+lost/i,
  /guaranteed\s+win/i,
  /risk[-\s]?free\s+(bet|wager|stake)/i,
  /double\s+your\s+money\s+now/i
];

/**
 * Inspects template text for unsafe HTML/script injection or prohibited loss-chasing language.
 *
 * @param {string} text
 * @returns {{ safe: boolean, issues: string[] }}
 */
export function validateSafeTemplateContent(text) {
  if (typeof text !== 'string') {
    return { safe: false, issues: ['Template content must be a string'] };
  }

  const issues = [];

  for (const rule of UNSAFE_CONTENT_PATTERNS) {
    if (rule.regex.test(text)) {
      issues.push(rule.reason);
    }
  }

  for (const pattern of PREDATORY_GAMBLING_PATTERNS) {
    if (pattern.test(text)) {
      issues.push('Predatory or loss-chasing promotional language is prohibited by safer-play policy');
      break;
    }
  }

  return {
    safe: issues.length === 0,
    issues
  };
}

/**
 * Parses `{{variableName}}` placeholders from a template string and validates syntax.
 * Rejects unclosed `{{`, unmatched `}}`, nested braces, empty `{{}}`, or forbidden variable names.
 *
 * @param {string} text
 * @returns {{ valid: boolean, variables: string[], errors: string[] }}
 */
export function parseTemplatePlaceholders(text) {
  if (typeof text !== 'string') {
    return { valid: false, variables: [], errors: ['Template text must be a string'] };
  }

  const errors = [];
  const variables = [];

  let i = 0;
  while (i < text.length) {
    const openIdx = text.indexOf('{{', i);
    const closeIdx = text.indexOf('}}', i);

    if (closeIdx !== -1 && (openIdx === -1 || closeIdx < openIdx)) {
      errors.push(`Unmatched closing '}}' at position ${closeIdx}`);
      break;
    }

    if (openIdx === -1) {
      // Check for stray single '{' or '}' that could be malformed placeholders
      break;
    }

    const matchingClose = text.indexOf('}}', openIdx + 2);
    if (matchingClose === -1) {
      errors.push(`Unclosed '{{' placeholder starting at position ${openIdx}`);
      break;
    }

    const rawToken = text.slice(openIdx + 2, matchingClose);
    if (rawToken.includes('{{') || rawToken.includes('{') || rawToken.includes('}')) {
      errors.push(`Nested or malformed braces inside '{{${rawToken}}}'`);
    } else {
      const token = rawToken.trim();
      if (!token) {
        errors.push('Empty placeholder {{}} is not allowed');
      } else if (!VARIABLE_NAME_REGEX.test(token)) {
        errors.push(
          `Invalid placeholder variable '{{${token}}}': must start with a letter and contain only letters, digits, or underscores`
        );
      } else if (FORBIDDEN_VARIABLE_NAMES.includes(token)) {
        errors.push(`Forbidden variable name '{{${token}}}' is not allowed in notification templates`);
      } else if (!variables.includes(token)) {
        variables.push(token);
      }
    }

    i = matchingClose + 2;
  }

  return {
    valid: errors.length === 0,
    variables,
    errors
  };
}

/**
 * Escapes HTML special characters and strips control characters from a variable value
 * before interpolating it into a rendered notification.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function escapeVariableValue(value) {
  const str = String(value)
    // Strip ASCII control characters except standard space
    .replace(/[\u0000-\u001F\u007F]/g, '');

  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export const TemplateCodeSchema = z
  .string()
  .trim()
  .transform((v) => v.toUpperCase())
  .refine((v) => TEMPLATE_CODE_REGEX.test(v), {
    message:
      'Template code must be 2-64 characters, start with an uppercase letter, and contain only uppercase letters, digits, or underscores'
  });

export const VariableNameSchema = z
  .string()
  .trim()
  .refine((v) => VARIABLE_NAME_REGEX.test(v), {
    message: 'Variable name must start with a letter and contain only letters, digits, or underscores (max 64 chars)'
  })
  .refine((v) => !FORBIDDEN_VARIABLE_NAMES.includes(v), {
    message: 'Variable name is reserved or forbidden for security reasons'
  });

export const NotificationCategorySchema = z.enum(NOTIFICATION_CATEGORIES);
export const NotificationChannelSchema = z.enum(NOTIFICATION_CHANNELS);

export const CreateNotificationTemplateSchema = z
  .object({
    code: TemplateCodeSchema,
    title: z.string().trim().min(2, 'Title must be at least 2 characters').max(140, 'Title cannot exceed 140 characters'),
    bodyTemplate: z
      .string()
      .trim()
      .min(5, 'Body template must be at least 5 characters')
      .max(1000, 'Body template cannot exceed 1000 characters'),
    category: NotificationCategorySchema.default('TRANSACTIONAL'),
    channels: z
      .array(NotificationChannelSchema)
      .min(1, 'At least one notification channel is required')
      .default(['IN_APP'])
      .transform((arr) => Array.from(new Set(arr))),
    variables: z
      .array(VariableNameSchema)
      .default([])
      .transform((arr) => Array.from(new Set(arr))),
    isActive: z.boolean().default(true),
    changeReason: z
      .string()
      .trim()
      .min(5, 'A change reason of at least 5 characters is required')
      .max(500)
      .optional()
  })
  .superRefine((data, ctx) => {
    const titleSafety = validateSafeTemplateContent(data.title);
    for (const issue of titleSafety.issues) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['title'], message: issue });
    }

    const bodySafety = validateSafeTemplateContent(data.bodyTemplate);
    for (const issue of bodySafety.issues) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['bodyTemplate'], message: issue });
    }

    const titlePlaceholders = parseTemplatePlaceholders(data.title);
    for (const err of titlePlaceholders.errors) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['title'], message: err });
    }

    const bodyPlaceholders = parseTemplatePlaceholders(data.bodyTemplate);
    for (const err of bodyPlaceholders.errors) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['bodyTemplate'], message: err });
    }

    const referencedVars = Array.from(
      new Set([...titlePlaceholders.variables, ...bodyPlaceholders.variables])
    );

    // Every placeholder used in title or bodyTemplate must be declared in `variables`
    const undeclared = referencedVars.filter((v) => !data.variables.includes(v));
    if (undeclared.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['variables'],
        message: `Template references undeclared variable(s): ${undeclared.join(', ')}`
      });
    }

    // Every declared variable must be referenced in either title or bodyTemplate
    const unusedDeclared = data.variables.filter((v) => !referencedVars.includes(v));
    if (unusedDeclared.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['variables'],
        message: `Declared variable(s) not used in title or bodyTemplate: ${unusedDeclared.join(', ')}`
      });
    }

    // If this is a canonical system notification code, verify mandatory system variables are present
    const sysRequired = SYSTEM_TEMPLATE_REQUIRED_VARIABLES[data.code];
    if (sysRequired) {
      const missingSysVars = sysRequired.filter((reqVar) => !data.variables.includes(reqVar));
      if (missingSysVars.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['variables'],
          message: `System template '${data.code}' requires mandatory variable(s): ${missingSysVars.join(', ')}`
        });
      }
    }
  });

export const UpdateNotificationTemplateSchema = z
  .object({
    title: z.string().trim().min(2).max(140).optional(),
    bodyTemplate: z.string().trim().min(5).max(1000).optional(),
    category: NotificationCategorySchema.optional(),
    channels: z
      .array(NotificationChannelSchema)
      .min(1, 'At least one notification channel is required')
      .transform((arr) => Array.from(new Set(arr)))
      .optional(),
    variables: z
      .array(VariableNameSchema)
      .transform((arr) => Array.from(new Set(arr)))
      .optional(),
    isActive: z.boolean().optional(),
    changeReason: z
      .string()
      .trim()
      .min(5, 'A change reason of at least 5 characters is required')
      .max(500)
      .optional()
  })
  .refine(
    (data) =>
      data.title !== undefined ||
      data.bodyTemplate !== undefined ||
      data.category !== undefined ||
      data.channels !== undefined ||
      data.variables !== undefined ||
      data.isActive !== undefined,
    { message: 'At least one field must be provided to update a notification template' }
  );

/**
 * Default canonical notification templates matching 03_BACKEND_SPEC.md §Notifications.
 */
export const DEFAULT_NOTIFICATION_TEMPLATES = Object.freeze([
  {
    code: 'DEPOSIT_CONFIRMED',
    title: 'Deposit Confirmed',
    bodyTemplate: 'Your deposit of {{amount}} has been credited to your available balance.',
    category: 'TRANSACTIONAL',
    channels: ['IN_APP', 'PUSH'],
    variables: ['amount'],
    isActive: true
  },
  {
    code: 'WITHDRAWAL_APPROVED',
    title: 'Withdrawal Approved',
    bodyTemplate: 'Your withdrawal of {{amount}} has been approved and sent for processing.',
    category: 'TRANSACTIONAL',
    channels: ['IN_APP', 'PUSH'],
    variables: ['amount'],
    isActive: true
  },
  {
    code: 'WITHDRAWAL_REJECTED',
    title: 'Withdrawal Declined',
    bodyTemplate: 'Your withdrawal request for {{amount}} was declined: {{reason}}. Funds have been released to your balance.',
    category: 'TRANSACTIONAL',
    channels: ['IN_APP', 'PUSH'],
    variables: ['amount', 'reason'],
    isActive: true
  },
  {
    code: 'CALLOUT_RECEIVED',
    title: 'New Call-Out Challenge',
    bodyTemplate: '{{challengerName}} has issued a high-stakes call-out challenge for {{stakeAmount}}.',
    category: 'GAMEPLAY',
    channels: ['IN_APP', 'PUSH'],
    variables: ['challengerName', 'stakeAmount'],
    isActive: true
  },
  {
    code: 'CALLOUT_ACCEPTED',
    title: 'Call-Out Accepted',
    bodyTemplate: '{{opponentName}} accepted your call-out challenge for {{stakeAmount}}.',
    category: 'GAMEPLAY',
    channels: ['IN_APP', 'PUSH'],
    variables: ['opponentName', 'stakeAmount'],
    isActive: true
  },
  {
    code: 'MATCH_FOUND',
    title: 'Match Found',
    bodyTemplate: 'Match {{matchId}} is ready with a stake of {{stakeAmount}}.',
    category: 'GAMEPLAY',
    channels: ['IN_APP', 'PUSH'],
    variables: ['matchId', 'stakeAmount'],
    isActive: true
  },
  {
    code: 'MATCH_ENDED_WIN',
    title: 'You Won!',
    bodyTemplate: 'You won match {{matchId}}. Payout of {{payoutAmount}} has been credited.',
    category: 'GAMEPLAY',
    channels: ['IN_APP', 'PUSH'],
    variables: ['matchId', 'payoutAmount'],
    isActive: true
  },
  {
    code: 'MATCH_ENDED_LOSS',
    title: 'Match Ended',
    bodyTemplate: 'Match {{matchId}} has concluded.',
    category: 'GAMEPLAY',
    channels: ['IN_APP'],
    variables: ['matchId'],
    isActive: true
  },
  {
    code: 'DISCONNECT_WARNING',
    title: 'Connection Warning',
    bodyTemplate: 'Please reconnect within {{graceSeconds}} seconds to avoid forfeiting your active match.',
    category: 'GAMEPLAY',
    channels: ['IN_APP', 'PUSH'],
    variables: ['graceSeconds'],
    isActive: true
  },
  {
    code: 'ACCOUNT_SUSPENDED',
    title: 'Account Restriction Notice',
    bodyTemplate: 'Your account access has been restricted: {{reason}}.',
    category: 'COMPLIANCE',
    channels: ['IN_APP', 'EMAIL'],
    variables: ['reason'],
    isActive: true
  }
]);
