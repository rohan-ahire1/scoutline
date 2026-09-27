import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeHtml } from './analyze.js';

function fetchResult(body) {
  return { body, finalUrl: 'http://example.test/', requestedUrl: 'http://example.test/', statusCode: 200, latencyMs: 120 };
}

test('emails do not glue across element boundaries', () => {
  const out = analyzeHtml(fetchResult(
    '<html><head><title>T</title></head><body><h1>Contact</h1><a href="mailto:h@e.com">hello@ogden-roofing.example</a></body></html>'
  ));
  assert.ok(!out.emails.some((email) => email.startsWith('contact')), `glued email leaked: ${out.emails}`);
  assert.ok(out.emails.includes('hello@ogden-roofing.example'));
  assert.ok(out.emails.includes('h@e.com'));
});

test('basic signals still extract', () => {
  const out = analyzeHtml(fetchResult(
    '<html><head><title>Shop</title><meta name="viewport" content="width=device-width"></head><body><h1>Hi</h1><a href="tel:+1-555-0100">call</a></body></html>'
  ));
  assert.equal(out.title, 'Shop');
  assert.equal(out.h1, 'Hi');
  assert.equal(out.signals.viewport, true);
  assert.deepEqual(out.phones, ['+1-555-0100']);
});
