export function normalizeUrl(input) {
  const raw = input.trim();
  if (!raw) throw new Error('empty URL');
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  const url = new URL(withScheme);
  url.hash = '';
  return url.toString();
}
