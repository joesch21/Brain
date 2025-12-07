// Utilities for logging backend/debug events to the floating console
export function pushBackendDebugEntry(entry) {
  const timestamped = {
    timestamp: new Date().toISOString(),
    ...entry,
  };

  const existing = window.backendDebug;
  let previousEntries = [];

  if (existing) {
    if (Array.isArray(existing.entries)) {
      previousEntries = existing.entries;
    } else if (Array.isArray(existing)) {
      previousEntries = existing;
    } else if (Array.isArray(existing.logs)) {
      previousEntries = existing.logs;
    }
  }

  const entries = [...previousEntries, timestamped].slice(-50);
  window.backendDebug = {
    entries,
    lastEntry: timestamped,
  };

  return timestamped;
}
