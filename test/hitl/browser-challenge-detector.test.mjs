import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  detectBrowserChallenge,
} = require('../../dist/middlewares/hitl/scoring/BrowserChallengeDetector.js');

test('detectBrowserChallenge', async (t) => {
  await t.test('returns none for non-browser tools', () => {
    const sig = detectBrowserChallenge('read', { url: 'captcha' });
    assert.equal(sig.level, 'none');
    assert.equal(sig.kind, 'unknown');
    assert.deepEqual(sig.reasons, []);
  });

  await t.test('returns none when no challenge markers present', () => {
    const sig = detectBrowserChallenge('navigate', { url: 'https://example.com/home' });
    assert.equal(sig.level, 'none');
  });

  await t.test('detects reCAPTCHA as likely captcha', () => {
    const sig = detectBrowserChallenge('navigate', {
      url: 'https://example.com',
      html: '<div class="g-recaptcha"></div>',
    });
    assert.equal(sig.level, 'likely');
    assert.equal(sig.kind, 'captcha');
    assert.ok(sig.reasons.length > 0);
  });

  await t.test('detects 2FA prompt', () => {
    const sig = detectBrowserChallenge('click', {
      selector: 'input[name="otp"]',
      context: 'Enter the verification code sent to your authenticator',
    });
    assert.ok(sig.level !== 'none');
    assert.equal(sig.kind, '2fa');
  });

  await t.test('detects mixed captcha + 2fa', () => {
    const sig = detectBrowserChallenge('evaluate', {
      script: 'hcaptcha recaptcha verification code two-factor',
    });
    assert.ok(['possible', 'likely'].includes(sig.level));
    assert.equal(sig.kind, 'mixed');
  });

  await t.test('iframe hint boosts captcha score', () => {
    const withIframe = detectBrowserChallenge('navigate', {
      html: '<iframe src="captcha.com"></iframe>',
    });
    assert.ok(withIframe.level !== 'none');
    assert.ok(withIframe.reasons.some((r) => r.includes('iframe')));
  });

  await t.test('uncertain human-check copy escalates with multiple markers', () => {
    const sig = detectBrowserChallenge('screenshot', {
      pageText:
        'Please verify that you are human. Additional verification required. Cloudflare security challenge.',
    });
    assert.ok(['possible', 'likely'].includes(sig.level));
  });

  await t.test('handles non-serializable params gracefully', () => {
    const circular = {};
    circular.self = circular;
    const sig = detectBrowserChallenge('navigate', circular);
    assert.equal(sig.level, 'none');
  });
});
