// Signals that a site looks dated or cheaply built. It sees markup only, not
// pixels, and every signal carries the snippet that triggered it so a
// pitch can quote it.

function versionOf(value) {
  const parts = String(value || '').split('.').map(n => Number.parseInt(n, 10));
  return Number.isFinite(parts[0]) ? parts : null;
}

function olderThan(version, major, minor = 0) {
  if (!version) return false;
  return version[0] < major || (version[0] === major && (version[1] || 0) < minor);
}

// Site builders and the agencies behind "template" trade sites. Detecting an
// agency matters: the owner already pays someone, so the pitch is different.
const BUILDERS = [
  ['GoDaddy Website Builder', /img1\.wsimg\.com|godaddysites\.com|websites\.godaddy\.com/i],
  ['Weebly', /weebly\.com|editmysite\.com/i],
  ['Wix', /wixstatic\.com|wix-code|x-wix-/i],
  ['Squarespace', /static1\.squarespace\.com|squarespace-cdn/i],
  ['Duda', /irp\.cdn-website\.com|dudamobile|cdn-website\.com/i],
  ['Google Sites', /gstatic\.com\/atari\/|content="Google Sites"/i],
  ['Jimdo', /jimdo(?:site|cdn)?\.com/i],
  ['Yola', /yola(?:site)?\.com/i],
  ['Web.com', /web\.com\/|netsolhost|website-builder\.web\.com/i],
  ['Homestead', /homestead\.com/i],
  ['Square Online', /square\.site|editmysite/i],
  ['Webflow', /webflow\.(?:js|com)|website-files\.com/i],
  ['Framer', /framerusercontent\.com|framer\.(?:com|app)/i],
  ['Hibu', /hibu\.com|hibustudio/i],
  ['Thryv', /thryv\.com/i],
  ['Scorpion', /scorpion\.co|scorpioncms/i],
  ['Blue Corona', /bluecorona/i],
  ['ReachLocal', /reachlocal/i],
  ['Yodle', /yodle/i],
];

const MODERN_BUILDERS = new Set(['Webflow', 'Framer']);
const AGENCY_PLATFORMS = new Set(['Hibu', 'Thryv', 'Scorpion', 'Blue Corona', 'ReachLocal', 'Yodle']);

const PLACEHOLDERS = [
  ['parked', /this domain (?:is|may be) for sale|domain is parked|sedoparking|parkingcrew|bodis\.com|hugedomains|dan\.com\/buy|afternic/i],
  ['coming-soon', /\b(?:coming soon|under construction|site is being built|launching soon|website coming soon)\b/i],
  ['default-template', /just another wordpress site|lorem ipsum dolor|hello world!|sample page|this is an example page|welcome to your (?:new )?site/i],
  ['suspended', /account (?:has been )?suspended|this site has been suspended|bandwidth limit exceeded/i],
];

const PHONE_TEXT = /(?:\+?1[\s.-]?)?\(?\b[2-9]\d{2}\)?[\s.-]\d{3}[\s.-]\d{4}\b/;

// Only a modern build offsets dated signals; lazy images and web fonts come
// with any stock WordPress theme and prove little.
const STRONG_MODERN = new Set(['modern-framework', 'modern-builder']);
export function modernOffset(modern = []) {
  return modern.reduce((sum, m) => sum + (STRONG_MODERN.has(m.id) ? 10 : 2), 0);
}

export function detectDated({ rawHtml, $, visibleText, finalUrl, headers = {}, now = new Date() }) {
  const lower = rawHtml.toLowerCase();
  const signals = [];
  const modern = [];
  const add = (id, label, evidence, weight) => signals.push({ id, label, evidence, weight });
  const plus = (id, label, evidence) => modern.push({ id, label, evidence });
  const year = now.getFullYear();

  // Footer copyright: the newest year mentioned. Missing means unknown (many
  // sites print the year with JavaScript).
  let copyrightYear = null;
  for (const match of visibleText.matchAll(/(?:©|\(c\)|copyright)\s*(?:\d{4}\s*[-–—]\s*)?((?:19|20)\d{2})/gi)) {
    const y = Number(match[1]);
    if (y <= year && (!copyrightYear || y > copyrightYear)) copyrightYear = y;
  }
  if (copyrightYear && copyrightYear <= year - 3) add('stale-copyright', 'Footer copyright is out of date', `© ${copyrightYear}`, Math.min(18, 6 + (year - copyrightYear) * 2));
  else if (copyrightYear && copyrightYear >= year - 1) plus('current-copyright', 'Copyright is current', `© ${copyrightYear}`);

  const lastModified = headers['last-modified'] ? new Date(headers['last-modified']) : null;
  if (lastModified && !Number.isNaN(lastModified.getTime()) && (now - lastModified) / 86400000 > 3 * 365) {
    add('stale-last-modified', 'Homepage not modified in years', `Last-Modified: ${headers['last-modified']}`, 8);
  }

  const scripts = $('script[src]').map((_, el) => $(el).attr('src') || '').get();
  const styles = $('link[rel="stylesheet" i]').map((_, el) => $(el).attr('href') || '').get();
  const assets = [...scripts, ...styles];

  let jqueryVersion = null;
  for (const src of scripts) {
    const m = src.match(/jquery(?:[.-]|\.min\.js\?ver=|\/)(\d+\.\d+(?:\.\d+)?)/i) || (/jquery(?:\.min)?\.js/i.test(src) && src.match(/[?&]ver=(\d+\.\d+(?:\.\d+)?)/i));
    if (m) { jqueryVersion = m[1]; break; }
  }
  if (olderThan(versionOf(jqueryVersion), 3)) add('old-jquery', 'Uses an old jQuery version', `jQuery ${jqueryVersion}`, 8);

  let bootstrapVersion = null;
  for (const src of assets) {
    const m = src.match(/bootstrap(?:@|\/|-)(\d+\.\d+(?:\.\d+)?)/i) || (/bootstrap(?:\.min)?\.(?:css|js)/i.test(src) && src.match(/[?&]ver=(\d+\.\d+(?:\.\d+)?)/i));
    if (m) { bootstrapVersion = m[1]; break; }
  }
  if (olderThan(versionOf(bootstrapVersion), 4)) add('old-bootstrap', 'Built on Bootstrap 3 or older', `Bootstrap ${bootstrapVersion}`, 7);

  const generator = $('meta[name="generator" i]').attr('content')?.trim().slice(0, 120) || null;
  if (generator) {
    const wp = generator.match(/wordpress\s+(\d+\.\d+)/i);
    if (wp && olderThan(versionOf(wp[1]), 6)) add('old-wordpress', 'WordPress core is several major versions behind', generator, 8);
    if (/frontpage|dreamweaver|iweb|homestead|joomla!?\s*1\.|microsoft word|publisher/i.test(generator)) add('legacy-generator', 'Made with a legacy site tool', generator, 18);
  }

  const builders = BUILDERS.filter(([, pattern]) => pattern.test(lower)).map(([name]) => name);
  const agencyPlatform = builders.find(name => AGENCY_PLATFORMS.has(name)) || null;
  for (const name of builders) if (MODERN_BUILDERS.has(name)) plus('modern-builder', 'Built with a modern builder', name);
  if (builders.some(name => ['GoDaddy Website Builder', 'Weebly', 'Google Sites', 'Jimdo', 'Yola', 'Web.com', 'Homestead'].includes(name))) {
    add('diy-builder', 'Built with a basic DIY site builder', builders.join(', '), 10);
  }

  // "Website by …" footer credits name the agency that owns the relationship.
  let agencyCredit = null;
  const credit = visibleText.match(/(?:website|site|web design|designed|developed|built|powered|marketing)\s+(?:and\s+\w+\s+)?by[:\s]+([A-Z][\w&.'-]*(?:\s+(?:&|[A-Z][\w&.'-]*)){0,4})/);
  if (credit && credit[1].replace(/[^A-Za-z]/g, '').length >= 4 && !/wordpress|wix|squarespace|godaddy|weebly|shopify/i.test(credit[1])) agencyCredit = credit[1].trim().slice(0, 80);

  // Table-based and fixed-width layouts from the early 2000s.
  const layoutTables = $('table[width], table[bgcolor], td[bgcolor], table[cellpadding][border]').length;
  if (layoutTables >= 2) add('table-layout', 'Page layout is built from HTML tables', `${layoutTables} layout tables`, 16);
  const legacyTags = $('font, center, marquee, blink, frameset, frame, bgsound').length;
  if (legacyTags > 0) add('legacy-tags', 'Uses deprecated HTML (font/center/marquee)', `${legacyTags} deprecated elements`, Math.min(16, 6 + legacyTags));
  const fixedWidth = /(?:^|[;{\s"])width\s*:\s*(?:7[5-9]\d|8\d\d|9[0-9]\d|10[0-2]\d)px/i.test(lower) || $('table[width="800"], table[width="760"], table[width="780"], table[width="960"], table[width="980"]').length > 0;
  if (fixedWidth && !$('meta[name="viewport" i]').length) add('fixed-width', 'Fixed desktop-width layout', 'Fixed 750-1030px page width with no mobile viewport', 10);
  if (/\.swf\b|application\/x-shockwave-flash/i.test(lower)) add('flash', 'Still embeds Flash', '.swf content', 18);
  const spacerGifs = $('img[src*="spacer" i], img[src*="clear.gif" i], img[src*="blank.gif" i]').length;
  if (spacerGifs) add('spacer-gifs', 'Uses spacer GIFs for layout', `${spacerGifs} spacer images`, 8);

  if (!$('meta[name="viewport" i]').length) add('no-viewport', 'Not set up for phones (no viewport tag)', 'meta viewport missing', 18);
  if (finalUrl && new URL(finalUrl).protocol === 'http:') add('no-https', 'No HTTPS: browsers show "Not secure"', finalUrl, 12);

  // Mobile conversion: a phone number printed but not tappable.
  const telLinks = $('a[href^="tel:" i]').length;
  const phoneInText = visibleText.match(PHONE_TEXT)?.[0] || null;
  if (phoneInText && telLinks === 0) add('phone-not-tappable', 'Phone number is not tap-to-call on mobile', phoneInText, 8);

  // Modern counter-signals so a well-built site is not pitched a redesign.
  if ($('img[loading="lazy"], img[srcset], picture source').length >= 2) plus('responsive-images', 'Responsive / lazy images', 'srcset or loading="lazy"');
  if (/fonts\.googleapis\.com|use\.typekit\.net|fonts\.bunny\.net/.test(lower)) plus('web-fonts', 'Uses web fonts', 'Google Fonts / Typekit');
  if (/_next\/static|__nuxt|\/_astro\/|gatsby-/.test(lower)) plus('modern-framework', 'Modern web framework', 'Next.js / Nuxt / Astro / Gatsby');
  if (/\.webp|\.avif/.test(lower)) plus('modern-images', 'Modern image formats', 'webp / avif');

  let placeholder = null;
  for (const [kind, pattern] of PLACEHOLDERS) {
    if (pattern.test(visibleText.slice(0, 4000))) { placeholder = kind; break; }
  }
  if (placeholder && visibleText.length > 3000 && placeholder !== 'parked') placeholder = null; // A real site that mentions "coming soon" once.
  if (placeholder) add(`placeholder-${placeholder}`, `Site is a ${placeholder.replace('-', ' ')} page`, placeholder, 40);

  const raw = signals.reduce((sum, s) => sum + s.weight, 0) - modernOffset(modern);
  return {
    score: Math.max(0, Math.min(100, Math.round(raw))),
    signals: signals.sort((a, b) => b.weight - a.weight),
    modern,
    copyrightYear,
    generator,
    jqueryVersion,
    bootstrapVersion,
    builders,
    agencyPlatform,
    agencyCredit,
    placeholder,
    phoneTappable: telLinks > 0,
  };
}
