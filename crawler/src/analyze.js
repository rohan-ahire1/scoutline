import * as cheerio from 'cheerio';
import { config } from './config.js';
import { extractEmails, extractOwnerNames, isFamilyOwned } from './contacts.js';
import { detectDated } from './dated.js';

function uniq(values) {
  return [...new Set(values.filter(Boolean))];
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function text($, selector, max = 500) {
  return $(selector).first().text().replace(/\s+/g, ' ').trim().slice(0, max) || null;
}

function attr($, selector, name, max = 1000) {
  return $(selector).first().attr(name)?.trim().slice(0, max) || null;
}

function parseJsonLd($) {
  const rows = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const parsed = JSON.parse($(el).text());
      if (Array.isArray(parsed)) rows.push(...parsed);
      else if (parsed?.['@graph']) rows.push(...parsed['@graph']);
      else if (parsed) rows.push(parsed);
    } catch {}
  });
  return rows;
}

function extractAddress(jsonLd) {
  for (const item of jsonLd) {
    const address = item?.address;
    if (!address) continue;
    if (typeof address === 'string') return address.slice(0, 1000);
    const parts = [address.streetAddress, address.addressLocality, address.addressRegion, address.postalCode, address.addressCountry].filter(Boolean);
    if (parts.length) return parts.join(', ').slice(0, 1000);
  }
  return null;
}

function classifyTech(rawHtml, $, finalUrl) {
  const lower = rawHtml.toLowerCase();
  const scriptSrcs = $('script[src]').map((_, el) => $(el).attr('src') || '').get();
  const dynamicMarkers = [
    '__next_data__', '_next/static', '__nuxt__', '/wp-json/', 'drupalsettings',
    'woocommerce', 'magento', 'prestashop', 'bigcommerce', 'salesforce commerce'
  ];

  const tech = {
    shopify: lower.includes('cdn.shopify.com') || lower.includes('shopify.theme') || lower.includes('shopify-section'),
    wordpress: lower.includes('wp-content/') || lower.includes('wp-includes/'),
    woocommerce: lower.includes('woocommerce'),
    wix: lower.includes('wixstatic.com'),
    squarespace: lower.includes('static1.squarespace.com') || lower.includes('squarespace.com'),
    webflow: lower.includes('webflow.js') || lower.includes('webflow.com'),
    nextjs: lower.includes('__next_data__') || lower.includes('_next/static'),
    nuxt: lower.includes('__nuxt__') || lower.includes('/_nuxt/'),
    react: lower.includes('data-reactroot') || lower.includes('react-dom'),
    angular: lower.includes('ng-version='),
    drupal: lower.includes('drupalsettings') || lower.includes('/sites/default/files/'),
    magento: lower.includes('mage/cookies') || lower.includes('magento'),
    bigcommerce: lower.includes('cdn11.bigcommerce.com') || lower.includes('bigcommerce')
  };

  const knownDynamic = Object.entries(tech).some(([key, value]) => value && !['webflow'].includes(key));
  const scriptCount = scriptSrcs.length;
  const formsCount = $('form').length;
  const appRoot = $('#app,#root,[data-reactroot],[ng-version]').length > 0;
  const dynamicMarkerCount = dynamicMarkers.filter(marker => lower.includes(marker)).length;

  // Conservative heuristic: "staticCandidate" means likely simple brochure/static marketing site,
  // not a guarantee about its hosting/build system.
  let staticConfidence = 0;
  if (!knownDynamic) staticConfidence += 45;
  if (scriptCount <= 5) staticConfidence += 25;
  else if (scriptCount <= 10) staticConfidence += 10;
  if (formsCount <= 1) staticConfidence += 10;
  if (!appRoot) staticConfidence += 10;
  if (dynamicMarkerCount === 0) staticConfidence += 10;
  if (new URL(finalUrl).pathname === '/' || new URL(finalUrl).pathname === '') staticConfidence += 0;

  staticConfidence = clamp(staticConfidence, 0, 100);
  tech.staticCandidate = staticConfidence >= 70;
  tech.staticConfidence = staticConfidence;
  return tech;
}

function visualRiskHeuristics(rawHtml, $, signals, fetchResult) {
  const lower = rawHtml.toLowerCase();
  const bodyText = $('body').text().replace(/\s+/g, ' ').trim();
  const allElements = $('*').length;
  const images = $('img').length;
  const imagesWithoutAlt = $('img:not([alt]), img[alt=""]').length;
  const inlineStyles = $('[style]').length;
  const tables = $('table').length;
  const deprecated = $('font,center,marquee,blink,frameset,frame').length;
  const buttonsOrCtas = $('button,a.btn,a.button,input[type="submit"]').length;
  const headings = $('h1,h2,h3').length;
  const veryLongParagraphs = $('p').filter((_, el) => $(el).text().trim().length > 500).length;
  const tinyFontInline = $('[style*="font-size"]').filter((_, el) => {
    const s = ($(el).attr('style') || '').toLowerCase();
    const m = s.match(/font-size\s*:\s*([0-9.]+)(px|pt)/);
    return m ? Number(m[1]) < (m[2] === 'pt' ? 8 : 11) : false;
  }).length;
  const oldDoctype = !/^\s*<!doctype html>/i.test(rawHtml);
  const hasFlash = lower.includes('application/x-shockwave-flash') || lower.includes('.swf');

  let risk = 0;
  const reasons = [];
  const add = (points, reason) => { risk += points; reasons.push(reason); };

  if (!signals.viewport) add(22, 'missing_mobile_viewport');
  if (deprecated > 0) add(Math.min(20, 8 + deprecated * 2), 'deprecated_layout_elements');
  if (tables >= 4) add(8, 'many_tables_possible_legacy_layout');
  if (oldDoctype) add(5, 'non_html5_doctype');
  if (hasFlash) add(20, 'flash_content');
  if (allElements > 2500) add(7, 'very_dense_dom');
  if (inlineStyles > 80) add(8, 'heavy_inline_styling');
  if (images >= 4 && imagesWithoutAlt / images > 0.7) add(4, 'most_images_missing_alt');
  if (tinyFontInline > 0) add(8, 'very_small_inline_text');
  if (veryLongParagraphs >= 3) add(5, 'dense_long_copy');
  if (bodyText.length > 2500 && headings < 2) add(6, 'weak_content_hierarchy');
  if (bodyText.length > 1500 && buttonsOrCtas === 0) add(4, 'no_obvious_cta');
  if ((fetchResult.latencyMs || 0) > 3000) add(7, 'slow_response');
  else if ((fetchResult.latencyMs || 0) > 1800) add(3, 'moderately_slow_response');
  if (!signals.hasTitle) add(4, 'missing_title');
  if (!signals.hasH1) add(4, 'missing_h1');

  return {
    score: clamp(risk, 0, 100),
    reasons: uniq(reasons).slice(0, 20),
    metrics: {
      elements: allElements,
      images,
      imagesWithoutAlt,
      inlineStyles,
      tables,
      deprecatedElements: deprecated,
      headings,
      ctas: buttonsOrCtas,
      longParagraphs: veryLongParagraphs
    }
  };
}

export function analyzeHtml(fetchResult) {
  const html = fetchResult.body || '';
  const $ = cheerio.load(html);
  const base = new URL(fetchResult.finalUrl || fetchResult.requestedUrl);

  const title = text($, 'title');
  const metaDescription = attr($, 'meta[name="description"]', 'content');
  const h1 = text($, 'h1');
  const viewport = attr($, 'meta[name="viewport"]', 'content');
  const canonical = attr($, 'link[rel="canonical"]', 'href');
  const lang = $('html').attr('lang')?.trim().slice(0, 50) || null;

  const links = [];
  let internal = 0;
  let external = 0;
  const socialLinks = [];
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    try {
      const u = new URL(href, base);
      if (!['http:', 'https:'].includes(u.protocol)) return;
      u.hash = '';
      links.push(u.toString());
      if (u.host === base.host) internal += 1;
      else external += 1;
      if (/facebook\.com|instagram\.com|linkedin\.com|twitter\.com|x\.com|youtube\.com|tiktok\.com/i.test(u.host)) socialLinks.push(u.toString());
    } catch {}
  });

  const bodyClone = cheerio.load(html);
  bodyClone('script,style,noscript,svg,template').remove();
  // Separate text at element boundaries so extraction never glues words
  // across tags (e.g. "<h1>Contact</h1><a>hello@x.io</a>" -> "contacthello@x.io").
  bodyClone('a,p,li,div,h1,h2,h3,h4,h5,h6,br,tr,td,section,article,header,footer,nav,span').after(' ');
  const visibleText = bodyClone('body').text().replace(/\s+/g, ' ').trim();

  const phones = uniq(
    $('a[href^="tel:"]').map((_, el) => ($(el).attr('href') || '').replace(/^tel:/i, '').trim()).get()
  ).slice(0, 30);

  const jsonLd = parseJsonLd($);
  const emailEntries = extractEmails($, visibleText, jsonLd).slice(0, 30);
  const emails = emailEntries.map(entry => entry.email);
  const owners = extractOwnerNames(visibleText);
  const dated = detectDated({
    rawHtml: html, $, visibleText,
    finalUrl: fetchResult.finalUrl || fetchResult.requestedUrl,
    headers: fetchResult.headers || {}
  });
  const structuredTypes = uniq(jsonLd.flatMap(row => {
    const t = row?.['@type'];
    return Array.isArray(t) ? t : [t];
  })).slice(0, 30);
  const address = extractAddress(jsonLd);
  const tech = classifyTech(html, $, fetchResult.finalUrl || fetchResult.requestedUrl);

  const signals = {
    https: base.protocol === 'https:',
    viewport: Boolean(viewport),
    hasTitle: Boolean(title),
    hasMetaDescription: Boolean(metaDescription),
    hasH1: Boolean(h1),
    hasEmail: emails.length > 0,
    hasPhone: phones.length > 0,
    hasAddress: Boolean(address),
    hasForm: $('form').filter((_, el) => $(el).find('input:not([type=hidden]), textarea').length >= 2).length > 0,
    statusOk: (fetchResult.statusCode || 0) >= 200 && (fetchResult.statusCode || 0) < 400
  };

  const visualRisk = visualRiskHeuristics(html, $, signals, fetchResult);
  const eligible = Boolean(
    tech.shopify ||
    tech.staticCandidate ||
    visualRisk.score >= config.visualRiskEligibilityThreshold
  );
  const eligibilityReasons = [];
  if (tech.shopify) eligibilityReasons.push('shopify');
  if (tech.staticCandidate) eligibilityReasons.push('static_candidate');
  if (visualRisk.score >= config.visualRiskEligibilityThreshold) eligibilityReasons.push('high_visual_risk');

  let opportunityScore = 0;
  if (!signals.statusOk) opportunityScore += 20;
  if (!signals.https) opportunityScore += 8;
  if (!signals.viewport) opportunityScore += 8;
  if (!signals.hasTitle) opportunityScore += 5;
  if (!signals.hasMetaDescription) opportunityScore += 4;
  if (!signals.hasH1) opportunityScore += 4;
  if ((fetchResult.latencyMs || 0) > 3000) opportunityScore += 8;
  else if ((fetchResult.latencyMs || 0) > 1500) opportunityScore += 4;
  opportunityScore += Math.round(visualRisk.score * 0.35);
  if (tech.shopify) opportunityScore += 8;
  if (tech.staticCandidate) opportunityScore += 5;
  if (!eligible) opportunityScore = Math.min(opportunityScore, 39);

  return {
    title,
    metaDescription,
    h1,
    canonical,
    lang,
    textLength: visibleText.length,
    textExcerpt: visibleText.slice(0, config.maxTextCharsPerPage),
    links: uniq(links),
    linksCount: links.length,
    internalLinksCount: internal,
    externalLinksCount: external,
    emails,
    emailEntries,
    owners,
    familyOwned: isFamilyOwned(visibleText),
    dated,
    phones,
    socialLinks: uniq(socialLinks).slice(0, 30),
    address,
    structuredTypes,
    tech,
    signals,
    visualRisk,
    eligible,
    eligibilityReasons,
    opportunityScore: clamp(opportunityScore, 0, 100)
  };
}
