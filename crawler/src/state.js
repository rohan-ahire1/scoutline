export function classifyWebsiteType(tech = {}) {
  if (tech.shopify) return 'shopify';
  if (tech.staticCandidate) return 'static';
  if (tech.wordpress) return tech.woocommerce ? 'woocommerce' : 'wordpress';
  if (tech.wix) return 'wix';
  if (tech.squarespace) return 'squarespace';
  if (tech.webflow) return 'webflow';
  if (tech.nextjs) return 'nextjs';
  if (tech.nuxt) return 'nuxt';
  if (tech.magento) return 'magento';
  if (tech.bigcommerce) return 'bigcommerce';
  if (tech.drupal) return 'drupal';
  if (tech.react || tech.angular) return 'dynamic';
  return 'unknown';
}
