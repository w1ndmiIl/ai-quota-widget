"use strict";
const cache = new Map();
let ttl = 0;
function configureScanCache(milliseconds) { ttl = milliseconds; if (!ttl) cache.clear(); }
function memoScan(key, reader) {
  const cached = cache.get(key);
  if (ttl && cached && Date.now() - cached.at < ttl) return cached.value;
  const value = reader();
  if (ttl) cache.set(key, { at: Date.now(), value });
  return value;
}
module.exports = { memoScan, configureScanCache };
