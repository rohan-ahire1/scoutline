import { config } from './config.js';
import { fetchPage } from './fetchPage.js';
import { analyzeHtml } from './analyze.js';
import { classifyWebsiteType } from './state.js';

const USEFUL_PATTERNS = [
  /\/contact(?:[-_/]|$)/i,
  /\/about(?:[-_/]|$)/i,
  /\/services?(?:[-_/]|$)/i,
  /\/products?(?:[-_/]|$)/i,
  /\/collections?(?:[-_/]|$)/i,
  /\/pricing(?:[-_/]|$)/i,
  /\/locations?(?:[-_/]|$)/i
];

function normalizeInternal(urlString, origin) {
  try {
    const url = new URL(urlString);
    if (url.origin !== origin) return null;
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    if (/\.(?:jpg|jpeg|png|gif|webp|svg|avif|ico|mp4|mov|avi|webm|mp3|wav|pdf|zip|css|js|woff2?|ttf|eot)(?:$|\?)/i.test(url.pathname)) return null;
    url.hash = '';
    url.search = '';
    return url.toString();
  } catch {
    return null;
  }
}

function chooseUsefulPages(homeAnalysis, homeUrl) {
  const origin = new URL(homeUrl).origin;
  const candidates = [];
  for (const raw of homeAnalysis?.links || []) {
    const normalized = normalizeInternal(raw, origin);
    if (!normalized || normalized === homeUrl) continue;
    const score = USEFUL_PATTERNS.findIndex(pattern => pattern.test(new URL(normalized).pathname));
    if (score >= 0) candidates.push({ url: normalized, rank: score });
  }
  const unique = [...new Map(candidates.map(x => [x.url, x])).values()];
  unique.sort((a, b) => a.rank - b.rank || a.url.length - b.url.length);
  return unique.slice(0, Math.max(0, config.maxPagesPerDomain - 1)).map(x => x.url);
}

export async function crawlSite(homeUrl) {
  const pages = [];
  const homeFetched = await fetchPage(homeUrl);
  const homeIsHtml = !homeFetched.blockedByRobots && (homeFetched.contentType || '').toLowerCase().includes('text/html');
  const homeAnalysis = homeIsHtml ? analyzeHtml(homeFetched) : null;
  pages.push({ fetched: homeFetched, analysis: homeAnalysis, kind: 'home' });

  if (!homeAnalysis) return pages;

  const finalHome = homeFetched.finalUrl || homeFetched.requestedUrl;
  for (const url of chooseUsefulPages(homeAnalysis, finalHome)) {
    try {
      const fetched = await fetchPage(url);
      const isHtml = !fetched.blockedByRobots && (fetched.contentType || '').toLowerCase().includes('text/html');
      const analysis = isHtml ? analyzeHtml(fetched) : null;
      pages.push({ fetched, analysis, kind: 'detail' });
    } catch (error) {
      pages.push({ fetched: { requestedUrl: url, fetchError: String(error) }, analysis: null, kind: 'detail' });
    }
  }

  return pages;
}

export function aggregateSite(pages) {
  const analyzed = pages.filter(p => p.analysis);
  const home = analyzed[0]?.analysis || null;
  if (!home) return null;

  const uniq = xs => [...new Set(xs.filter(Boolean))];
  const emails = uniq(analyzed.flatMap(p => p.analysis.emails || [])).slice(0, 50);
  const phones = uniq(analyzed.flatMap(p => p.analysis.phones || [])).slice(0, 50);
  const socialLinks = uniq(analyzed.flatMap(p => p.analysis.socialLinks || [])).slice(0, 50);
  const addresses = uniq(analyzed.map(p => p.analysis.address)).slice(0, 10);
  const structuredTypes = uniq(analyzed.flatMap(p => p.analysis.structuredTypes || [])).slice(0, 50);
  const visualRiskScore = Math.max(...analyzed.map(p => p.analysis.visualRisk?.score || 0));
  const opportunityScore = Math.max(...analyzed.map(p => p.analysis.opportunityScore || 0));

  const tech = analyzed.reduce((acc, p) => {
    for (const [key, value] of Object.entries(p.analysis.tech || {})) {
      if (typeof value === 'boolean') acc[key] = Boolean(acc[key] || value);
      else if (key === 'staticConfidence') acc[key] = Math.max(acc[key] || 0, Number(value) || 0);
    }
    return acc;
  }, {});
  tech.staticCandidate = Boolean(tech.staticCandidate);

  const eligible = Boolean(
    tech.shopify ||
    tech.staticCandidate ||
    visualRiskScore >= config.visualRiskEligibilityThreshold
  );
  const eligibilityReasons = [];
  if (tech.shopify) eligibilityReasons.push('shopify');
  if (tech.staticCandidate) eligibilityReasons.push('static_candidate');
  if (visualRiskScore >= config.visualRiskEligibilityThreshold) eligibilityReasons.push('high_visual_risk');

  const websiteType = classifyWebsiteType(tech);

  return {
    ...home,
    websiteType,
    emails,
    phones,
    socialLinks,
    addresses,
    structuredTypes,
    tech,
    visualRisk: {
      score: visualRiskScore,
      reasons: uniq(analyzed.flatMap(p => p.analysis.visualRisk?.reasons || [])).slice(0, 30)
    },
    eligible,
    eligibilityReasons,
    opportunityScore,
    pagesInspected: pages.length,
    pages: pages.map(p => ({
      kind: p.kind,
      requestedUrl: p.fetched.requestedUrl,
      finalUrl: p.fetched.finalUrl || null,
      statusCode: p.fetched.statusCode || null,
      latencyMs: p.fetched.latencyMs || null,
      responseBytes: p.fetched.responseBytes || null,
      title: p.analysis?.title || null,
      h1: p.analysis?.h1 || null,
      textExcerpt: p.analysis?.textExcerpt || null,
      textLength: p.analysis?.textLength || 0,
      fetchError: p.fetched.fetchError || null
    }))
  };
}
