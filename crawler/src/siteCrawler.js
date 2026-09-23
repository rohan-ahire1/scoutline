import { config } from './config.js';
import { fetchPage } from './fetchPage.js';
import { analyzeHtml } from './analyze.js';
import { classifyWebsiteType } from './state.js';
import { rankEmails } from './contacts.js';
import { modernOffset } from './dated.js';

const USEFUL_PATTERNS = [
  /\/contact(?:[-_/]|$)/i,
  /\/about(?:[-_/]|$)/i,
  /\/(?:our-)?(?:team|story|company)(?:[-_/]|$)|\/meet-/i,
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

function describeFetchError(error) {
  const cause = error?.cause || {};
  const code = cause.code || error?.code || null;
  const message = String(cause.message || error?.message || error || 'fetch failed');
  let kind = 'network';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || /getaddrinfo|could not resolve/i.test(message)) kind = 'dns';
  else if (/CERT|SSL|TLS|ERR_TLS|self[- ]signed|altname|certificate/i.test(`${code} ${message}`)) kind = 'tls';
  else if (error?.name === 'AbortError' || /abort|timeout/i.test(message)) kind = 'timeout';
  return { kind, code, message: message.slice(0, 300) };
}

// Owners mistype their own URL on Google all the time, and cheap hosting
// often has a broken certificate on one of www/apex. Try the variants before
// declaring a site unreachable, and keep what failed as evidence.
function homeVariants(homeUrl) {
  const url = new URL(homeUrl);
  const apex = url.hostname.replace(/^www\./, '');
  const hosts = [url.hostname, url.hostname.startsWith('www.') ? apex : `www.${apex}`];
  const out = [];
  for (const protocol of ['https:', 'http:']) for (const host of hosts) out.push(`${protocol}//${host}${url.pathname}${url.search}`);
  return [...new Set([homeUrl, ...out])];
}

export async function fetchHome(homeUrl, fetcher = fetchPage) {
  const attempts = [];
  for (const candidate of homeVariants(homeUrl)) {
    try {
      const fetched = await fetcher(candidate);
      if (attempts.length) fetched.fallback = { from: homeUrl, attempts };
      return fetched;
    } catch (error) {
      const failure = describeFetchError(error);
      attempts.push({ url: candidate, ...failure });
      // A missing domain will not resolve under any variant of the same host.
      if (failure.kind === 'dns' && attempts.filter(a => a.kind === 'dns').length >= 2) break;
    }
  }
  const err = new Error(attempts.map(a => `${a.url}: ${a.kind}`).join('; '));
  err.attempts = attempts;
  err.kind = attempts.every(a => a.kind === 'dns') ? 'dns' : attempts.some(a => a.kind === 'tls') ? 'tls' : attempts[attempts.length - 1]?.kind || 'network';
  throw err;
}

export async function crawlSite(homeUrl) {
  const pages = [];
  const homeFetched = await fetchHome(homeUrl);
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
  const byEmail = new Map();
  for (const p of analyzed) {
    for (const e of p.analysis.emailEntries || []) {
      if (!byEmail.has(e.email)) byEmail.set(e.email, { ...e, page: p.fetched.finalUrl || p.fetched.requestedUrl });
    }
  }
  const emailEntries = [...byEmail.values()];
  const emails = emailEntries.map(e => e.email).slice(0, 50);
  const owners = [...new Map(analyzed.flatMap(p => (p.analysis.owners || []).map(o => [o.name, o]))).values()].slice(0, 5);
  const homeHost = (() => { try { return new URL(pages[0].fetched.finalUrl || pages[0].fetched.requestedUrl).host; } catch { return ''; } })();
  const rankedEmails = rankEmails(emailEntries, { siteHost: homeHost, ownerNames: owners }).slice(0, 20);
  // The homepage decides how the site looks; other pages only add a newer
  // copyright year or a signal the homepage lacked.
  const dated = home.dated ? { ...home.dated } : null;
  const fallback = pages[0]?.fetched?.fallback;
  if (dated && fallback?.attempts?.some(a => a.kind === 'tls')) {
    const tls = fallback.attempts.find(a => a.kind === 'tls');
    // The http:// fallback is a symptom of the broken certificate, not a second finding.
    dated.signals = dated.signals.filter(s => s.id !== 'no-https');
    dated.signals = [{ id: 'broken-https', label: 'HTTPS certificate is broken: visitors get a security warning', evidence: `${tls.url}: ${tls.message}`, weight: 22 }, ...dated.signals];
  }
  if (dated) {
    const years = analyzed.map(p => p.analysis.dated?.copyrightYear).filter(Boolean);
    if (years.length) dated.copyrightYear = Math.max(...years);
    if (dated.copyrightYear && dated.copyrightYear >= new Date().getFullYear() - 2) {
      dated.signals = dated.signals.filter(s => s.id !== 'stale-copyright');
    }
    dated.agencyCredit = dated.agencyCredit || analyzed.map(p => p.analysis.dated?.agencyCredit).find(Boolean) || null;
    dated.score = Math.max(0, Math.min(100, dated.signals.reduce((sum, s) => sum + s.weight, 0) - modernOffset(dated.modern)));
  }
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
    emailEntries: undefined,
    rankedEmails,
    owners,
    familyOwned: analyzed.some(p => p.analysis.familyOwned),
    dated,
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
    homeFallback: fallback || null,
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
