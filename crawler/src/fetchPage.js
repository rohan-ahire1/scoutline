import crypto from 'node:crypto';
import { config } from './config.js';
import { allowedByRobots } from './robots.js';
import { throttleHost } from './throttle.js';

export async function fetchPage(targetUrl) {
  if (!(await allowedByRobots(targetUrl))) {
    return { blockedByRobots: true, requestedUrl: targetUrl };
  }

  const url = new URL(targetUrl);
  await throttleHost(url.host);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.requestTimeoutMs);
  const started = Date.now();

  try {
    const res = await fetch(targetUrl, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'user-agent': config.userAgent,
        'accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5',
        'accept-language': 'en-US,en;q=0.8'
      }
    });

    const contentType = res.headers.get('content-type') || '';
    const reader = res.body?.getReader();
    const chunks = [];
    let total = 0;

    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > config.maxResponseBytes) {
          await reader.cancel('response too large');
          throw new Error(`response exceeds ${config.maxResponseBytes} bytes`);
        }
        chunks.push(Buffer.from(value));
      }
    }

    const body = Buffer.concat(chunks);
    return {
      blockedByRobots: false,
      requestedUrl: targetUrl,
      finalUrl: res.url,
      statusCode: res.status,
      contentType,
      latencyMs: Date.now() - started,
      responseBytes: body.length,
      sha256: crypto.createHash('sha256').update(body).digest('hex'),
      body: body.toString('utf8')
    };
  } finally {
    clearTimeout(timer);
  }
}
