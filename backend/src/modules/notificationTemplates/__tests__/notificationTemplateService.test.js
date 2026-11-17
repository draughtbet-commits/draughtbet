import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import {
  NotificationTemplateService,
  TemplateValidationError,
  TemplateNotFoundError,
  TemplateConflictError
} from '../service.js';
import {
  parseTemplatePlaceholders,
  validateSafeTemplateContent,
  CHANNEL_CAPABILITIES
} from '../schema.js';

describe('NotificationTemplateService (Unit)', () => {
  let mockDb;

  beforeEach(() => {
    mockDb = {
      $transaction: jest.fn(async (cb) => cb(mockDb)),
      notificationTemplate: {
        findMany: jest.fn(),
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        upsert: jest.fn()
      },
      outboxEvent: {
        create: jest.fn().mockResolvedValue({ id: 'outbox-tpl-1' })
      },
      adminAuditLog: {
        create: jest.fn().mockResolvedValue({ id: 'audit-tpl-1' }),
        findMany: jest.fn(),
        count: jest.fn()
      }
    };
  });

  describe('Channel Capabilities', () => {
    it('reports honest runtime delivery capabilities without inventing unimplemented providers', () => {
      const capabilities = NotificationTemplateService.getChannelCapabilities();
      expect(capabilities).toHaveLength(3);
      expect(CHANNEL_CAPABILITIES.IN_APP.implemented).toBe(true);
      expect(CHANNEL_CAPABILITIES.IN_APP.deliveryMode).toBe('POSTGRES_AND_SOCKET_OUTBOX');
      expect(CHANNEL_CAPABILITIES.PUSH.implemented).toBe(false);
      expect(CHANNEL_CAPABILITIES.PUSH.deliveryMode).toBe('MOCK_FCM_FALLBACK');
      expect(CHANNEL_CAPABILITIES.EMAIL.implemented).toBe(false);
      expect(CHANNEL_CAPABILITIES.EMAIL.deliveryMode).toBe('TEMPLATE_ONLY');
    });
  });

  describe('Placeholder Parsing & Content Safety Validation', () => {
    it('extracts valid {{variable}} placeholders and rejects malformed braces or forbidden names', () => {
      const valid = parseTemplatePlaceholders('Hello {{userName}}, your deposit of {{amount}} succeeded.');
      expect(valid.valid).toBe(true);
      expect(valid.variables).toEqual(['userName', 'amount']);

      const unclosed = parseTemplatePlaceholders('Hello {{userName, welcome');
      expect(unclosed.valid).toBe(false);
      expect(unclosed.errors[0]).toMatch(/Unclosed/i);

      const nested = parseTemplatePlaceholders('Value: {{outer{{inner}}}}');
      expect(nested.valid).toBe(false);
      expect(nested.errors[0]).toMatch(/Nested or malformed/i);

      const forbidden = parseTemplatePlaceholders('Leak: {{passwordHash}}');
      expect(forbidden.valid).toBe(false);
      expect(forbidden.errors[0]).toMatch(/Forbidden variable/i);
    });

    it('rejects raw HTML, script tags, javascript: URIs, and predatory loss-chasing language', () => {
      expect(validateSafeTemplateContent('<script>alert(1)</script>').safe).toBe(false);
      expect(validateSafeTemplateContent('Click javascript:void(0)').safe).toBe(false);
      expect(validateSafeTemplateContent('Hello ${process.env.SECRET}').safe).toBe(false);
      expect(validateSafeTemplateContent('Deposit now to win back your losses!').safe).toBe(false);
      expect(validateSafeTemplateContent('Place a risk-free bet today!').safe).toBe(false);
      expect(
        validateSafeTemplateContent('Your withdrawal of {{amount}} has been approved.').safe
      ).toBe(true);
    });
  });

  describe('createTemplate & updateTemplate', () => {
    it('creates a valid notification template at version 1 and logs audit & outbox events', async () => {
      mockDb.notificationTemplate.findUnique.mockResolvedValueOnce(null);
      mockDb.notificationTemplate.create.mockImplementationOnce(async ({ data }) => ({
        id: 'tpl-1',
        ...data,
        createdAt: new Date(),
        updatedAt: new Date()
      }));

      const tpl = await NotificationTemplateService.createTemplate({
        code: 'DEPOSIT_CONFIRMED',
        title: 'Deposit Confirmed',
        bodyTemplate: 'Your deposit of {{amount}} has been credited to your wallet.',
        category: 'TRANSACTIONAL',
        channels: ['IN_APP', 'PUSH'],
        variables: ['amount'],
        changeReason: 'Seed canonical deposit confirmation template',
        actorId: 'admin-super-1',
        dbp: mockDb
      });

      expect(tpl.code).toBe('DEPOSIT_CONFIRMED');
      expect(tpl.version).toBe(1);
      expect(tpl.channelDetails).toHaveLength(2);
      expect(mockDb.outboxEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            aggregateType: 'NotificationTemplate',
            eventType: 'platform.notification_template.updated'
          })
        })
      );
      expect(mockDb.adminAuditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: 'notification_template.created',
            targetType: 'NotificationTemplate'
          })
        })
      );
    });

    it('rejects system templates missing canonical required variables', async () => {
      // WITHDRAWAL_REJECTED requires ['amount', 'reason']
      await expect(
        NotificationTemplateService.createTemplate({
          code: 'WITHDRAWAL_REJECTED',
          title: 'Withdrawal Declined',
          bodyTemplate: 'Your withdrawal of {{amount}} was declined.',
          category: 'TRANSACTIONAL',
          channels: ['IN_APP'],
          variables: ['amount'], // missing 'reason'
          changeReason: 'Attempt omitting required reason variable',
          actorId: 'admin-1',
          dbp: mockDb
        })
      ).rejects.toThrow(TemplateValidationError);
    });

    it('rejects templates where placeholders and declared variables do not match', async () => {
      await expect(
        NotificationTemplateService.createTemplate({
          code: 'CUSTOM_NOTICE',
          title: 'Notice for {{playerName}}',
          bodyTemplate: 'Your match {{matchId}} starts soon.',
          category: 'GAMEPLAY',
          channels: ['IN_APP'],
          variables: ['playerName'], // missing 'matchId' in declared variables
          changeReason: 'Mismatched variables test',
          actorId: 'admin-1',
          dbp: mockDb
        })
      ).rejects.toThrow(TemplateValidationError);
    });

    it('increments template version on update and records before/after snapshots in AdminAuditLog', async () => {
      const existing = {
        id: 'tpl-existing-1',
        code: 'DEPOSIT_CONFIRMED',
        title: 'Deposit Confirmed',
        bodyTemplate: 'Your deposit of {{amount}} has been credited.',
        category: 'TRANSACTIONAL',
        channels: ['IN_APP'],
        variables: ['amount'],
        isActive: true,
        version: 1
      };

      mockDb.notificationTemplate.findUnique.mockResolvedValueOnce(existing);
      mockDb.notificationTemplate.update.mockImplementationOnce(async ({ data }) => ({
        ...existing,
        ...data,
        updatedAt: new Date()
      }));

      const updated = await NotificationTemplateService.updateTemplate({
        codeOrId: 'DEPOSIT_CONFIRMED',
        updates: {
          bodyTemplate: 'Deposit of {{amount}} via {{gateway}} is now available in your wallet.',
          variables: ['amount', 'gateway'],
          channels: ['IN_APP', 'PUSH']
        },
        changeReason: 'Add gateway name to deposit confirmation message',
        actorId: 'admin-super-1',
        dbp: mockDb
      });

      expect(updated.version).toBe(2);
      expect(updated.variables).toEqual(['amount', 'gateway']);
      expect(mockDb.adminAuditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: 'notification_template.updated',
            metadata: expect.objectContaining({
              code: 'DEPOSIT_CONFIRMED',
              previousVersion: 1,
              version: 2,
              changeReason: 'Add gateway name to deposit confirmation message'
            })
          })
        })
      );
    });
  });

  describe('renderTemplate & previewSavedTemplate', () => {
    it('renders valid templates and escapes HTML/XSS in variable values without recursive evaluation', () => {
      const rendered = NotificationTemplateService.renderTemplate({
        code: 'WITHDRAWAL_REJECTED',
        title: 'Withdrawal of {{amount}} Declined',
        bodyTemplate: 'Reason: {{reason}}',
        variables: ['amount', 'reason'],
        channels: ['IN_APP'],
        sampleValues: {
          amount: '₦25,000',
          reason: '<script>alert("xss")</script> & {{amount}}'
        },
        version: 3
      });

      expect(rendered.renderedTitle).toBe('Withdrawal of ₦25,000 Declined');
      // HTML tags are escaped AND {{amount}} inside reason is NOT recursively expanded
      expect(rendered.renderedBody).toBe(
        'Reason: &lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt; &amp; {{amount}}'
      );
      expect(rendered.version).toBe(3);
    });

    it('throws TemplateValidationError with missingVariables when required variables are omitted or empty', () => {
      expect(() =>
        NotificationTemplateService.renderTemplate({
          code: 'MATCH_ENDED_WIN',
          title: 'You Won!',
          bodyTemplate: 'Match {{matchId}} settled. Payout: {{payoutAmount}}.',
          variables: ['matchId', 'payoutAmount'],
          sampleValues: {
            matchId: 'm-12345'
            // payoutAmount omitted
          }
        })
      ).toThrow(TemplateValidationError);

      try {
        NotificationTemplateService.renderTemplate({
          code: 'MATCH_ENDED_WIN',
          title: 'You Won!',
          bodyTemplate: 'Match {{matchId}} settled. Payout: {{payoutAmount}}.',
          variables: ['matchId', 'payoutAmount'],
          sampleValues: {
            matchId: 'm-12345',
            payoutAmount: '   '
          }
        });
      } catch (err) {
        expect(err).toBeInstanceOf(TemplateValidationError);
        expect(err.missingVariables).toEqual(['payoutAmount']);
      }
    });
  });
});
