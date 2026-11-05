/**
 * Unit tests for createInstanceApi factory.
 *
 * The factory binds a baseUrl and a getToken callback to all MLS/chat/transparency
 * api.js functions, so callers don't need to carry those values explicitly.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createInstanceApi } from './instanceApi';

// Mock every export from api.js that the factory wraps.
vi.mock('./api', () => ({
  getMLSGroupInfo: vi.fn(),
  putMLSGroupInfo: vi.fn(),
  postMLSCommit: vi.fn(),
  getMLSCommitsSinceEpoch: vi.fn(),
  getMLSPendingWelcomes: vi.fn(),
  deleteMLSPendingWelcome: vi.fn(),
  getGuildMetadataGroupInfo: vi.fn(),
  putGuildMetadataGroupInfo: vi.fn(),
  getMLSVoiceGroupInfo: vi.fn(),
  putMLSVoiceGroupInfo: vi.fn(),
  postMLSVoiceCommit: vi.fn(),
  uploadMLSKeyPackages: vi.fn(),
  getKeyPackageCount: vi.fn(),
  getChannelMessages: vi.fn(),
  verifyTransparency: vi.fn(),
  getPreKeyBundle: vi.fn(),
  getPreKeyBundleByDevice: vi.fn(),
}));

import * as apiModule from './api';

const BASE_URL = 'https://remote.instance.example.com';
const TOKEN = 'test-jwt-token';

describe('createInstanceApi', () => {
  let getToken;
  let api;

  beforeEach(() => {
    vi.clearAllMocks();
    getToken = vi.fn().mockReturnValue(TOKEN);
    api = createInstanceApi(BASE_URL, getToken);
  });

  // ── Test 1: shape - all expected methods are present ────────────────────────

  it('returns an object with all MLS api methods', () => {
    const expectedMethods = [
      'getMLSGroupInfo',
      'putMLSGroupInfo',
      'postMLSCommit',
      'getMLSCommitsSinceEpoch',
      'getMLSPendingWelcomes',
      'deleteMLSPendingWelcome',
      'getGuildMetadataGroupInfo',
      'putGuildMetadataGroupInfo',
      'getMLSVoiceGroupInfo',
      'putMLSVoiceGroupInfo',
      'postMLSVoiceCommit',
      'uploadMLSKeyPackages',
      'getKeyPackageCount',
      'getChannelMessages',
      'verifyTransparency',
      'getPreKeyBundle',
      'getPreKeyBundleByDevice',
    ];

    for (const method of expectedMethods) {
      expect(typeof api[method], `method ${method} should be a function`).toBe('function');
    }
  });

  // ── Test 2: baseUrl is forwarded as last argument ────────────────────────────

  it('forwards baseUrl as last argument to getMLSGroupInfo', () => {
    api.getMLSGroupInfo(TOKEN, 'channel-1');
    expect(apiModule.getMLSGroupInfo).toHaveBeenCalledWith(TOKEN, 'channel-1', BASE_URL);
  });

  it('forwards baseUrl as last argument to putMLSGroupInfo', () => {
    api.putMLSGroupInfo(TOKEN, 'channel-1', 'groupInfoB64', 5);
    expect(apiModule.putMLSGroupInfo).toHaveBeenCalledWith(TOKEN, 'channel-1', 'groupInfoB64', 5, BASE_URL);
  });

  it('forwards baseUrl as last argument to postMLSCommit', () => {
    api.postMLSCommit(TOKEN, 'channel-1', 'commitB64', 'groupInfoB64', 5);
    expect(apiModule.postMLSCommit).toHaveBeenCalledWith(TOKEN, 'channel-1', 'commitB64', 'groupInfoB64', 5, BASE_URL);
  });

  it('forwards commit options after baseUrl to postMLSCommit', () => {
    const opts = { parentEpoch: 4, removes: [{ userId: 'u', deviceId: 'd' }] };
    api.postMLSCommit(TOKEN, 'channel-1', 'commitB64', 'groupInfoB64', 5, opts);
    expect(apiModule.postMLSCommit).toHaveBeenCalledWith(TOKEN, 'channel-1', 'commitB64', 'groupInfoB64', 5, BASE_URL, opts);
  });

  it('forwards baseUrl as last argument to getMLSCommitsSinceEpoch', () => {
    api.getMLSCommitsSinceEpoch(TOKEN, 'channel-1', 3);
    expect(apiModule.getMLSCommitsSinceEpoch).toHaveBeenCalledWith(TOKEN, 'channel-1', 3, 100, BASE_URL);
  });

  it('forwards explicit limit and baseUrl to getMLSCommitsSinceEpoch', () => {
    api.getMLSCommitsSinceEpoch(TOKEN, 'channel-1', 3, 250);
    expect(apiModule.getMLSCommitsSinceEpoch).toHaveBeenCalledWith(TOKEN, 'channel-1', 3, 250, BASE_URL);
  });

  it('forwards baseUrl as last argument to getMLSPendingWelcomes', () => {
    api.getMLSPendingWelcomes(TOKEN);
    expect(apiModule.getMLSPendingWelcomes).toHaveBeenCalledWith(TOKEN, BASE_URL);
  });

  it('forwards baseUrl as last argument to deleteMLSPendingWelcome', () => {
    api.deleteMLSPendingWelcome(TOKEN, 'welcome-id');
    expect(apiModule.deleteMLSPendingWelcome).toHaveBeenCalledWith(TOKEN, 'welcome-id', BASE_URL);
  });

  it('forwards baseUrl as last argument to getGuildMetadataGroupInfo', () => {
    api.getGuildMetadataGroupInfo(TOKEN, 'guild-id');
    expect(apiModule.getGuildMetadataGroupInfo).toHaveBeenCalledWith(TOKEN, 'guild-id', BASE_URL);
  });

  it('forwards baseUrl as last argument to putGuildMetadataGroupInfo', () => {
    api.putGuildMetadataGroupInfo(TOKEN, 'guild-id', 'groupInfoB64', 2);
    expect(apiModule.putGuildMetadataGroupInfo).toHaveBeenCalledWith(TOKEN, 'guild-id', 'groupInfoB64', 2, BASE_URL);
  });

  it('forwards baseUrl as last argument to getMLSVoiceGroupInfo', () => {
    api.getMLSVoiceGroupInfo(TOKEN, 'channel-v');
    expect(apiModule.getMLSVoiceGroupInfo).toHaveBeenCalledWith(TOKEN, 'channel-v', BASE_URL);
  });

  it('forwards baseUrl as last argument to putMLSVoiceGroupInfo', () => {
    api.putMLSVoiceGroupInfo(TOKEN, 'channel-v', 'groupInfoB64', 1);
    expect(apiModule.putMLSVoiceGroupInfo).toHaveBeenCalledWith(TOKEN, 'channel-v', 'groupInfoB64', 1, BASE_URL);
  });

  it('forwards baseUrl as last argument to postMLSVoiceCommit', () => {
    api.postMLSVoiceCommit(TOKEN, 'channel-v', 'commitB64', 1, 'groupInfoB64');
    expect(apiModule.postMLSVoiceCommit).toHaveBeenCalledWith(TOKEN, 'channel-v', 'commitB64', 1, 'groupInfoB64', BASE_URL);
  });

  it('forwards baseUrl as last argument to uploadMLSKeyPackages', () => {
    api.uploadMLSKeyPackages(TOKEN, { deviceId: 'd1', keyPackages: [] });
    expect(apiModule.uploadMLSKeyPackages).toHaveBeenCalledWith(TOKEN, { deviceId: 'd1', keyPackages: [] }, BASE_URL);
  });

  it('forwards baseUrl as last argument to getKeyPackageCount', () => {
    api.getKeyPackageCount(TOKEN, 'device-id');
    expect(apiModule.getKeyPackageCount).toHaveBeenCalledWith(TOKEN, 'device-id', BASE_URL);
  });

  it('forwards baseUrl as last argument to getChannelMessages', () => {
    api.getChannelMessages(TOKEN, 'server-id', 'channel-id', { limit: 10 });
    expect(apiModule.getChannelMessages).toHaveBeenCalledWith(TOKEN, 'server-id', 'channel-id', { limit: 10 }, BASE_URL);
  });

  it('forwards baseUrl as last argument to verifyTransparency', () => {
    api.verifyTransparency(TOKEN, 'pubkeyHex');
    expect(apiModule.verifyTransparency).toHaveBeenCalledWith(TOKEN, 'pubkeyHex', BASE_URL);
  });

  it('forwards baseUrl as last argument to getPreKeyBundle', () => {
    api.getPreKeyBundle(TOKEN, 'user-id');
    expect(apiModule.getPreKeyBundle).toHaveBeenCalledWith(TOKEN, 'user-id', BASE_URL);
  });

  it('forwards baseUrl as last argument to getPreKeyBundleByDevice', () => {
    api.getPreKeyBundleByDevice(TOKEN, 'user-id', 'device-id');
    expect(apiModule.getPreKeyBundleByDevice).toHaveBeenCalledWith(TOKEN, 'user-id', 'device-id', BASE_URL);
  });

  // ── Test 3: getToken() is called at invocation time, not factory creation ────

  it('reads token via getToken() at call time, not at factory creation time', () => {
    // After factory is created, change what getToken returns.
    getToken.mockReturnValue('fresh-token');

    api.getMLSGroupInfo(undefined, 'channel-1');

    // Should use fresh-token, not the TOKEN that was "current" at factory creation.
    expect(apiModule.getMLSGroupInfo).toHaveBeenCalledWith('fresh-token', 'channel-1', BASE_URL);
  });

  it('calls getToken() once per bound method invocation', () => {
    getToken.mockReturnValue('tok-abc');

    api.getMLSGroupInfo(undefined, 'channel-1');
    api.getMLSGroupInfo(undefined, 'channel-2');

    expect(getToken).toHaveBeenCalledTimes(2);
  });

  // ── Test 4: null token does not crash ────────────────────────────────────────

  it('passes null token through without throwing when getToken returns null', () => {
    getToken.mockReturnValue(null);

    expect(() => api.getMLSGroupInfo(undefined, 'channel-1')).not.toThrow();
    expect(apiModule.getMLSGroupInfo).toHaveBeenCalledWith(null, 'channel-1', BASE_URL);
  });

  it('uses explicitly passed token over getToken() result', () => {
    // When caller explicitly passes a token (mlsGroup.js pattern), use it.
    getToken.mockReturnValue('factory-token');

    api.getMLSGroupInfo('explicit-token', 'channel-1');

    expect(apiModule.getMLSGroupInfo).toHaveBeenCalledWith('explicit-token', 'channel-1', BASE_URL);
    // getToken should NOT be called since an explicit token was supplied.
    expect(getToken).not.toHaveBeenCalled();
  });

  // ── Test 5: empty string baseUrl ─────────────────────────────────────────────

  it('works with empty string baseUrl (same-origin fallback)', () => {
    const localApi = createInstanceApi('', getToken);

    localApi.getMLSGroupInfo(TOKEN, 'channel-1');

    expect(apiModule.getMLSGroupInfo).toHaveBeenCalledWith(TOKEN, 'channel-1', '');
  });

  it('works with empty string baseUrl for getMLSPendingWelcomes', () => {
    const localApi = createInstanceApi('', getToken);

    localApi.getMLSPendingWelcomes(TOKEN);

    expect(apiModule.getMLSPendingWelcomes).toHaveBeenCalledWith(TOKEN, '');
  });
});
