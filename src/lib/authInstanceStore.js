import { currentPinnedSpaceInstanceUrl } from './ritualsSpaceInstance.js';

const DB_NAME = 'hush-auth-instances';
const DB_VERSION = 1;
const STORE_INSTANCES = 'instances';
const FALLBACK_INSTANCES_KEY = 'hush_auth_instances_fallback';
const SELECTED_INSTANCE_KEY = 'hush_auth_instance_selected';
const ACTIVE_INSTANCE_KEY = 'hush_auth_instance_active';
const DEFAULT_MIGRATION_KEY = 'hush_auth_instance_default_origin_migrated_v1';

export const HOSTED_AUTH_INSTANCE_URL = 'https://app.gethush.live';

// Keep instance origins on HTTP(S). `http:` is needed for localhost/LAN dev.
const ALLOWED_INSTANCE_PROTOCOLS = new Set(['https:', 'http:']);

export function normalizeInstanceUrl(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed) return null;

  const candidate = /^[a-zA-Z][a-zA-Z\d+.-]*:\/\//.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;

  try {
    const url = new URL(candidate);
    if (!ALLOWED_INSTANCE_PROTOCOLS.has(url.protocol)) return null;
    url.pathname = '';
    url.search = '';
    url.hash = '';
    return url.origin;
  } catch {
    return null;
  }
}

export function getInstanceDisplayName(value) {
  const normalized = normalizeInstanceUrl(value);
  if (!normalized) {
    return String(value || '').trim() || 'instance';
  }
  try {
    return new URL(normalized).host;
  } catch {
    return normalized;
  }
}

function isDesktopRuntime() {
  return (
    typeof window !== 'undefined'
    && Boolean(window?.hushDesktop?.isDesktop)
  );
}

function resolveDefaultAuthInstanceUrl() {
  if (typeof window === 'undefined') {
    return HOSTED_AUTH_INSTANCE_URL;
  }

  // Rituals fork: the same-site frame host (space.rituals.app) uses space.rit.al.
  const pinned = currentPinnedSpaceInstanceUrl();
  if (pinned) return pinned;

  // Desktop app must default to the hosted instance, regardless of the
  // packaged renderer's origin (e.g. `app://localhost`). User overrides are
  // still honored via the persisted `SELECTED_INSTANCE_KEY` localStorage entry.
  if (isDesktopRuntime()) {
    return HOSTED_AUTH_INSTANCE_URL;
  }

  const currentOrigin = normalizeInstanceUrl(window.location?.origin);
  if (!currentOrigin) {
    return HOSTED_AUTH_INSTANCE_URL;
  }

  try {
    const currentHost = new URL(currentOrigin).host;
    if (currentHost === 'gethush.live') {
      return HOSTED_AUTH_INSTANCE_URL;
    }
  } catch {
    return HOSTED_AUTH_INSTANCE_URL;
  }

  return currentOrigin;
}

export const DEFAULT_AUTH_INSTANCE_URL = resolveDefaultAuthInstanceUrl();

function maybeMigrateLegacyHostedSelection() {
  if (typeof window === 'undefined') return;
  if (DEFAULT_AUTH_INSTANCE_URL === HOSTED_AUTH_INSTANCE_URL) return;

  try {
    if (localStorage.getItem(DEFAULT_MIGRATION_KEY) === '1') {
      return;
    }

    const selected = normalizeInstanceUrl(localStorage.getItem(SELECTED_INSTANCE_KEY));
    const active = normalizeInstanceUrl(sessionStorage.getItem(ACTIVE_INSTANCE_KEY));

    // Only seed a default when the user has no prior selection. Any
    // existing value may be an explicit user choice and must survive the
    // legacy default-origin migration.
    if (!selected) {
      localStorage.setItem(SELECTED_INSTANCE_KEY, DEFAULT_AUTH_INSTANCE_URL);
    }
    if (!active) {
      sessionStorage.setItem(ACTIVE_INSTANCE_KEY, DEFAULT_AUTH_INSTANCE_URL);
    }

    localStorage.setItem(DEFAULT_MIGRATION_KEY, '1');
  } catch {
    // Best-effort only.
  }
}

function createDefaultRecord() {
  return {
    url: DEFAULT_AUTH_INSTANCE_URL,
    lastUsedAt: 0,
  };
}

function normalizeRecord(record) {
  const url = normalizeInstanceUrl(record?.url);
  if (!url) return null;
  return {
    url,
    lastUsedAt: Number(record?.lastUsedAt) || 0,
  };
}

function mergeWithDefault(records) {
  const byUrl = new Map();
  byUrl.set(DEFAULT_AUTH_INSTANCE_URL, createDefaultRecord());

  records.forEach((record) => {
    const normalized = normalizeRecord(record);
    if (!normalized) return;
    const existing = byUrl.get(normalized.url);
    byUrl.set(normalized.url, {
      url: normalized.url,
      lastUsedAt: Math.max(existing?.lastUsedAt || 0, normalized.lastUsedAt),
    });
  });

  return Array.from(byUrl.values());
}

function sortRecords(records) {
  return [...records].sort((left, right) => {
    if (left.url === DEFAULT_AUTH_INSTANCE_URL) return -1;
    if (right.url === DEFAULT_AUTH_INSTANCE_URL) return 1;
    if (right.lastUsedAt !== left.lastUsedAt) return right.lastUsedAt - left.lastUsedAt;
    return getInstanceDisplayName(left.url).localeCompare(getInstanceDisplayName(right.url));
  });
}

function readFallbackRecords() {
  try {
    const raw = localStorage.getItem(FALLBACK_INSTANCES_KEY);
    if (!raw) return [createDefaultRecord()];
    const parsed = JSON.parse(raw);
    return sortRecords(mergeWithDefault(Array.isArray(parsed) ? parsed : []));
  } catch {
    return [createDefaultRecord()];
  }
}

function writeFallbackRecords(records) {
  try {
    localStorage.setItem(FALLBACK_INSTANCES_KEY, JSON.stringify(records));
  } catch {
    // Best-effort only.
  }
}

function openAuthInstanceDB() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('indexeddb unavailable'));
      return;
    }

    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(STORE_INSTANCES)) {
        db.createObjectStore(STORE_INSTANCES, { keyPath: 'url' });
      }
    };
  });
}

async function readIndexedDbRecords() {
  const db = await openAuthInstanceDB();
  try {
    const records = await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_INSTANCES, 'readonly');
      const store = tx.objectStore(STORE_INSTANCES);
      const request = store.getAll();
      request.onsuccess = () => resolve(request.result ?? []);
      request.onerror = () => reject(request.error);
    });
    return sortRecords(mergeWithDefault(records));
  } finally {
    db.close();
  }
}

async function writeIndexedDbRecord(record) {
  const db = await openAuthInstanceDB();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_INSTANCES, 'readwrite');
      const store = tx.objectStore(STORE_INSTANCES);
      const request = store.put(record);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

async function upsertKnownInstance(url, markUsed = false) {
  const normalizedUrl = normalizeInstanceUrl(url);
  if (!normalizedUrl) {
    throw new Error('Enter a valid instance URL.');
  }

  const nextLastUsedAt = markUsed ? Date.now() : 0;

  try {
    const records = await readIndexedDbRecords();
    const existing = records.find((record) => record.url === normalizedUrl);
    await writeIndexedDbRecord({
      url: normalizedUrl,
      lastUsedAt: Math.max(existing?.lastUsedAt || 0, nextLastUsedAt),
    });
  } catch {
    const records = readFallbackRecords();
    const existing = records.find((record) => record.url === normalizedUrl);
    const nextRecords = sortRecords(mergeWithDefault([
      ...records.filter((record) => record.url !== normalizedUrl),
      {
        url: normalizedUrl,
        lastUsedAt: Math.max(existing?.lastUsedAt || 0, nextLastUsedAt),
      },
    ]));
    writeFallbackRecords(nextRecords);
  }

  return normalizedUrl;
}

export function getSelectedAuthInstanceUrlSync() {
  maybeMigrateLegacyHostedSelection();
  const pinned = currentPinnedSpaceInstanceUrl();
  if (pinned) return pinned;
  if (typeof localStorage === 'undefined') return DEFAULT_AUTH_INSTANCE_URL;
  return normalizeInstanceUrl(localStorage.getItem(SELECTED_INSTANCE_KEY)) || DEFAULT_AUTH_INSTANCE_URL;
}

export function getActiveAuthInstanceUrlSync() {
  maybeMigrateLegacyHostedSelection();
  const pinned = currentPinnedSpaceInstanceUrl();
  if (pinned) return pinned;
  if (typeof sessionStorage !== 'undefined') {
    const active = normalizeInstanceUrl(sessionStorage.getItem(ACTIVE_INSTANCE_KEY));
    if (active) return active;
  }
  return getSelectedAuthInstanceUrlSync();
}

// Like getActiveAuthInstanceUrlSync, but does not fall through to selection.
export function getActiveAuthInstanceUrlIfSet() {
  if (typeof sessionStorage === 'undefined') return null;
  return normalizeInstanceUrl(sessionStorage.getItem(ACTIVE_INSTANCE_KEY)) || null;
}

export function setSelectedAuthInstanceUrlSync(value) {
  const normalized = normalizeInstanceUrl(value) || DEFAULT_AUTH_INSTANCE_URL;
  try {
    localStorage.setItem(SELECTED_INSTANCE_KEY, normalized);
    localStorage.setItem(DEFAULT_MIGRATION_KEY, '1');
  } catch {
    // Best-effort only.
  }
  return normalized;
}

export function setActiveAuthInstanceUrlSync(value) {
  const normalized = setSelectedAuthInstanceUrlSync(value);
  try {
    sessionStorage.setItem(ACTIVE_INSTANCE_KEY, normalized);
  } catch {
    // Best-effort only.
  }
  return normalized;
}

export async function loadKnownAuthInstances() {
  try {
    return await readIndexedDbRecords();
  } catch {
    return readFallbackRecords();
  }
}

export async function selectAuthInstance(value) {
  const normalized = setSelectedAuthInstanceUrlSync(value);
  await upsertKnownInstance(normalized, false);
  return normalized;
}

export async function markAuthInstanceUsed(value) {
  const normalized = setActiveAuthInstanceUrlSync(value);
  await upsertKnownInstance(normalized, true);
  return normalized;
}
