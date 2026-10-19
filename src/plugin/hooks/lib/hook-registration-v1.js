'use strict';
const REGISTRATION = Object.freeze({ REGISTERED: 'registered', UNREGISTERED: 'unregistered', UNKNOWN: 'unknown' });

// This is the owned native dispatcher registry, not a host hook envelope.
// The matcher is anchored exactly as dispatcher.matchingHooks anchors it.
function registration(registry, options) {
  if (!registry || typeof registry !== 'object' || Array.isArray(registry)) return REGISTRATION.UNKNOWN;
  const entries = registry[options.event];
  if (entries === undefined) return REGISTRATION.UNREGISTERED;
  if (!Array.isArray(entries)) return REGISTRATION.UNKNOWN;
  let unknown = false;
  for (const entry of entries) {
    if (!entry || typeof entry.script !== 'string' || !options.names(entry.script)) continue;
    if (entry.matcher !== undefined && typeof entry.matcher !== 'string') { unknown = true; continue; }
    try {
      const matcher = new RegExp(`^(?:${entry.matcher || '.*'})$`);
      if (options.tools.every(tool => matcher.test(tool))) return REGISTRATION.REGISTERED;
    } catch { unknown = true; }
  }
  return unknown ? REGISTRATION.UNKNOWN : REGISTRATION.UNREGISTERED;
}
module.exports = { REGISTRATION, registration };
