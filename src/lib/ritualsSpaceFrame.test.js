import { describe, it, expect, vi, afterEach } from 'vitest';
import { isFrameHostOrigin, isFrameHostTopLevel, pinnedSpaceInstanceUrl, RITUALS_SPACE_INSTANCE_URL } from './ritualsSpaceInstance.js';
import { checkFrameStorage, decideFrameStorage } from './ritualsSpaceProbe.js';
import {
  RITUALS_PARENT_ORIGIN,
  handleRitualsParentMessage,
  isFrameVisible,
  postRitualsFrameBusy,
  resolveRitualsParentOrigin,
} from './ritualsSpace.js';

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

describe('postRitualsFrameBusy', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });
  it('posts nothing outside a frame', () => {
    const post = vi.spyOn(window, 'postMessage');
    postRitualsFrameBusy();
    expect(post).not.toHaveBeenCalled();
  });
  it('posts busy to the parent, at the Rituals origin only, when framed', () => {
    const parentPost = vi.fn();
    vi.spyOn(window, 'top', 'get').mockReturnValue({});
    vi.spyOn(window, 'parent', 'get').mockReturnValue({ postMessage: parentPost });
    postRitualsFrameBusy();
    expect(parentPost).toHaveBeenCalledTimes(1);
    expect(parentPost).toHaveBeenCalledWith({ type: 'busy' }, RITUALS_PARENT_ORIGIN);
  });
});

describe('isFrameHostOrigin', () => {
  it('is true only for the frame host', () => {
    expect(isFrameHostOrigin('https://space.rituals.app')).toBe(true);
    for (const origin of ['https://space.rit.al', 'https://rituals.app', 'http://space.rituals.app', 'http://127.0.0.1:5173', '', null]) {
      expect(isFrameHostOrigin(origin)).toBe(false);
    }
  });
  it('is never top-level frame host on the test page', () => {
    expect(isFrameHostTopLevel()).toBe(false);
  });
});

describe('decideFrameStorage', () => {
  it('boots whenever storage works, with no partition test', () => {
    expect(decideFrameStorage({ localStorageOk: true, idbOpened: true, idbWritten: true })).toEqual({ usable: true, reason: null });
  });
  it('stops only on unusable storage', () => {
    expect(decideFrameStorage({ localStorageOk: false, idbOpened: true, idbWritten: true }).reason).toBe('localstorage_unavailable');
    expect(decideFrameStorage({ localStorageOk: true, idbOpened: false, idbWritten: false }).reason).toBe('indexeddb_unavailable');
    expect(decideFrameStorage({ localStorageOk: true, idbOpened: true, idbWritten: false }).reason).toBe('indexeddb_write_failed');
  });
  it('never asks for storage access', async () => {
    const request = vi.fn();
    const has = vi.fn();
    document.requestStorageAccess = request;
    document.hasStorageAccess = has;
    expect(await checkFrameStorage()).toEqual({ usable: true, reason: null });
    expect(request).not.toHaveBeenCalled();
    expect(has).not.toHaveBeenCalled();
    delete document.requestStorageAccess;
    delete document.hasStorageAccess;
  });
});
