import { describe, it, expect, vi, afterEach } from 'vitest';
import { pinnedSpaceInstanceUrl, RITUALS_SPACE_INSTANCE_URL } from './ritualsSpaceInstance.js';
import { decideFramePartition, readProbeCookie } from './ritualsSpaceProbe.js';
import {
  RITUALS_PARENT_ORIGIN,
  handleRitualsParentMessage,
  isFrameVisible,
  resolveRitualsParentOrigin,
} from './ritualsSpace.js';

const NONCE = '0123456789abcdef0123456789abcdef';

describe('pinnedSpaceInstanceUrl', () => {
  it('pins the frame host to space.rit.al', () => {
    expect(pinnedSpaceInstanceUrl('https://space.rituals.app', null)).toBe(RITUALS_SPACE_INSTANCE_URL);
    expect(pinnedSpaceInstanceUrl('https://space.rituals.app/', null)).toBe('https://space.rit.al');
  });
  it('leaves every other origin unpinned', () => {
    for (const origin of ['https://space.rit.al', 'https://rituals.app', 'http://127.0.0.1:5173', 'http://space.rituals.app', '', null]) {
      expect(pinnedSpaceInstanceUrl(origin, null)).toBeNull();
    }
  });
  it('honours a build-time pin', () => {
    expect(pinnedSpaceInstanceUrl('http://127.0.0.1:5173', 'http://127.0.0.1:8080')).toBe('http://127.0.0.1:8080');
  });
});

describe('resolveRitualsParentOrigin', () => {
  it('defaults to rituals.app', () => {
    expect(resolveRitualsParentOrigin(null)).toBe(RITUALS_PARENT_ORIGIN);
    expect(resolveRitualsParentOrigin('https://rituals.app', { pageOrigin: 'https://space.rituals.app' })).toBe('https://rituals.app');
  });
  it('accepts a loopback parent only on a loopback page or a dev build', () => {
    expect(resolveRitualsParentOrigin('http://127.0.0.1:5176', { pageOrigin: 'http://127.0.0.1:5173' })).toBe('http://127.0.0.1:5176');
    expect(resolveRitualsParentOrigin('http://localhost:5176', { pageOrigin: 'https://space.rituals.app', dev: true })).toBe('http://localhost:5176');
    expect(resolveRitualsParentOrigin('http://127.0.0.1:5176', { pageOrigin: 'https://space.rituals.app' })).toBe(RITUALS_PARENT_ORIGIN);
  });
  it('rejects anything that is not a bare loopback origin', () => {
    for (const bad of ['https://evil.example', 'http://127.0.0.1.evil.example', 'http://127.0.0.1:5176/path', 'javascript:alert(1)', 'not a url']) {
      expect(resolveRitualsParentOrigin(bad, { pageOrigin: 'http://127.0.0.1:5173', dev: true })).toBe(RITUALS_PARENT_ORIGIN);
    }
  });
});

describe('handleRitualsParentMessage', () => {
  afterEach(() => {
    handleRitualsParentMessage({ source: window.parent, origin: RITUALS_PARENT_ORIGIN, data: { type: 'visible', visible: true } });
  });
  it('accepts visible from the parent at the Rituals origin', () => {
    const listener = vi.fn();
    window.addEventListener('rituals:frame-visible', listener);
    expect(handleRitualsParentMessage({ source: window.parent, origin: RITUALS_PARENT_ORIGIN, data: { type: 'visible', visible: false } })).toBe(true);
    expect(isFrameVisible()).toBe(false);
    expect(listener).toHaveBeenCalledTimes(1);
    window.removeEventListener('rituals:frame-visible', listener);
  });
  it('ignores other origins, other sources and malformed data', () => {
    expect(handleRitualsParentMessage({ source: window.parent, origin: 'https://evil.example', data: { type: 'visible', visible: false } })).toBe(false);
    expect(handleRitualsParentMessage({ source: {}, origin: RITUALS_PARENT_ORIGIN, data: { type: 'visible', visible: false } })).toBe(false);
    expect(handleRitualsParentMessage({ source: window.parent, origin: RITUALS_PARENT_ORIGIN, data: { type: 'visible', visible: 'no' } })).toBe(false);
    expect(handleRitualsParentMessage({ source: window.parent, origin: RITUALS_PARENT_ORIGIN, data: 'escape' })).toBe(false);
    expect(isFrameVisible()).toBe(true);
  });
  it('turns escape into an Escape keydown', () => {
    const onKey = vi.fn();
    document.addEventListener('keydown', onKey);
    expect(handleRitualsParentMessage({ source: window.parent, origin: RITUALS_PARENT_ORIGIN, data: { type: 'escape' } })).toBe(true);
    expect(onKey).toHaveBeenCalledTimes(1);
    expect(onKey.mock.calls[0][0].key).toBe('Escape');
    document.removeEventListener('keydown', onKey);
  });
});

describe('decideFramePartition', () => {
  it('is unpartitioned only with matching markers and no denial', () => {
    expect(decideFramePartition({ hasStorageAccess: true, cookieNonce: NONCE, idbNonce: NONCE })).toEqual({ partitioned: false, reason: null });
    expect(decideFramePartition({ hasStorageAccess: null, cookieNonce: NONCE, idbNonce: NONCE }).partitioned).toBe(false);
  });
  it('is partitioned on denial, a missing marker or a mismatch', () => {
    expect(decideFramePartition({ hasStorageAccess: false, cookieNonce: NONCE, idbNonce: NONCE }).reason).toBe('storage_access_denied');
    expect(decideFramePartition({ hasStorageAccess: true, cookieNonce: null, idbNonce: NONCE }).reason).toBe('no_marker');
    expect(decideFramePartition({ hasStorageAccess: true, cookieNonce: NONCE, idbNonce: null }).reason).toBe('no_marker');
    expect(decideFramePartition({ hasStorageAccess: true, cookieNonce: 'zz', idbNonce: 'zz' }).reason).toBe('no_marker');
    expect(decideFramePartition({ hasStorageAccess: true, cookieNonce: NONCE, idbNonce: 'f'.repeat(32) }).reason).toBe('marker_mismatch');
  });
  it('reads the probe cookie', () => {
    expect(readProbeCookie(`a=1; rituals_space_seen=${NONCE}; b=2`)).toBe(NONCE);
    expect(readProbeCookie('a=1')).toBeNull();
  });
});
