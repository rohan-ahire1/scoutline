import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeHtml } from './analyze.js';

const now = new Date().getFullYear();
const page = (body, finalUrl = 'https://example.test/') => analyzeHtml({ body, finalUrl, requestedUrl: finalUrl, statusCode: 200, latencyMs: 200 });
const ids = (out) => out.dated.signals.map(s => s.id);

test('flags a 2000s-era table site', () => {
  const out = page(`<html><head><title>Bob's Plumbing</title><meta name="generator" content="Microsoft FrontPage 4.0">
    <script src="/js/jquery-1.8.3.min.js"></script></head>
    <body><table width="800" bgcolor="#ffffff"><tr><td bgcolor="#003366"><font face="Arial"><center>Call 801-555-0134 today!</center></font></td></tr></table>
    <table width="800" cellpadding="0" border="0"><tr><td>Copyright © 2012 Bob's Plumbing</td></tr></table></body></html>`, 'http://bobsplumbing.test/');
  const found = ids(out);
  for (const id of ['stale-copyright', 'old-jquery', 'legacy-generator', 'table-layout', 'legacy-tags', 'no-viewport', 'no-https', 'phone-not-tappable', 'fixed-width']) {
    assert.ok(found.includes(id), `${id} missing from ${found}`);
  }
  assert.equal(out.dated.copyrightYear, 2012);
  assert.ok(out.dated.score >= 80, `score ${out.dated.score}`);
});

test('a modern site scores low', () => {
  const out = page(`<!doctype html><html><head><title>Wasatch Roofing | Salt Lake City Roofers</title>
    <meta name="viewport" content="width=device-width, initial-scale=1"><link href="https://fonts.googleapis.com/css2?family=Inter" rel="stylesheet">
    <script src="/_next/static/chunks/main.js"></script></head>
    <body><h1>Roofing</h1><a href="tel:+18015550134">(801) 555-0134</a><img srcset="a.webp 1x" loading="lazy"><img loading="lazy" src="b.avif">
    <footer>© ${now} Wasatch Roofing</footer></body></html>`);
  assert.equal(out.dated.score, 0, JSON.stringify(out.dated.signals));
  assert.ok(out.dated.modern.length >= 3);
});

test('detects placeholder, builder and agency credit', () => {
  const parked = page('<html><head><title>x</title></head><body>This domain is for sale! Contact HugeDomains.</body></html>');
  assert.equal(parked.dated.placeholder, 'parked');
  const builder = page(`<html><head><meta name="viewport" content="width=device-width"><title>Acme Electric</title></head>
    <body><img src="https://img1.wsimg.com/isteam/ip/logo.png"><p>Website by Blue Pine Media</p></body></html>`);
  assert.ok(builder.dated.builders.includes('GoDaddy Website Builder'));
  assert.ok(ids(builder).includes('diy-builder'));
  assert.equal(builder.dated.agencyCredit, 'Blue Pine Media');
});
