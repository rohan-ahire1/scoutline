import { config } from './config.js';

const hostTail = new Map();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function throttleHost(host) {
  const previous = hostTail.get(host) || Promise.resolve();
  let release;
  const current = new Promise(resolve => { release = resolve; });
  const tail = previous.then(() => current);
  hostTail.set(host, tail);

  await previous;
  try {
    await sleep(config.perHostDelayMs);
  } finally {
    release();
    if (hostTail.get(host) === tail) hostTail.delete(host);
  }
}
