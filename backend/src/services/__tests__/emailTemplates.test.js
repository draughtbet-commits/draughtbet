import {
  welcomeEmail,
  passwordChangedEmail,
  kycVerifiedEmail,
  kycRejectedEmail,
  notificationEmail
} from '../emailTemplates.js';

const assertShape = (tpl) => {
  expect(typeof tpl.subject).toBe('string');
  expect(tpl.subject.length).toBeGreaterThan(0);
  expect(typeof tpl.text).toBe('string');
  expect(typeof tpl.html).toBe('string');
  expect(tpl.html).toContain('<html');
};

describe('emailTemplates', () => {
  it('welcome mentions the brand and greets by name', () => {
    const tpl = welcomeEmail({ name: 'Ada' });
    assertShape(tpl);
    expect(tpl.subject).toMatch(/Welcome to Draught Bet/);
    expect(tpl.text).toContain('Hi Ada');
  });

  it('welcome tolerates a missing name', () => {
    const tpl = welcomeEmail({});
    expect(tpl.text).toContain('Hi,');
  });

  it('password changed is a security alert', () => {
    const tpl = passwordChangedEmail({ name: 'Ada' });
    assertShape(tpl);
    expect(tpl.subject).toMatch(/password was changed/i);
    expect(tpl.text).toMatch(/did not change your password/i);
  });

  it('kyc verified confirms identity', () => {
    const tpl = kycVerifiedEmail({ name: 'Ada' });
    assertShape(tpl);
    expect(tpl.text).toMatch(/verification is complete/i);
  });

  it('kyc rejected includes the reason when given', () => {
    const tpl = kycRejectedEmail({ name: 'Ada', reason: 'Blurry photo' });
    assertShape(tpl);
    expect(tpl.text).toContain('Blurry photo');
    expect(tpl.text).toMatch(/start the verification again/i);
  });

  it('kyc rejected works without a reason', () => {
    const tpl = kycRejectedEmail({});
    assertShape(tpl);
    expect(tpl.text).not.toContain('Reason:');
  });

  it('notification email mirrors the title and message', () => {
    const tpl = notificationEmail({ name: 'Ada', title: 'Deposit Successful', message: 'You got ₦1,000.00' });
    assertShape(tpl);
    expect(tpl.subject).toContain('Deposit Successful');
    expect(tpl.text).toContain('₦1,000.00');
  });

  it('escapes HTML in user-controlled fields', () => {
    const tpl = notificationEmail({ name: '<script>', title: 'x', message: '<b>hi</b>' });
    expect(tpl.html).not.toContain('<script>');
    expect(tpl.html).toContain('&lt;script&gt;');
  });
});
