import robotsParser from 'robots-parser';
import { config } from './config.js';

const cache = new Map();

export async function allowedByRobots(targetUrl) {
  const url = new URL(targetUrl);
  const key = url.origin;
  const now = Date.now();
  const cached = cache.get(key);
  if (cached && cached.expiresAt > now) {
    return cached.parser.isAllowed(targetUrl, config.userAgent) !== false;
  }

  const robotsUrl = new URL('/robots.txt', url.origin).toString();
  let body = '';
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(config.requestTimeoutMs, 8000));
    const res = await fetch(robotsUrl, {
      headers: { 'user-agent': config.userAgent, accept: 'text/plain,*/*;q=0.1' },
      signal: controller.signal,
      redirect: 'follow'
    });
    clearTimeout(timer);
    if (res.ok) body = await res.text();
  } catch {
    body = '';
  }

  const parser = robotsParser(robotsUrl, body);
  cache.set(key, {
    parser,
    expiresAt: now + config.robotsCacheMinutes * 60_000
  });
  return parser.isAllowed(targetUrl, config.userAgent) !== false;
}
