#!/usr/bin/env node

/**
 * Test script for PII detection patterns
 * Verifies that phone numbers, emails, credit cards, SSN, and API keys are detected
 */

const piiPatterns = {
  phoneNumber: /(?<!\w)(?:\+\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}(?!\w)|(?<!\w)\+\d{1,3}[-.\s]?\d{7,}(?!\w)/g,
  emailAddress: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
  creditCard: /\b(?:\d{4}[-\s]?){3}\d{4}\b|\b\d{15,16}\b/g,
  ssn: /\b\d{3}-\d{2}-\d{4}\b|\b\d{9}\b/g,
  apiKey: /(?:api[_-]?key|api[_-]?secret|token|bearer|auth[_-]?token|access[_-]?token)\s*[:=]\s*[a-zA-Z0-9._-]{20,}/gi,
  awsKeyId: /AKIA[0-9A-Z]{16}/g,
};

const testCases = [
  {
    message: 'call me at +1-555-123-4567',
    expected: 'phoneNumber',
  },
  {
    message: 'my email is john@example.com',
    expected: 'emailAddress',
  },
  {
    message: 'card: 4532-1234-5678-9010',
    expected: 'creditCard',
  },
  {
    message: 'SSN: 123-45-6789',
    expected: 'ssn',
  },
  {
    message: 'api_key=sk_live_abc123def456ghi789jkl0123',
    expected: 'apiKey',
  },
  {
    message: 'my AWS key is AKIA1234567890ABCDEF',
    expected: 'awsKeyId',
  },
  {
    message: 'contact: +923120517989',
    expected: 'phoneNumber',
  },
  {
    message: 'hello world',
    expected: null,
  },
];

let passed = 0;
let failed = 0;

testCases.forEach((test, index) => {
  let detected = null;

  for (const [patternName, pattern] of Object.entries(piiPatterns)) {
    if (pattern.test(test.message)) {
      detected = patternName;
      pattern.lastIndex = 0;
      break;
    }
  }

  const success = detected === test.expected;
  const status = success ? '✅' : '❌';

  console.log(`${status} Test #${index + 1}: "${test.message}"`);
  console.log(
    `   Expected: ${test.expected || 'null'}, Got: ${detected || 'null'}`
  );

  if (success) {
    passed++;
  } else {
    failed++;
  }
});

console.log(`\n📊 Results: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
