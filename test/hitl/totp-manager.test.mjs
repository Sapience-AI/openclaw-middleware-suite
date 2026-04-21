import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { rmSync } from 'node:fs';
import { createOpenclawHome } from '../_helpers/test-env.mjs';

const tempDir = createOpenclawHome('sapience-mw-totp-tests-');

const require = createRequire(import.meta.url);
const { TotpManager } = require('../../dist/middlewares/hitl/approval/TotpManager.js');
const { TOTP, Secret } = require('otpauth');

test('TotpManager tests', async (t) => {
  t.after(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  await t.test('generateSecret returns a valid base32 string', () => {
    const { secret, manualSetupCode } = TotpManager.generateSecret();
    assert.equal(typeof secret, 'string');
    assert.equal(secret, manualSetupCode);
    assert.equal(secret.length > 10, true);
    assert.doesNotThrow(() => Secret.fromBase32(secret));
  });

  await t.test('isConfigured is false initially', () => {
    assert.equal(TotpManager.isConfigured(), false);
  });

  await t.test('saveSecret and loadSecret', () => {
    const { secret } = TotpManager.generateSecret();
    TotpManager.saveSecret(secret);
    
    assert.equal(TotpManager.isConfigured(), true);
    const loaded = TotpManager.loadSecret();
    assert.ok(loaded);
    assert.equal(loaded.secret, secret);
    assert.equal(loaded.issuer, 'SapienceMiddleware');
    assert.equal(loaded.account, 'openclaw-user');
    
    assert.equal(TotpManager.getManualSetupCode(), secret);
  });

  await t.test('verifyCode accepts correct code and rejects invalid code', () => {
    const { secret } = TotpManager.generateSecret();
    TotpManager.saveSecret(secret);

    const totp = new TOTP({
      issuer: 'SapienceMiddleware',
      label: 'openclaw-user',
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
      secret: Secret.fromBase32(secret)
    });
    
    const validCode = totp.generate();
    assert.equal(TotpManager.verifyCode(validCode), true);
    
    // Using string because code usually parsed from input is string and should be 6 chars.
    assert.equal(TotpManager.verifyCode('000000'), false);
    assert.equal(TotpManager.verifyCode('invalid'), false);
  });
});
