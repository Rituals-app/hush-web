import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import LinkDevice from './LinkDevice.jsx';

const {
  authState,
  mockQrToDataUrl,
  mockCreateDeviceLinkRequest,
  mockConsumeDeviceLinkResult,
  mockResolveDeviceLinkRequest,
  mockVerifyDeviceLinkRequest,
  mockCreateDeviceIdentity,
  mockCreateSessionKeyPair,
  mockBuildLinkApprovalUrl,
  mockChooseInstance,
  authInstanceSelectionState,
  mockDecodeTransferBundle,
  mockDecryptRelayPayload,
  mockOpenStore,
  mockExportHistorySnapshot,
  mockBytesToBase64,
  mockCertifyDevice,
  mockBase64ToBytes,
  mockEncodeTransferBundle,
  mockEncryptRelayPayload,
  mockPreDecryptForLinkExport,
  mockOpenGuildMetadataKeyStore,
  mockExportGuildMetadataKeySnapshot,
  mockListAllLocalPlaintexts,
  mockBuildTranscriptBlobForExport,
  mockListTranscriptCacheEntries,
  mockUploadArchiveSession,
  mockDownloadArchiveSession,
  mockDeleteArchive,
  mockResumeUploadArchiveSession,
  mockSweepStaleExports,
  mockFindResumableExport,
  mockDeleteExport,
} = vi.hoisted(() => ({
  authState: { current: null },
  mockQrToDataUrl: vi.fn(),
  mockCreateDeviceLinkRequest: vi.fn(),
  mockConsumeDeviceLinkResult: vi.fn(),
  mockResolveDeviceLinkRequest: vi.fn(),
  mockVerifyDeviceLinkRequest: vi.fn(),
  mockCreateDeviceIdentity: vi.fn(),
  mockCreateSessionKeyPair: vi.fn(),
  mockBuildLinkApprovalUrl: vi.fn(),
  mockChooseInstance: vi.fn(),
  authInstanceSelectionState: { current: 'https://chat.example.com' },
  mockDecodeTransferBundle: vi.fn(),
  mockDecryptRelayPayload: vi.fn(),
  mockOpenStore: vi.fn(),
  mockExportHistorySnapshot: vi.fn(),
  mockBytesToBase64: vi.fn(),
  mockCertifyDevice: vi.fn(),
  mockBase64ToBytes: vi.fn(),
  mockEncodeTransferBundle: vi.fn(),
  mockEncryptRelayPayload: vi.fn(),
  mockPreDecryptForLinkExport: vi.fn(),
  mockOpenGuildMetadataKeyStore: vi.fn(),
  mockExportGuildMetadataKeySnapshot: vi.fn(),
  mockListAllLocalPlaintexts: vi.fn(),
  mockBuildTranscriptBlobForExport: vi.fn(),
  mockListTranscriptCacheEntries: vi.fn(),
  mockUploadArchiveSession: vi.fn(),
  mockDownloadArchiveSession: vi.fn(),
  mockDeleteArchive: vi.fn(),
  mockResumeUploadArchiveSession: vi.fn(),
  mockSweepStaleExports: vi.fn(),
  mockFindResumableExport: vi.fn(),
  mockDeleteExport: vi.fn(),
}));

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => authState.current,
}));

vi.mock('../hooks/useBodyScrollMode', () => ({
  BODY_SCROLL_MODE: { SCROLL: 'scroll' },
  useBodyScrollMode: vi.fn(),
}));

vi.mock('../hooks/useAuth', () => ({
  getDeviceId: () => 'device-1',
  getInstanceToken: () => 'tok',
}));

vi.mock('../hooks/useAuthInstanceSelection.js', () => ({
  useAuthInstanceSelection: () => ({
    selectedInstanceUrl: authInstanceSelectionState.current,
    knownInstances: [{ url: authInstanceSelectionState.current, lastUsedAt: Date.now() }],
    chooseInstance: (...args) => mockChooseInstance(...args),
    rememberSelectedInstance: vi.fn(),
  }),
}));

vi.mock('../lib/api', () => ({
  consumeDeviceLinkResult: (...args) => mockConsumeDeviceLinkResult(...args),
  createDeviceLinkRequest: (...args) => mockCreateDeviceLinkRequest(...args),
  resolveDeviceLinkRequest: (...args) => mockResolveDeviceLinkRequest(...args),
  verifyDeviceLinkRequest: (...args) => mockVerifyDeviceLinkRequest(...args),
}));

vi.mock('../lib/mlsStore', () => ({
  openStore: (...args) => mockOpenStore(...args),
  exportHistorySnapshot: (...args) => mockExportHistorySnapshot(...args),
  listAllLocalPlaintexts: (...args) => mockListAllLocalPlaintexts(...args),
}));

vi.mock('../lib/preDecryptForLinkExport', () => ({
  preDecryptForLinkExport: (...args) => mockPreDecryptForLinkExport(...args),
}));

vi.mock('../lib/transcriptVault', () => ({
  buildTranscriptBlobForExport: (...args) => mockBuildTranscriptBlobForExport(...args),
  listTranscriptCacheEntries: (...args) => mockListTranscriptCacheEntries(...args),
}));

vi.mock('../lib/guildMetadataKeyStore', () => ({
  openGuildMetadataKeyStore: (...args) => mockOpenGuildMetadataKeyStore(...args),
  exportGuildMetadataKeySnapshot: (...args) => mockExportGuildMetadataKeySnapshot(...args),
}));

vi.mock('../lib/deviceLinking', () => ({
  buildLinkApprovalUrl: (...args) => mockBuildLinkApprovalUrl(...args),
  bytesToBase64: (...args) => mockBytesToBase64(...args),
  certifyDevice: (...args) => mockCertifyDevice(...args),
  createDeviceIdentity: (...args) => mockCreateDeviceIdentity(...args),
  createSessionKeyPair: (...args) => mockCreateSessionKeyPair(...args),
  decodeQRPayload: vi.fn((encoded) => ({
    requestId: encoded === 'valid-payload' ? 'req-from-qr' : '',
    secret: encoded === 'valid-payload' ? 'secret-from-qr' : '',
    expiresAt: '2026-03-29T00:05:00.000Z',
  })),
  decodeTransferBundle: (...args) => mockDecodeTransferBundle(...args),
  decryptRelayPayload: (...args) => mockDecryptRelayPayload(...args),
  encodeTransferBundle: (...args) => mockEncodeTransferBundle(...args),
  encryptRelayPayload: (...args) => mockEncryptRelayPayload(...args),
  base64ToBytes: (...args) => mockBase64ToBytes(...args),
  importSessionPublicKey: vi.fn(),
}));

vi.mock('../lib/linkArchiveSession', () => ({
  uploadArchiveSession: (...args) => mockUploadArchiveSession(...args),
  downloadArchiveSession: (...args) => mockDownloadArchiveSession(...args),
  resumeUploadArchiveSession: (...args) => mockResumeUploadArchiveSession(...args),
}));

vi.mock('../lib/linkArchiveTransport', () => ({
  deleteArchive: (...args) => mockDeleteArchive(...args),
}));

vi.mock('../lib/linkArchiveExportStore', () => ({
  sweepStaleExports: (...args) => mockSweepStaleExports(...args),
  findResumableExport: (...args) => mockFindResumableExport(...args),
  deleteExport: (...args) => mockDeleteExport(...args),
}));

vi.mock('qrcode', () => ({
  default: {
    toDataURL: (...args) => mockQrToDataUrl(...args),
  },
}));

function renderLinkDevice(entry) {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/link-device" element={<LinkDevice />} />
        <Route path="/" element={<div>Home</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('LinkDevice', () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    authState.current = {
      completeDeviceLink: vi.fn(),
      loading: false,
      isAuthenticated: false,
      hasSession: false,
      hasVault: false,
      isVaultUnlocked: false,
      needsUnlock: false,
      vaultState: 'none',
      token: null,
      user: null,
      identityKeyRef: { current: null },
    };
    authInstanceSelectionState.current = 'https://chat.example.com';
    mockChooseInstance.mockImplementation(async (value) => {
      authInstanceSelectionState.current = value;
      return value;
    });
    mockPreDecryptForLinkExport.mockResolvedValue({
      channels: 0, processed: 0, decrypted: 0, failed: 0, skipped: 0,
    });
    mockOpenGuildMetadataKeyStore.mockResolvedValue({ close: vi.fn() });
    mockExportGuildMetadataKeySnapshot.mockResolvedValue({ stores: {} });
    mockListAllLocalPlaintexts.mockResolvedValue([]);
    mockListTranscriptCacheEntries.mockReturnValue([]);
    mockBuildTranscriptBlobForExport.mockResolvedValue(new Uint8Array([0xde, 0xad, 0xbe, 0xef]));
    mockUploadArchiveSession.mockResolvedValue({
      id: 'arch-test',
      uploadToken: 'utok-test',
      downloadToken: 'dtok-test',
      totalChunks: 1,
      totalBytes: 16,
      chunkSize: 4 * 1024 * 1024,
      manifestHash: 'bWFuaWZlc3Q=',
      archiveSha256: 'YXJjaGl2ZQ==',
      format: 'chunk-atomic-v1',
      chunkPlaintextHashes: ['Y2h1bmstaGFzaA=='],
      ephPub: 'ZXBocHViYnl0ZXM=',
      nonceBase: 'bm9uY2ViYXNl',
      transcriptBlobOmitted: false,
    });
    mockDownloadArchiveSession.mockResolvedValue({
      historySnapshot: { version: 1, stores: {} },
      guildMetadataKeySnapshot: null,
      transcriptBlob: null,
    });
    mockDeleteArchive.mockResolvedValue(undefined);
    mockResumeUploadArchiveSession.mockResolvedValue({
      id: 'arch-resume',
      uploadToken: 'utok-resume',
      downloadToken: 'dtok-resume',
      totalChunks: 1,
      totalBytes: 16,
      chunkSize: 4 * 1024 * 1024,
      manifestHash: 'bWFuaWZlc3Q=',
      archiveSha256: 'YXJjaGl2ZQ==',
      format: 'chunk-atomic-v1',
      chunkPlaintextHashes: ['Y2h1bmstaGFzaA=='],
      ephPub: 'ZXBocHViYnl0ZXM=',
      nonceBase: 'bm9uY2ViYXNl',
      transcriptBlobOmitted: false,
    });
    mockSweepStaleExports.mockResolvedValue(0);
    mockFindResumableExport.mockResolvedValue(null);
    mockDeleteExport.mockResolvedValue(undefined);
    mockDecryptRelayPayload.mockResolvedValue(new Uint8Array([1, 2, 3]));
    mockDecodeTransferBundle.mockResolvedValue({
      version: 3,
      userId: 'user-1',
      username: 'alice',
      displayName: 'Alice',
      instanceUrl: 'https://chat.example.com',
      exportedAt: new Date().toISOString(),
      rootPrivateKey: new Uint8Array([1, 2, 3]),
      rootPublicKey: new Uint8Array([4, 5, 6]),
      archive: null,
      historySnapshot: null,
      guildMetadataKeySnapshot: null,
      transcriptBlob: null,
    });
  });

  afterEach(() => {
    cleanup();
  });

  it('renders a QR code and fallback code for a new-device request', async () => {
    mockCreateDeviceIdentity.mockResolvedValue({
      publicKeyBase64: 'device-public-key',
    });
    mockCreateSessionKeyPair.mockResolvedValue({
      privateKey: { type: 'private-key' },
      publicKeyBase64: 'session-public-key',
    });
    mockCreateDeviceLinkRequest.mockResolvedValue({
      requestId: 'req-1',
      secret: 'secret-1',
      code: 'ABCD1234',
      expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    });
    mockBuildLinkApprovalUrl.mockReturnValue('https://app.gethush.live/link-device?payload=abc');
    mockQrToDataUrl.mockResolvedValue('data:image/png;base64,qr-code');
    mockConsumeDeviceLinkResult.mockResolvedValue({ status: 'pending' });

    renderLinkDevice('/link-device?mode=new');

    expect(await screen.findByAltText(/device link qr code/i)).toBeInTheDocument();
    expect(screen.getByText('ABCD1234')).toBeInTheDocument();
    // Copy-to-clipboard affordance is rendered alongside the fallback code.
    expect(screen.getByRole('button', { name: /copy device link code/i })).toBeInTheDocument();
    expect(mockCreateDeviceLinkRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        deviceId: 'device-1',
        devicePublicKey: 'device-public-key',
        sessionPublicKey: 'session-public-key',
        instanceUrl: 'https://chat.example.com',
      }),
      'https://chat.example.com',
    );
    expect(mockBuildLinkApprovalUrl).toHaveBeenCalledWith(
      'https://chat.example.com',
      expect.objectContaining({
        requestId: 'req-1',
        secret: 'secret-1',
        devicePublicKey: 'device-public-key',
        sessionPublicKey: 'session-public-key',
      }),
    );
    await waitFor(() => {
      expect(mockConsumeDeviceLinkResult).toHaveBeenCalledWith({
        requestId: 'req-1',
        secret: 'secret-1',
      }, 'https://chat.example.com');
    });
  });

  // Rituals fork: in the Rituals pane, linking waits on the person, so the
  // page tells the parent once on mount (busy), not on every re-render.
  it('posts busy to the Rituals parent once when it mounts in a frame', async () => {
    const parentPost = vi.fn();
    const top = vi.spyOn(window, 'top', 'get').mockReturnValue({});
    const parent = vi.spyOn(window, 'parent', 'get').mockReturnValue({ postMessage: parentPost });
    try {
      mockCreateDeviceIdentity.mockResolvedValue({ publicKeyBase64: 'device-public-key' });
      mockCreateSessionKeyPair.mockResolvedValue({
        privateKey: { type: 'private-key' },
        publicKeyBase64: 'session-public-key',
      });
      mockCreateDeviceLinkRequest.mockResolvedValue({
        requestId: 'req-1',
        secret: 'secret-1',
        code: 'ABCD1234',
        expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      });
      mockBuildLinkApprovalUrl.mockReturnValue('https://app.gethush.live/link-device?payload=abc');
      mockQrToDataUrl.mockResolvedValue('data:image/png;base64,qr-code');
      mockConsumeDeviceLinkResult.mockResolvedValue({ status: 'pending' });

      const view = renderLinkDevice('/link-device?mode=new');

      // Loading, then the active QR state, then a parent re-render: several
      // renders of the page, one mount.
      expect(await screen.findByAltText(/device link qr code/i)).toBeInTheDocument();
      await waitFor(() => expect(mockConsumeDeviceLinkResult).toHaveBeenCalled());
      view.rerender(
        <MemoryRouter initialEntries={['/link-device?mode=new']}>
          <Routes>
            <Route path="/link-device" element={<LinkDevice />} />
          </Routes>
        </MemoryRouter>,
      );
      expect(screen.getByAltText(/device link qr code/i)).toBeInTheDocument();
      const busy = parentPost.mock.calls.filter(([message]) => message?.type === 'busy');
      expect(busy).toHaveLength(1);
      expect(busy[0][1]).toBe('https://rituals.app');
    } finally {
      top.mockRestore();
      parent.mockRestore();
    }
  });

  it('renders all seven stable regions in the steady QR-active state', async () => {
    mockCreateDeviceIdentity.mockResolvedValue({ publicKeyBase64: 'device-public-key' });
    mockCreateSessionKeyPair.mockResolvedValue({
      privateKey: { type: 'private-key' },
      publicKeyBase64: 'session-public-key',
    });
    mockCreateDeviceLinkRequest.mockResolvedValue({
      requestId: 'req-1',
      secret: 'secret-1',
      code: 'XW8GYSE3',
      expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    });
    mockBuildLinkApprovalUrl.mockReturnValue('https://app.gethush.live/link-device?payload=abc');
    mockQrToDataUrl.mockResolvedValue('data:image/png;base64,qr-code');
    mockConsumeDeviceLinkResult.mockResolvedValue({ status: 'pending' });

    renderLinkDevice('/link-device?mode=new');

    const qrImage = await screen.findByAltText(/device link qr code/i);
    const card = qrImage.closest('.ld-card');
    expect(card).not.toBeNull();

    // 1. title
    expect(card.querySelector('.home-section-title')?.textContent).toMatch(/Link this device/i);
    // 2. subtitle
    expect(card.querySelector('.ld-subtitle')).not.toBeNull();
    // 3. QR block: frame (with image), timer (countdown). Status microcopy
    // is intentionally absent — countdown carries the active signal.
    const qrBlock = card.querySelector('.ld-qr-block');
    expect(qrBlock).not.toBeNull();
    expect(qrBlock.dataset.state).toBe('active');
    expect(qrBlock.querySelector('.ld-qr-frame')?.contains(qrImage)).toBe(true);
    expect(qrBlock.querySelector('.ld-qr-timer')?.textContent).toMatch(/Expires in /);
    expect(qrBlock.textContent).not.toMatch(/Waiting for approval/i);
    expect(qrBlock.textContent).not.toMatch(/Preparing link/i);
    // 4. divider with "or use fallback code"
    const divider = card.querySelector('.ld-divider');
    expect(divider).not.toBeNull();
    expect(divider.textContent).toMatch(/or use fallback code/i);
    // 5. code block: real code present, copy enabled
    const codeBlock = card.querySelector('.ld-code-block');
    expect(codeBlock).not.toBeNull();
    const codeValue = codeBlock.querySelector('.ld-code-value');
    expect(codeValue?.dataset.state).toBe('ready');
    expect(codeValue?.textContent).toBe('XW8GYSE3');
    const copyBtn = codeBlock.querySelector('.ld-code-copy');
    expect(copyBtn).not.toBeNull();
    expect(copyBtn?.disabled).toBe(false);
    // 6. Rituals fork: no instance row (spaces always use this origin).
    expect(card.querySelector('.ld-instance-row')).toBeNull();
    // 7. footer: Back (left) + Regenerate (right), side-by-side. Back must
    // be the first child so it lands at the bottom-left edge.
    const footer = card.querySelector('.ld-footer');
    expect(footer).not.toBeNull();
    expect(footer.contains(screen.getByRole('button', { name: /regenerate/i }))).toBe(true);
    expect(footer.querySelector('.ld-back-link')).not.toBeNull();
    expect(footer.firstElementChild?.classList.contains('ld-back-link')).toBe(true);

    // The copy icon lives INSIDE the code cell, not as a sibling button.
    expect(codeBlock.contains(copyBtn)).toBe(true);
    // It is a plain icon-button (not a Hush Button with the .btn chrome).
    expect(copyBtn?.classList.contains('btn')).toBe(false);
  });

  it('keeps all seven regions in place during the generating/loading state (no collapse)', async () => {
    mockCreateDeviceIdentity.mockResolvedValue({ publicKeyBase64: 'device-public-key' });
    mockCreateSessionKeyPair.mockResolvedValue({
      privateKey: { type: 'private-key' },
      publicKeyBase64: 'session-public-key',
    });
    // Hold the request pending so requestState stays null and the loading UI sticks.
    mockCreateDeviceLinkRequest.mockImplementation(() => new Promise(() => {}));

    renderLinkDevice('/link-device?mode=new');

    // Wait until the placeholder for the loading state is mounted.
    const placeholder = await screen.findByText(/Generating link request/i);
    const card = placeholder.closest('.ld-card');
    expect(card).not.toBeNull();

    // All seven regions must still be present in the loading state.
    expect(card.querySelector('.home-section-title')).not.toBeNull();
    expect(card.querySelector('.ld-subtitle')).not.toBeNull();
    const qrBlock = card.querySelector('.ld-qr-block');
    expect(qrBlock).not.toBeNull();
    expect(qrBlock.dataset.state).toBe('pending');
    expect(qrBlock.querySelector('.ld-qr-frame')).not.toBeNull();
    expect(qrBlock.querySelector('.ld-qr-placeholder')).not.toBeNull();
    expect(qrBlock.querySelector('.ld-qr-timer')).not.toBeNull();
    // No "Preparing link…" / "Waiting for approval" microcopy in either state.
    expect(qrBlock.textContent).not.toMatch(/Preparing link/i);
    expect(qrBlock.textContent).not.toMatch(/Waiting for approval/i);
    expect(card.querySelector('.ld-divider')).not.toBeNull();
    // Code block exists with placeholder; copy button disabled (no code yet).
    const codeBlock = card.querySelector('.ld-code-block');
    expect(codeBlock).not.toBeNull();
    expect(codeBlock.querySelector('.ld-code-value')?.dataset.state).toBe('placeholder');
    const copyBtn = codeBlock.querySelector('.ld-code-copy');
    expect(copyBtn?.disabled).toBe(true);
    // Rituals fork: no instance row.
    expect(card.querySelector('.ld-instance-row')).toBeNull();
    const footer = card.querySelector('.ld-footer');
    expect(footer).not.toBeNull();
    expect(footer.querySelector('.ld-back-link')).not.toBeNull();
    expect(footer.contains(screen.getByRole('button', { name: /regenerate/i }))).toBe(true);
  });

  // Rituals fork: a non-http selection falls back to this page's origin,
  // never to the upstream hosted instance.
  it('anchors new-device requests and QR links to this origin when selection is app origin', async () => {
    authInstanceSelectionState.current = 'app://localhost';
    mockCreateDeviceIdentity.mockResolvedValue({ publicKeyBase64: 'device-public-key' });
    mockCreateSessionKeyPair.mockResolvedValue({
      privateKey: { type: 'private-key' },
      publicKeyBase64: 'session-public-key',
    });
    mockCreateDeviceLinkRequest.mockResolvedValue({
      requestId: 'req-desktop-origin',
      secret: 'secret-1',
      code: 'HUSH2026',
      expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    });
    mockBuildLinkApprovalUrl.mockReturnValue('https://app.gethush.live/link-device?payload=abc');
    mockQrToDataUrl.mockResolvedValue('data:image/png;base64,qr-code');

    renderLinkDevice('/link-device?mode=new');

    await screen.findByText('HUSH2026');
    expect(mockCreateDeviceLinkRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        instanceUrl: 'https://app.gethush.live',
      }),
      'https://app.gethush.live',
    );
    expect(mockBuildLinkApprovalUrl).toHaveBeenCalledWith(
      'https://app.gethush.live',
      expect.objectContaining({
        requestId: 'req-desktop-origin',
      }),
    );
  });

  it('keeps the layout intact across a regenerate transition (active → loading → active)', async () => {
    mockCreateDeviceIdentity.mockResolvedValue({ publicKeyBase64: 'device-public-key' });
    mockCreateSessionKeyPair.mockResolvedValue({
      privateKey: { type: 'private-key' },
      publicKeyBase64: 'session-public-key',
    });
    let resolveSecond;
    mockCreateDeviceLinkRequest
      .mockResolvedValueOnce({
        requestId: 'req-1',
        secret: 'secret-1',
        code: 'AAAA1111',
        expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      })
      .mockImplementationOnce(
        () => new Promise((resolve) => { resolveSecond = resolve; }),
      );
    mockBuildLinkApprovalUrl.mockReturnValue('https://app.gethush.live/link-device?payload=abc');
    mockQrToDataUrl.mockResolvedValue('data:image/png;base64,qr-code');
    mockConsumeDeviceLinkResult.mockResolvedValue({ status: 'pending' });

    renderLinkDevice('/link-device?mode=new');

    // Active state reached.
    const firstQr = await screen.findByAltText(/device link qr code/i);
    const card = firstQr.closest('.ld-card');
    expect(card.querySelector('.ld-qr-block')?.dataset.state).toBe('active');
    expect(card.querySelector('.ld-code-value')?.textContent).toBe('AAAA1111');

    // Click Regenerate → triggers a fresh createDeviceLinkRequest (held pending).
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /regenerate/i }));

    // While regenerating, QR slot reverts to placeholder, code reverts to placeholder,
    // but every region remains in place.
    await waitFor(() => {
      expect(card.querySelector('.ld-qr-block')?.dataset.state).toBe('pending');
    });
    expect(card.querySelector('.ld-qr-frame')).not.toBeNull();
    expect(card.querySelector('.ld-qr-placeholder')).not.toBeNull();
    expect(card.querySelector('.ld-qr-timer')).not.toBeNull();
    expect(card.querySelector('.ld-divider')).not.toBeNull();
    expect(card.querySelector('.ld-code-block')).not.toBeNull();
    expect(card.querySelector('.ld-code-value')?.dataset.state).toBe('placeholder');
    // Rituals fork: no instance row.
    expect(card.querySelector('.ld-instance-row')).toBeNull();
    expect(card.querySelector('.ld-footer')).not.toBeNull();

    // Resolve second request → state returns to active, regions still in place.
    resolveSecond({
      requestId: 'req-2',
      secret: 'secret-2',
      code: 'BBBB2222',
      expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    });

    await waitFor(() => {
      expect(card.querySelector('.ld-qr-block')?.dataset.state).toBe('active');
    });
    expect(card.querySelector('.ld-code-value')?.textContent).toBe('BBBB2222');
  });

  it('keeps the fallback code available when QR generation fails', async () => {
    mockCreateDeviceIdentity.mockResolvedValue({
      publicKeyBase64: 'device-public-key',
    });
    mockCreateSessionKeyPair.mockResolvedValue({
      privateKey: { type: 'private-key' },
      publicKeyBase64: 'session-public-key',
    });
    mockCreateDeviceLinkRequest.mockResolvedValue({
      requestId: 'req-1',
      secret: 'secret-1',
      code: 'ABCD1234',
      expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    });
    mockBuildLinkApprovalUrl.mockReturnValue('https://app.gethush.live/link-device?payload=abc');
    mockQrToDataUrl.mockRejectedValue(new Error('canvas unavailable'));
    mockConsumeDeviceLinkResult.mockResolvedValue({ status: 'pending' });

    renderLinkDevice('/link-device?mode=new');

    expect(await screen.findByText('ABCD1234')).toBeInTheDocument();
    expect(screen.queryByAltText(/device link qr code/i)).not.toBeInTheDocument();
    expect(screen.getByText(/qr unavailable\. use the fallback code below\./i)).toBeInTheDocument();
  });

  it('shows a request failure state when the new-device link request cannot be created', async () => {
    mockCreateDeviceIdentity.mockResolvedValue({
      publicKeyBase64: 'device-public-key',
    });
    mockCreateSessionKeyPair.mockResolvedValue({
      privateKey: { type: 'private-key' },
      publicKeyBase64: 'session-public-key',
    });
    mockCreateDeviceLinkRequest.mockRejectedValue(
      new Error('create device link request failed. Could not reach https://chat.example.com/api/auth/link-request.'),
    );

    renderLinkDevice('/link-device?mode=new');

    expect(await screen.findByText(/could not create link request\./i)).toBeInTheDocument();
    expect(screen.getByText(/could not reach https:\/\/chat\.example\.com\/api\/auth\/link-request/i)).toBeInTheDocument();
  });

  it('shows connection lost banner when poll fetch fails with a network error', async () => {
    mockCreateDeviceIdentity.mockResolvedValue({
      publicKeyBase64: 'device-public-key',
    });
    mockCreateSessionKeyPair.mockResolvedValue({
      privateKey: { type: 'private-key' },
      publicKeyBase64: 'session-public-key',
    });
    mockCreateDeviceLinkRequest.mockResolvedValue({
      requestId: 'req-1',
      secret: 'secret-1',
      code: 'ABCD1234',
      expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    });
    mockBuildLinkApprovalUrl.mockReturnValue('https://app.gethush.live/link-device?payload=abc');
    mockQrToDataUrl.mockResolvedValue('data:image/png;base64,qr-code');
    // Simulate persistent network failures
    mockConsumeDeviceLinkResult.mockRejectedValue(new TypeError('Failed to fetch'));

    renderLinkDevice('/link-device?mode=new');

    expect(await screen.findByAltText(/device link qr code/i)).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByText(/connection lost\. retrying/i)).toBeInTheDocument();
    });
  });

  it('keeps polling when the API layer wraps a poll network failure', async () => {
    mockCreateDeviceIdentity.mockResolvedValue({
      publicKeyBase64: 'device-public-key',
    });
    mockCreateSessionKeyPair.mockResolvedValue({
      privateKey: { type: 'private-key' },
      publicKeyBase64: 'session-public-key',
    });
    mockCreateDeviceLinkRequest.mockResolvedValue({
      requestId: 'req-1',
      secret: 'secret-1',
      code: 'ABCD1234',
      expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    });
    mockBuildLinkApprovalUrl.mockReturnValue('https://app.gethush.live/link-device?payload=abc');
    mockQrToDataUrl.mockResolvedValue('data:image/png;base64,qr-code');
    mockConsumeDeviceLinkResult
      .mockRejectedValueOnce(
        new Error('consume device link result failed. Could not reach https://app.gethush.live/api/auth/link-result.'),
      )
      .mockResolvedValue({ status: 'pending' });

    renderLinkDevice('/link-device?mode=new');

    expect(await screen.findByAltText(/device link qr code/i)).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByText(/connection lost\. retrying/i)).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(mockConsumeDeviceLinkResult).toHaveBeenCalledTimes(2);
    }, { timeout: 3000 });
  });

  it('cleans up the archive when new-device import fails', async () => {
    const completeDeviceLink = vi.fn();
    authState.current = {
      ...authState.current,
      completeDeviceLink,
    };
    mockCreateDeviceIdentity.mockResolvedValue({
      publicKeyBase64: 'device-public-key',
    });
    mockCreateSessionKeyPair.mockResolvedValue({
      privateKey: { type: 'private-key' },
      publicKeyBase64: 'session-public-key',
    });
    mockCreateDeviceLinkRequest.mockResolvedValue({
      requestId: 'req-1',
      secret: 'secret-1',
      code: 'ABCD1234',
      expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    });
    mockBuildLinkApprovalUrl.mockReturnValue('https://app.gethush.live/link-device?payload=abc');
    mockQrToDataUrl.mockResolvedValue('data:image/png;base64,qr-code');
    mockConsumeDeviceLinkResult.mockResolvedValue({
      relayCiphertext: 'ciphertext',
      relayIv: 'relay-iv',
      relayPublicKey: 'relay-public-key',
      deviceId: 'device-2',
      instanceUrl: 'https://chat.example.com',
    });
    mockDecodeTransferBundle.mockResolvedValue({
      version: 3,
      userId: 'user-1',
      username: 'alice',
      displayName: 'Alice',
      instanceUrl: 'https://chat.example.com',
      exportedAt: new Date().toISOString(),
      rootPrivateKey: new Uint8Array([1, 2, 3]),
      rootPublicKey: new Uint8Array([4, 5, 6]),
      archive: {
        id: 'arch-import-fail',
        downloadToken: 'dtok-import-fail',
        totalChunks: 1,
        totalBytes: 16,
        chunkSize: 4 * 1024 * 1024,
        manifestHash: 'bWFuaWZlc3Q=',
        archiveSha256: 'YXJjaGl2ZQ==',
        format: 'chunk-atomic-v1',
        chunkPlaintextHashes: ['Y2h1bmstaGFzaA=='],
        ephPub: 'ZXBocHViYnl0ZXM=',
        nonceBase: 'bm9uY2ViYXNl',
        transcriptBlobOmitted: false,
      },
      historySnapshot: null,
      guildMetadataKeySnapshot: null,
      transcriptBlob: null,
    });
    mockDownloadArchiveSession.mockRejectedValueOnce(new Error('boom'));

    renderLinkDevice('/link-device?mode=new');

    expect(await screen.findByAltText(/device link qr code/i)).toBeInTheDocument();
    await waitFor(() => {
      expect(mockDeleteArchive).toHaveBeenCalledWith(
        'arch-import-fail',
        { downloadToken: 'dtok-import-fail' },
        'https://chat.example.com',
      );
    });
    expect(completeDeviceLink).not.toHaveBeenCalled();
    expect(await screen.findByText(/boom/i)).toBeInTheDocument();
  });

  it('passes the originally selected/polled instanceUrl into completeDeviceLink', async () => {
    // Regression for PR #31: completion must enforce the device's
    // selected instance over the untrusted bundle field. The shell
    // delivers `requestState.instanceUrl` as the second arg so
    // useAuth.completeDeviceLink can fail closed on mismatch.
    const completeDeviceLink = vi.fn().mockResolvedValue(undefined);
    authState.current = {
      ...authState.current,
      completeDeviceLink,
    };
    mockCreateDeviceIdentity.mockResolvedValue({
      publicKeyBase64: 'device-public-key',
    });
    mockCreateSessionKeyPair.mockResolvedValue({
      privateKey: { type: 'private-key' },
      publicKeyBase64: 'session-public-key',
    });
    mockCreateDeviceLinkRequest.mockResolvedValue({
      requestId: 'req-trust-instance',
      secret: 'secret-1',
      code: 'TRUSTINST',
      expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    });
    mockBuildLinkApprovalUrl.mockReturnValue('https://app.gethush.live/link-device?payload=abc');
    mockQrToDataUrl.mockResolvedValue('data:image/png;base64,qr-code');
    mockConsumeDeviceLinkResult.mockResolvedValue({
      relayCiphertext: 'ciphertext',
      relayIv: 'relay-iv',
      relayPublicKey: 'relay-public-key',
      deviceId: 'device-2',
      // The selected/polled instance URL — must flow into
      // completeDeviceLink as the trusted base URL.
      instanceUrl: 'https://chat.example.com',
    });
    mockDecodeTransferBundle.mockResolvedValue({
      version: 3,
      userId: 'user-1',
      username: 'alice',
      displayName: 'Alice',
      instanceUrl: 'https://chat.example.com',
      exportedAt: new Date().toISOString(),
      rootPrivateKey: new Uint8Array([1, 2, 3]),
      rootPublicKey: new Uint8Array([4, 5, 6]),
      archive: null,
      historySnapshot: null,
      guildMetadataKeySnapshot: null,
      transcriptBlob: null,
    });

    renderLinkDevice('/link-device?mode=new');

    // The whole link flow completes quickly when there is no archive
    // to download, so we wait for the assertion target directly
    // rather than the QR (which may unmount immediately on success).
    await waitFor(() => {
      expect(completeDeviceLink).toHaveBeenCalledTimes(1);
    });
    expect(completeDeviceLink).toHaveBeenCalledWith(
      expect.objectContaining({
        rootPrivateKey: expect.any(Uint8Array),
        rootPublicKey: expect.any(Uint8Array),
        instanceUrl: 'https://chat.example.com',
      }),
      'https://chat.example.com',
    );
  });

  it('uses the selected instance, not bundle.instanceUrl, for archive import and cleanup', async () => {
    const completeDeviceLink = vi.fn().mockResolvedValue(undefined);
    authState.current = {
      ...authState.current,
      completeDeviceLink,
    };
    authInstanceSelectionState.current = 'https://selected.example.com';
    mockCreateDeviceIdentity.mockResolvedValue({
      publicKeyBase64: 'device-public-key',
    });
    mockCreateSessionKeyPair.mockResolvedValue({
      privateKey: { type: 'private-key' },
      publicKeyBase64: 'session-public-key',
    });
    mockCreateDeviceLinkRequest.mockResolvedValue({
      requestId: 'req-archive-trust-instance',
      secret: 'secret-1',
      code: 'ARCHINST',
      expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    });
    mockBuildLinkApprovalUrl.mockReturnValue('https://app.gethush.live/link-device?payload=abc');
    mockQrToDataUrl.mockResolvedValue('data:image/png;base64,qr-code');
    mockConsumeDeviceLinkResult.mockResolvedValue({
      relayCiphertext: 'ciphertext',
      relayIv: 'relay-iv',
      relayPublicKey: 'relay-public-key',
      deviceId: 'device-2',
      instanceUrl: 'https://selected.example.com',
    });
    mockDecodeTransferBundle.mockResolvedValue({
      version: 3,
      userId: 'user-1',
      username: 'alice',
      displayName: 'Alice',
      instanceUrl: 'https://bundle.example.com',
      exportedAt: new Date().toISOString(),
      rootPrivateKey: new Uint8Array([1, 2, 3]),
      rootPublicKey: new Uint8Array([4, 5, 6]),
      archive: {
        id: 'arch-selected-instance',
        downloadToken: 'dtok-selected-instance',
        totalChunks: 1,
        totalBytes: 16,
        chunkSize: 4 * 1024 * 1024,
        manifestHash: 'bWFuaWZlc3Q=',
        archiveSha256: 'YXJjaGl2ZQ==',
        format: 'chunk-atomic-v1',
        chunkPlaintextHashes: ['Y2h1bmstaGFzaA=='],
        ephPub: 'ZXBocHViYnl0ZXM=',
        nonceBase: 'bm9uY2ViYXNl',
        transcriptBlobOmitted: false,
      },
      historySnapshot: null,
      guildMetadataKeySnapshot: null,
      transcriptBlob: null,
    });

    renderLinkDevice('/link-device?mode=new');

    await waitFor(() => {
      expect(mockDownloadArchiveSession).toHaveBeenCalled();
    });
    expect(mockDownloadArchiveSession.mock.calls[0][0]).toMatchObject({
      baseUrl: 'https://selected.example.com',
    });
    expect(mockDeleteArchive).toHaveBeenCalledWith(
      'arch-selected-instance',
      { downloadToken: 'dtok-selected-instance' },
      'https://selected.example.com',
    );
    expect(completeDeviceLink).toHaveBeenCalledWith(
      expect.objectContaining({ instanceUrl: 'https://bundle.example.com' }),
      'https://selected.example.com',
    );
  });

  it('shows friendly error when ApproveLinkView resolveRequest fails with expired/claimed message', async () => {
    const user = userEvent.setup();
    authState.current = {
      completeDeviceLink: vi.fn(),
      loading: false,
      isAuthenticated: true,
      hasSession: true,
      hasVault: true,
      isVaultUnlocked: true,
      needsUnlock: false,
      vaultState: 'unlocked',
      token: 'jwt-token',
      user: { id: 'user-1', username: 'alice', displayName: 'Alice' },
      identityKeyRef: {
        current: {
          privateKey: new Uint8Array([1, 2, 3]),
          publicKey: new Uint8Array([4, 5, 6]),
        },
      },
    };

    mockResolveDeviceLinkRequest.mockRejectedValue(
      new Error('link request expired or already claimed'),
    );

    renderLinkDevice('/link-device');

    await user.type(screen.getByLabelText(/link code/i), 'ABCD1234');
    await user.click(screen.getByRole('button', { name: /resolve code/i }));

    await waitFor(() => {
      expect(screen.getByText(/code expired or already used/i)).toBeInTheDocument();
    });
  });

  it('prompts to unlock and resume when the browser vault is locked', async () => {
    const user = userEvent.setup();
    authState.current = {
      completeDeviceLink: vi.fn(),
      loading: false,
      isAuthenticated: false,
      hasSession: false,
      hasVault: true,
      isVaultUnlocked: false,
      needsUnlock: true,
      vaultState: 'locked',
      token: null,
      user: null,
      identityKeyRef: { current: null },
    };

    renderLinkDevice('/link-device?payload=valid-payload');

    expect(screen.getByText(/browser is recognized for your hush account/i)).toBeInTheDocument();
    expect(screen.getByText(/unlock this browser to resume approval automatically/i)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /unlock to approve/i }));

    await screen.findByText('Home');
  });

  it('shows the no-vault message when the browser has no unlockable vault', () => {
    renderLinkDevice('/link-device?payload=valid-payload');

    expect(screen.getByText(/already signed in to the account you want to link/i)).toBeInTheDocument();
    expect(screen.getByText(/does not have a local hush vault/i)).toBeInTheDocument();
  });

  it('shows generic linking failed error when ApproveLinkView handleApprove fails with cert error', async () => {
    const user = userEvent.setup();
    const historyDb = { close: vi.fn() };

    authState.current = {
      completeDeviceLink: vi.fn(),
      loading: false,
      isAuthenticated: true,
      hasSession: true,
      hasVault: true,
      isVaultUnlocked: true,
      needsUnlock: false,
      vaultState: 'unlocked',
      token: 'jwt-token',
      user: { id: 'user-1', username: 'alice', displayName: 'Alice' },
      identityKeyRef: {
        current: {
          privateKey: new Uint8Array([1, 2, 3]),
          publicKey: new Uint8Array([4, 5, 6]),
        },
      },
    };

    mockResolveDeviceLinkRequest.mockResolvedValue({
      claimToken: 'claim-1',
      deviceId: 'device-2',
      devicePublicKey: 'device-public-key',
      sessionPublicKey: 'session-public-key',
      instanceUrl: 'https://chat.example.com',
      expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    });
    mockOpenStore.mockResolvedValue(historyDb);
    mockExportHistorySnapshot.mockResolvedValue({ version: 1, stores: {} });
    mockEncodeTransferBundle.mockReturnValue(new Uint8Array([1, 2, 3]));
    mockBase64ToBytes.mockReturnValue(new Uint8Array([9, 9, 9]));
    mockCertifyDevice.mockResolvedValue(new Uint8Array([7, 7, 7]));
    mockBytesToBase64.mockReturnValue('certificate-base64');
    mockEncryptRelayPayload.mockResolvedValue({
      relayCiphertext: 'ciphertext',
      relayIv: 'relay-iv',
      relayPublicKey: 'relay-public-key',
    });
    mockVerifyDeviceLinkRequest.mockRejectedValue(
      new Error('Linking failed. Please try again.'),
    );

    renderLinkDevice('/link-device');

    await user.type(screen.getByLabelText(/link code/i), 'abcd1234');
    await user.click(screen.getByRole('button', { name: /resolve code/i }));
    expect(await screen.findByText('device-2')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /approve link/i }));

    await waitFor(() => {
      expect(screen.getByText(/linking failed\. please try again\./i)).toBeInTheDocument();
    });
  });

  it('resolves a fallback code and approves the requested device', async () => {
    const user = userEvent.setup();
    const historyDb = { close: vi.fn() };

    authState.current = {
      completeDeviceLink: vi.fn(),
      loading: false,
      isAuthenticated: true,
      hasSession: true,
      hasVault: true,
      isVaultUnlocked: true,
      needsUnlock: false,
      vaultState: 'unlocked',
      token: 'jwt-token',
      user: { id: 'user-1', username: 'alice', displayName: 'Alice' },
      identityKeyRef: {
        current: {
          privateKey: new Uint8Array([1, 2, 3]),
          publicKey: new Uint8Array([4, 5, 6]),
        },
      },
    };

    mockResolveDeviceLinkRequest.mockResolvedValue({
      claimToken: 'claim-1',
      deviceId: 'device-2',
      devicePublicKey: 'device-public-key',
      sessionPublicKey: 'session-public-key',
      instanceUrl: 'https://chat.example.com',
      expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    });
    mockOpenStore.mockResolvedValue(historyDb);
    mockExportHistorySnapshot.mockResolvedValue({ version: 1, stores: {} });
    mockEncodeTransferBundle.mockReturnValue(new Uint8Array([1, 2, 3]));
    mockBase64ToBytes.mockReturnValue(new Uint8Array([9, 9, 9]));
    mockCertifyDevice.mockResolvedValue(new Uint8Array([7, 7, 7]));
    mockBytesToBase64.mockReturnValue('certificate-base64');
    mockEncryptRelayPayload.mockResolvedValue({
      relayCiphertext: 'ciphertext',
      relayIv: 'relay-iv',
      relayPublicKey: 'relay-public-key',
    });
    mockVerifyDeviceLinkRequest.mockResolvedValue(undefined);

    renderLinkDevice('/link-device');

    await user.type(screen.getByLabelText(/link code/i), 'abcd1234');
    await user.click(screen.getByRole('button', { name: /resolve code/i }));

    expect(await screen.findByText('device-2')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /approve link/i }));

    await waitFor(() => {
      expect(mockVerifyDeviceLinkRequest).toHaveBeenCalledWith(
        'tok',
        {
          claimToken: 'claim-1',
          certificate: 'certificate-base64',
          signingDeviceId: 'device-1',
          relayCiphertext: 'ciphertext',
          relayIv: 'relay-iv',
          relayPublicKey: 'relay-public-key',
        },
        'https://chat.example.com',
      );
    });
    expect(historyDb.close).toHaveBeenCalledTimes(1);
  });

  it('ignores an untrusted claim instance URL for export and verify API calls', async () => {
    const user = userEvent.setup();
    const historyDb = { close: vi.fn() };

    authState.current = {
      completeDeviceLink: vi.fn(),
      loading: false,
      isAuthenticated: true,
      hasSession: true,
      hasVault: true,
      isVaultUnlocked: true,
      needsUnlock: false,
      vaultState: 'unlocked',
      token: 'jwt-token',
      user: { id: 'user-1', username: 'alice', displayName: 'Alice' },
      identityKeyRef: {
        current: {
          privateKey: new Uint8Array([1, 2, 3]),
          publicKey: new Uint8Array([4, 5, 6]),
        },
      },
    };

    mockResolveDeviceLinkRequest.mockResolvedValue({
      claimToken: 'claim-1',
      deviceId: 'device-2',
      devicePublicKey: 'device-public-key',
      sessionPublicKey: 'session-public-key',
      instanceUrl: 'https://evil.example',
      expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    });
    mockOpenStore.mockResolvedValue(historyDb);
    mockExportHistorySnapshot.mockResolvedValue({ version: 1, stores: {} });
    mockEncodeTransferBundle.mockReturnValue(new Uint8Array([1, 2, 3]));
    mockBase64ToBytes.mockReturnValue(new Uint8Array([9, 9, 9]));
    mockCertifyDevice.mockResolvedValue(new Uint8Array([7, 7, 7]));
    mockBytesToBase64.mockReturnValue('certificate-base64');
    mockEncryptRelayPayload.mockResolvedValue({
      relayCiphertext: 'ciphertext',
      relayIv: 'relay-iv',
      relayPublicKey: 'relay-public-key',
    });
    mockVerifyDeviceLinkRequest.mockResolvedValue(undefined);

    renderLinkDevice('/link-device');

    await user.type(screen.getByLabelText(/link code/i), 'abcd1234');
    await user.click(screen.getByRole('button', { name: /resolve code/i }));
    expect(await screen.findByText('device-2')).toBeInTheDocument();
    expect(screen.getByText('https://chat.example.com')).toBeInTheDocument();
    expect(screen.queryByText('https://evil.example')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /approve link/i }));

    await waitFor(() => {
      expect(mockVerifyDeviceLinkRequest).toHaveBeenCalled();
    });
    expect(mockPreDecryptForLinkExport).toHaveBeenCalledWith(expect.objectContaining({
      baseUrl: 'https://chat.example.com',
    }));
    expect(mockUploadArchiveSession).toHaveBeenCalledWith(expect.objectContaining({
      baseUrl: 'https://chat.example.com',
    }));
    expect(mockVerifyDeviceLinkRequest).toHaveBeenCalledWith(
      'tok',
      expect.objectContaining({ claimToken: 'claim-1' }),
      'https://chat.example.com',
    );
  });

  it('runs preDecryptForLinkExport before exportHistorySnapshot during approval', async () => {
    const user = userEvent.setup();
    const historyDb = { close: vi.fn() };

    authState.current = {
      completeDeviceLink: vi.fn(),
      loading: false,
      isAuthenticated: true,
      hasSession: true,
      hasVault: true,
      isVaultUnlocked: true,
      needsUnlock: false,
      vaultState: 'unlocked',
      token: 'jwt-token',
      user: { id: 'user-1', username: 'alice', displayName: 'Alice' },
      identityKeyRef: {
        current: {
          privateKey: new Uint8Array([1, 2, 3]),
          publicKey: new Uint8Array([4, 5, 6]),
        },
      },
    };

    mockResolveDeviceLinkRequest.mockResolvedValue({
      claimToken: 'claim-1',
      deviceId: 'device-2',
      devicePublicKey: 'device-public-key',
      sessionPublicKey: 'session-public-key',
      instanceUrl: 'https://chat.example.com',
      expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    });
    mockOpenStore.mockResolvedValue(historyDb);
    mockExportHistorySnapshot.mockResolvedValue({ version: 1, stores: {} });
    mockEncodeTransferBundle.mockReturnValue(new Uint8Array([1, 2, 3]));
    mockBase64ToBytes.mockReturnValue(new Uint8Array([9, 9, 9]));
    mockCertifyDevice.mockResolvedValue(new Uint8Array([7, 7, 7]));
    mockBytesToBase64.mockReturnValue('certificate-base64');
    mockEncryptRelayPayload.mockResolvedValue({
      relayCiphertext: 'ciphertext',
      relayIv: 'relay-iv',
      relayPublicKey: 'relay-public-key',
    });
    mockVerifyDeviceLinkRequest.mockResolvedValue(undefined);

    renderLinkDevice('/link-device');

    await user.type(screen.getByLabelText(/link code/i), 'abcd1234');
    await user.click(screen.getByRole('button', { name: /resolve code/i }));
    expect(await screen.findByText('device-2')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /approve link/i }));

    await waitFor(() => {
      expect(mockVerifyDeviceLinkRequest).toHaveBeenCalled();
    });

    expect(mockPreDecryptForLinkExport).toHaveBeenCalledWith(expect.objectContaining({
      activeDb: historyDb,
      token: 'tok',
      baseUrl: 'https://chat.example.com',
    }));
    expect(mockExportHistorySnapshot).toHaveBeenCalled();
    const preDecryptOrder = mockPreDecryptForLinkExport.mock.invocationCallOrder[0];
    const exportOrder = mockExportHistorySnapshot.mock.invocationCallOrder[0];
    expect(preDecryptOrder).toBeLessThan(exportOrder);
  });

  it('seals harvested local plaintexts into an encrypted transcript blob and includes it in the transfer bundle', async () => {
    const user = userEvent.setup();
    const historyDb = { close: vi.fn() };
    const harvestedRows = [
      { messageId: 'm1', plaintext: 'hi', senderId: 'alice', timestamp: 1 },
      { messageId: 'm2', plaintext: 'bye', senderId: 'bob', timestamp: 2 },
    ];
    const sealedBlob = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 99, 100]);

    authState.current = {
      completeDeviceLink: vi.fn(),
      loading: false,
      isAuthenticated: true,
      hasSession: true,
      hasVault: true,
      isVaultUnlocked: true,
      needsUnlock: false,
      vaultState: 'unlocked',
      token: 'jwt-token',
      user: { id: 'user-1', username: 'alice', displayName: 'Alice' },
      identityKeyRef: {
        current: {
          privateKey: new Uint8Array(32).fill(7),
          publicKey: new Uint8Array(32).fill(8),
        },
      },
    };

    mockResolveDeviceLinkRequest.mockResolvedValue({
      claimToken: 'claim-1',
      deviceId: 'device-2',
      devicePublicKey: 'device-public-key',
      sessionPublicKey: 'session-public-key',
      instanceUrl: 'https://chat.example.com',
      expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    });
    mockOpenStore.mockResolvedValue(historyDb);
    mockExportHistorySnapshot.mockResolvedValue({ version: 1, stores: {} });
    mockEncodeTransferBundle.mockReturnValue(new Uint8Array([1, 2, 3]));
    mockBase64ToBytes.mockReturnValue(new Uint8Array([9, 9, 9]));
    mockCertifyDevice.mockResolvedValue(new Uint8Array([7, 7, 7]));
    mockBytesToBase64.mockReturnValue('certificate-base64');
    mockEncryptRelayPayload.mockResolvedValue({
      relayCiphertext: 'ciphertext',
      relayIv: 'relay-iv',
      relayPublicKey: 'relay-public-key',
    });
    mockVerifyDeviceLinkRequest.mockResolvedValue(undefined);
    mockListAllLocalPlaintexts.mockResolvedValue(harvestedRows);
    mockBuildTranscriptBlobForExport.mockResolvedValue(sealedBlob);

    renderLinkDevice('/link-device');

    await user.type(screen.getByLabelText(/link code/i), 'abcd1234');
    await user.click(screen.getByRole('button', { name: /resolve code/i }));
    expect(await screen.findByText('device-2')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /approve link/i }));

    await waitFor(() => {
      expect(mockVerifyDeviceLinkRequest).toHaveBeenCalled();
    });

    expect(mockListAllLocalPlaintexts).toHaveBeenCalledWith(historyDb);
    expect(mockBuildTranscriptBlobForExport).toHaveBeenCalledWith(
      authState.current.identityKeyRef.current.privateKey,
      harvestedRows,
    );
    // v3: transcriptBlob now ships through the chunked archive plane,
    // not inline in the small relay envelope.
    expect(mockUploadArchiveSession).toHaveBeenCalledWith(expect.objectContaining({
      transcriptBlob: sealedBlob,
    }));
    expect(mockEncodeTransferBundle).toHaveBeenCalledWith(expect.objectContaining({
      archive: expect.objectContaining({
        id: 'arch-test',
        downloadToken: 'dtok-test',
        format: 'chunk-atomic-v1',
        chunkPlaintextHashes: ['Y2h1bmstaGFzaA=='],
      }),
    }));
  });

  it('falls back to a null transcriptBlob when there are no plaintext rows to seal', async () => {
    const user = userEvent.setup();
    const historyDb = { close: vi.fn() };

    authState.current = {
      completeDeviceLink: vi.fn(),
      loading: false,
      isAuthenticated: true,
      hasSession: true,
      hasVault: true,
      isVaultUnlocked: true,
      needsUnlock: false,
      vaultState: 'unlocked',
      token: 'jwt-token',
      user: { id: 'user-1', username: 'alice', displayName: 'Alice' },
      identityKeyRef: {
        current: {
          privateKey: new Uint8Array(32).fill(1),
          publicKey: new Uint8Array(32).fill(2),
        },
      },
    };

    mockResolveDeviceLinkRequest.mockResolvedValue({
      claimToken: 'claim-1',
      deviceId: 'device-2',
      devicePublicKey: 'device-public-key',
      sessionPublicKey: 'session-public-key',
      instanceUrl: 'https://chat.example.com',
      expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    });
    mockOpenStore.mockResolvedValue(historyDb);
    mockExportHistorySnapshot.mockResolvedValue({ version: 1, stores: {} });
    mockEncodeTransferBundle.mockReturnValue(new Uint8Array([1, 2, 3]));
    mockBase64ToBytes.mockReturnValue(new Uint8Array([9, 9, 9]));
    mockCertifyDevice.mockResolvedValue(new Uint8Array([7, 7, 7]));
    mockBytesToBase64.mockReturnValue('certificate-base64');
    mockEncryptRelayPayload.mockResolvedValue({
      relayCiphertext: 'ciphertext',
      relayIv: 'relay-iv',
      relayPublicKey: 'relay-public-key',
    });
    mockVerifyDeviceLinkRequest.mockResolvedValue(undefined);
    mockListAllLocalPlaintexts.mockResolvedValue([]); // explicit: nothing to seal

    renderLinkDevice('/link-device');

    await user.type(screen.getByLabelText(/link code/i), 'abcd1234');
    await user.click(screen.getByRole('button', { name: /resolve code/i }));
    expect(await screen.findByText('device-2')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /approve link/i }));

    await waitFor(() => {
      expect(mockVerifyDeviceLinkRequest).toHaveBeenCalled();
    });

    expect(mockBuildTranscriptBlobForExport).not.toHaveBeenCalled();
    expect(mockUploadArchiveSession).toHaveBeenCalledWith(expect.objectContaining({
      transcriptBlob: null,
    }));
  });

  it('exports transcript cache rows when localPlaintext is empty', async () => {
    const user = userEvent.setup();
    const historyDb = { close: vi.fn() };
    const cacheRows = [
      { messageId: 'cache-1', plaintext: 'hello', senderId: 'alice', timestamp: 100 },
      { messageId: 'cache-2', plaintext: 'world', senderId: 'bob', timestamp: 200 },
    ];
    const sealedBlob = new Uint8Array([1, 2, 3, 4, 5]);

    authState.current = {
      completeDeviceLink: vi.fn(),
      loading: false,
      isAuthenticated: true,
      hasSession: true,
      hasVault: true,
      isVaultUnlocked: true,
      needsUnlock: false,
      vaultState: 'unlocked',
      token: 'jwt-token',
      user: { id: 'user-1', username: 'alice', displayName: 'Alice' },
      identityKeyRef: {
        current: {
          privateKey: new Uint8Array(32).fill(7),
          publicKey: new Uint8Array(32).fill(8),
        },
      },
    };

    mockResolveDeviceLinkRequest.mockResolvedValue({
      claimToken: 'claim-1',
      deviceId: 'device-2',
      devicePublicKey: 'device-public-key',
      sessionPublicKey: 'session-public-key',
      instanceUrl: 'https://chat.example.com',
      expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    });
    mockOpenStore.mockResolvedValue(historyDb);
    mockExportHistorySnapshot.mockResolvedValue({ version: 1, stores: {} });
    mockEncodeTransferBundle.mockReturnValue(new Uint8Array([1, 2, 3]));
    mockBase64ToBytes.mockReturnValue(new Uint8Array([9, 9, 9]));
    mockCertifyDevice.mockResolvedValue(new Uint8Array([7, 7, 7]));
    mockBytesToBase64.mockReturnValue('certificate-base64');
    mockEncryptRelayPayload.mockResolvedValue({
      relayCiphertext: 'ciphertext',
      relayIv: 'relay-iv',
      relayPublicKey: 'relay-public-key',
    });
    mockVerifyDeviceLinkRequest.mockResolvedValue(undefined);
    mockListAllLocalPlaintexts.mockResolvedValue([]);
    mockListTranscriptCacheEntries.mockReturnValue(cacheRows);
    mockBuildTranscriptBlobForExport.mockResolvedValue(sealedBlob);

    renderLinkDevice('/link-device');

    await user.type(screen.getByLabelText(/link code/i), 'abcd1234');
    await user.click(screen.getByRole('button', { name: /resolve code/i }));
    expect(await screen.findByText('device-2')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /approve link/i }));

    await waitFor(() => {
      expect(mockVerifyDeviceLinkRequest).toHaveBeenCalled();
    });

    expect(mockBuildTranscriptBlobForExport).toHaveBeenCalledTimes(1);
    const sealedRows = mockBuildTranscriptBlobForExport.mock.calls[0][1];
    const sealedIds = sealedRows.map((row) => row.messageId).sort();
    expect(sealedIds).toEqual(['cache-1', 'cache-2']);
    expect(mockUploadArchiveSession).toHaveBeenCalledWith(expect.objectContaining({
      transcriptBlob: sealedBlob,
    }));
  });

  it('deduplicates by messageId and prefers localPlaintext over the transcript cache', async () => {
    const user = userEvent.setup();
    const historyDb = { close: vi.fn() };
    const localPlaintextRows = [
      { messageId: 'shared-1', plaintext: 'authoritative', senderId: 'alice', timestamp: 1000 },
      { messageId: 'local-only', plaintext: 'mls-only', senderId: 'alice', timestamp: 1100 },
    ];
    const cacheRows = [
      { messageId: 'shared-1', plaintext: 'STALE', senderId: 'alice', timestamp: 1 },
      { messageId: 'cache-only', plaintext: 'cache-only-text', senderId: 'bob', timestamp: 1200 },
    ];

    authState.current = {
      completeDeviceLink: vi.fn(),
      loading: false,
      isAuthenticated: true,
      hasSession: true,
      hasVault: true,
      isVaultUnlocked: true,
      needsUnlock: false,
      vaultState: 'unlocked',
      token: 'jwt-token',
      user: { id: 'user-1', username: 'alice', displayName: 'Alice' },
      identityKeyRef: {
        current: {
          privateKey: new Uint8Array(32).fill(7),
          publicKey: new Uint8Array(32).fill(8),
        },
      },
    };

    mockResolveDeviceLinkRequest.mockResolvedValue({
      claimToken: 'claim-1',
      deviceId: 'device-2',
      devicePublicKey: 'device-public-key',
      sessionPublicKey: 'session-public-key',
      instanceUrl: 'https://chat.example.com',
      expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    });
    mockOpenStore.mockResolvedValue(historyDb);
    mockExportHistorySnapshot.mockResolvedValue({ version: 1, stores: {} });
    mockEncodeTransferBundle.mockReturnValue(new Uint8Array([1, 2, 3]));
    mockBase64ToBytes.mockReturnValue(new Uint8Array([9, 9, 9]));
    mockCertifyDevice.mockResolvedValue(new Uint8Array([7, 7, 7]));
    mockBytesToBase64.mockReturnValue('certificate-base64');
    mockEncryptRelayPayload.mockResolvedValue({
      relayCiphertext: 'ciphertext',
      relayIv: 'relay-iv',
      relayPublicKey: 'relay-public-key',
    });
    mockVerifyDeviceLinkRequest.mockResolvedValue(undefined);
    mockListAllLocalPlaintexts.mockResolvedValue(localPlaintextRows);
    mockListTranscriptCacheEntries.mockReturnValue(cacheRows);

    renderLinkDevice('/link-device');

    await user.type(screen.getByLabelText(/link code/i), 'abcd1234');
    await user.click(screen.getByRole('button', { name: /resolve code/i }));
    expect(await screen.findByText('device-2')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /approve link/i }));

    await waitFor(() => {
      expect(mockVerifyDeviceLinkRequest).toHaveBeenCalled();
    });

    expect(mockBuildTranscriptBlobForExport).toHaveBeenCalledTimes(1);
    const sealedRows = mockBuildTranscriptBlobForExport.mock.calls[0][1];
    expect(sealedRows).toHaveLength(3);
    const byId = new Map(sealedRows.map((row) => [row.messageId, row]));
    expect(byId.get('shared-1').plaintext).toBe('authoritative');
    expect(byId.get('local-only').plaintext).toBe('mls-only');
    expect(byId.get('cache-only').plaintext).toBe('cache-only-text');
  });

  it('falls back to localPlaintext rows when the transcript cache read throws', async () => {
    const user = userEvent.setup();
    const historyDb = { close: vi.fn() };
    const localPlaintextRows = [
      { messageId: 'm1', plaintext: 'kept', senderId: 'alice', timestamp: 1 },
    ];

    authState.current = {
      completeDeviceLink: vi.fn(),
      loading: false,
      isAuthenticated: true,
      hasSession: true,
      hasVault: true,
      isVaultUnlocked: true,
      needsUnlock: false,
      vaultState: 'unlocked',
      token: 'jwt-token',
      user: { id: 'user-1', username: 'alice', displayName: 'Alice' },
      identityKeyRef: {
        current: {
          privateKey: new Uint8Array(32).fill(7),
          publicKey: new Uint8Array(32).fill(8),
        },
      },
    };

    mockResolveDeviceLinkRequest.mockResolvedValue({
      claimToken: 'claim-1',
      deviceId: 'device-2',
      devicePublicKey: 'device-public-key',
      sessionPublicKey: 'session-public-key',
      instanceUrl: 'https://chat.example.com',
      expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    });
    mockOpenStore.mockResolvedValue(historyDb);
    mockExportHistorySnapshot.mockResolvedValue({ version: 1, stores: {} });
    mockEncodeTransferBundle.mockReturnValue(new Uint8Array([1, 2, 3]));
    mockBase64ToBytes.mockReturnValue(new Uint8Array([9, 9, 9]));
    mockCertifyDevice.mockResolvedValue(new Uint8Array([7, 7, 7]));
    mockBytesToBase64.mockReturnValue('certificate-base64');
    mockEncryptRelayPayload.mockResolvedValue({
      relayCiphertext: 'ciphertext',
      relayIv: 'relay-iv',
      relayPublicKey: 'relay-public-key',
    });
    mockVerifyDeviceLinkRequest.mockResolvedValue(undefined);
    mockListAllLocalPlaintexts.mockResolvedValue(localPlaintextRows);
    mockListTranscriptCacheEntries.mockImplementation(() => {
      throw new Error('cache offline');
    });

    renderLinkDevice('/link-device');

    await user.type(screen.getByLabelText(/link code/i), 'abcd1234');
    await user.click(screen.getByRole('button', { name: /resolve code/i }));
    expect(await screen.findByText('device-2')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /approve link/i }));

    await waitFor(() => {
      expect(mockVerifyDeviceLinkRequest).toHaveBeenCalled();
    });

    expect(mockBuildTranscriptBlobForExport).toHaveBeenCalledTimes(1);
    const sealedRows = mockBuildTranscriptBlobForExport.mock.calls[0][1];
    expect(sealedRows).toEqual(localPlaintextRows);
  });

  it('still completes link approval if preDecryptForLinkExport throws', async () => {
    const user = userEvent.setup();
    const historyDb = { close: vi.fn() };

    authState.current = {
      completeDeviceLink: vi.fn(),
      loading: false,
      isAuthenticated: true,
      hasSession: true,
      hasVault: true,
      isVaultUnlocked: true,
      needsUnlock: false,
      vaultState: 'unlocked',
      token: 'jwt-token',
      user: { id: 'user-1', username: 'alice', displayName: 'Alice' },
      identityKeyRef: {
        current: {
          privateKey: new Uint8Array([1, 2, 3]),
          publicKey: new Uint8Array([4, 5, 6]),
        },
      },
    };

    mockResolveDeviceLinkRequest.mockResolvedValue({
      claimToken: 'claim-1',
      deviceId: 'device-2',
      devicePublicKey: 'device-public-key',
      sessionPublicKey: 'session-public-key',
      instanceUrl: 'https://chat.example.com',
      expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    });
    mockOpenStore.mockResolvedValue(historyDb);
    mockExportHistorySnapshot.mockResolvedValue({ version: 1, stores: {} });
    mockEncodeTransferBundle.mockReturnValue(new Uint8Array([1, 2, 3]));
    mockBase64ToBytes.mockReturnValue(new Uint8Array([9, 9, 9]));
    mockCertifyDevice.mockResolvedValue(new Uint8Array([7, 7, 7]));
    mockBytesToBase64.mockReturnValue('certificate-base64');
    mockEncryptRelayPayload.mockResolvedValue({
      relayCiphertext: 'ciphertext',
      relayIv: 'relay-iv',
      relayPublicKey: 'relay-public-key',
    });
    mockVerifyDeviceLinkRequest.mockResolvedValue(undefined);
    mockPreDecryptForLinkExport.mockRejectedValueOnce(new Error('boom'));

    renderLinkDevice('/link-device');

    await user.type(screen.getByLabelText(/link code/i), 'abcd1234');
    await user.click(screen.getByRole('button', { name: /resolve code/i }));
    expect(await screen.findByText('device-2')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /approve link/i }));

    await waitFor(() => {
      expect(mockVerifyDeviceLinkRequest).toHaveBeenCalled();
    });
    expect(mockExportHistorySnapshot).toHaveBeenCalled();
  });

  it('copies the fallback code to the clipboard when the Copy button is clicked', async () => {
    const user = userEvent.setup();
    mockCreateDeviceIdentity.mockResolvedValue({ publicKeyBase64: 'device-public-key' });
    mockCreateSessionKeyPair.mockResolvedValue({
      privateKey: { type: 'private-key' }, publicKeyBase64: 'session-public-key',
    });
    mockCreateDeviceLinkRequest.mockResolvedValue({
      requestId: 'req-1',
      secret: 'secret-1',
      code: 'ABCD1234',
      expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    });
    mockBuildLinkApprovalUrl.mockReturnValue('https://app.gethush.live/link-device?payload=abc');
    mockQrToDataUrl.mockResolvedValue('data:image/png;base64,qr-code');
    mockConsumeDeviceLinkResult.mockResolvedValue({ status: 'pending' });

    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText }, configurable: true,
    });

    renderLinkDevice('/link-device?mode=new');
    await screen.findByText('ABCD1234');
    await user.click(screen.getByRole('button', { name: /copy device link code/i }));

    expect(writeText).toHaveBeenCalledWith('ABCD1234');
    // Icons-only button: success state surfaces via data-state, not text.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /copy device link code/i }))
        .toHaveAttribute('data-state', 'copied');
    });
  });

  it('renders the Scan-QR button on the approve view (manual code path is preserved)', async () => {
    authState.current = {
      completeDeviceLink: vi.fn(),
      loading: false,
      isAuthenticated: true,
      hasSession: true,
      hasVault: true,
      isVaultUnlocked: true,
      needsUnlock: false,
      vaultState: 'unlocked',
      token: 'jwt-token',
      user: { id: 'user-1', username: 'alice', displayName: 'Alice' },
      identityKeyRef: {
        current: { privateKey: new Uint8Array([1]), publicKey: new Uint8Array([2]) },
      },
    };
    renderLinkDevice('/link-device');
    expect(await screen.findByRole('button', { name: /scan qr code with camera/i })).toBeInTheDocument();
    // Manual entry input still present.
    expect(screen.getByLabelText(/link code/i)).toBeInTheDocument();
  });

  // ── Resume / discard UX (durable OLD-device upload resume) ────────────
  describe('resumable export UX', () => {
    function unlockedAuth() {
      return {
        completeDeviceLink: vi.fn(),
        loading: false,
        isAuthenticated: true,
        hasSession: true,
        hasVault: true,
        isVaultUnlocked: true,
        needsUnlock: false,
        vaultState: 'unlocked',
        token: 'jwt-token',
        user: { id: 'user-1', username: 'alice', displayName: 'Alice' },
        identityKeyRef: {
          current: {
            privateKey: new Uint8Array([1, 2, 3]),
            publicKey: new Uint8Array([4, 5, 6]),
          },
        },
      };
    }
    function lockedAuth() {
      return {
        completeDeviceLink: vi.fn(),
        loading: false,
        isAuthenticated: true,
        hasSession: true,
        hasVault: true,
        isVaultUnlocked: false,
        needsUnlock: true,
        vaultState: 'locked',
        token: null,
        user: null,
        identityKeyRef: { current: null },
      };
    }
    function setupClaimResolution() {
      mockResolveDeviceLinkRequest.mockResolvedValue({
        claimToken: 'claim-1',
        deviceId: 'device-2',
        devicePublicKey: 'device-public-key',
        sessionPublicKey: 'session-public-key',
        instanceUrl: 'https://chat.example.com',
        expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      });
      mockEncodeTransferBundle.mockReturnValue(new Uint8Array([1, 2, 3]));
      mockBase64ToBytes.mockReturnValue(new Uint8Array([9, 9, 9]));
      mockCertifyDevice.mockResolvedValue(new Uint8Array([7, 7, 7]));
      mockBytesToBase64.mockReturnValue('certificate-base64');
      mockEncryptRelayPayload.mockResolvedValue({
        relayCiphertext: 'ciphertext',
        relayIv: 'relay-iv',
        relayPublicKey: 'relay-public-key',
      });
      mockVerifyDeviceLinkRequest.mockResolvedValue(undefined);
    }

    const sampleResumable = {
      archiveId: 'arch-prior',
      baseUrl: 'https://chat.example.com',
      backendKind: 's3',
      totalChunks: 1,
      status: 'in_progress',
    };

    it('detects a resumable export and shows the resume/discard banner', async () => {
      authState.current = unlockedAuth();
      setupClaimResolution();
      mockFindResumableExport.mockResolvedValue(sampleResumable);

      const user = userEvent.setup();
      renderLinkDevice('/link-device');
      await user.type(screen.getByLabelText(/link code/i), 'abcd1234');
      await user.click(screen.getByRole('button', { name: /resolve code/i }));

      // Resume banner appears with both choices, no auto-resume.
      expect(await screen.findByTestId('ld-resume-banner')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /resume upload/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /discard and start fresh/i })).toBeInTheDocument();
      // Approve-link button is hidden until the user makes a choice.
      expect(screen.queryByRole('button', { name: /approve link/i })).not.toBeInTheDocument();
      // Resume must NOT have been called automatically.
      expect(mockResumeUploadArchiveSession).not.toHaveBeenCalled();
    });

    it('resume button calls resumeUploadArchiveSession and continues the link flow', async () => {
      authState.current = unlockedAuth();
      setupClaimResolution();
      mockFindResumableExport.mockResolvedValue(sampleResumable);

      const user = userEvent.setup();
      renderLinkDevice('/link-device');
      await user.type(screen.getByLabelText(/link code/i), 'abcd1234');
      await user.click(screen.getByRole('button', { name: /resolve code/i }));
      await screen.findByTestId('ld-resume-banner');

      await user.click(screen.getByRole('button', { name: /resume upload/i }));

      await waitFor(() => {
        expect(mockResumeUploadArchiveSession).toHaveBeenCalledTimes(1);
      });
      const args = mockResumeUploadArchiveSession.mock.calls[0][0];
      expect(args.exportRecord).toEqual(sampleResumable);
      expect(args.token).toBe('tok');
      expect(args.baseUrl).toBe('https://chat.example.com');
      // Fresh upload path is NOT taken when resume is chosen.
      expect(mockUploadArchiveSession).not.toHaveBeenCalled();
      // Link verification happens with the resumed descriptor.
      // Third arg is the trusted auth instance URL, not claim.instanceUrl.
      await waitFor(() => {
        expect(mockVerifyDeviceLinkRequest).toHaveBeenCalledWith(
          'tok',
          expect.objectContaining({ claimToken: 'claim-1' }),
          'https://chat.example.com',
        );
      });
    });

    it('ignores an untrusted claim instance URL when resuming an upload', async () => {
      authState.current = unlockedAuth();
      setupClaimResolution();
      mockResolveDeviceLinkRequest.mockResolvedValue({
        claimToken: 'claim-1',
        deviceId: 'device-2',
        devicePublicKey: 'device-public-key',
        sessionPublicKey: 'session-public-key',
        instanceUrl: 'https://evil.example',
        expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      });
      mockFindResumableExport.mockResolvedValue({
        ...sampleResumable,
        baseUrl: 'https://evil.example',
      });

      const user = userEvent.setup();
      renderLinkDevice('/link-device');
      await user.type(screen.getByLabelText(/link code/i), 'abcd1234');
      await user.click(screen.getByRole('button', { name: /resolve code/i }));
      await screen.findByTestId('ld-resume-banner');

      await user.click(screen.getByRole('button', { name: /resume upload/i }));

      await waitFor(() => {
        expect(mockResumeUploadArchiveSession).toHaveBeenCalledTimes(1);
      });
      const args = mockResumeUploadArchiveSession.mock.calls[0][0];
      expect(args.baseUrl).toBe('https://chat.example.com');
      await waitFor(() => {
        expect(mockVerifyDeviceLinkRequest).toHaveBeenCalledWith(
          'tok',
          expect.objectContaining({ claimToken: 'claim-1' }),
          'https://chat.example.com',
        );
      });
    });

    it('discard button removes the local export record and reveals the fresh-upload approve button', async () => {
      authState.current = unlockedAuth();
      setupClaimResolution();
      mockFindResumableExport.mockResolvedValue(sampleResumable);

      const user = userEvent.setup();
      renderLinkDevice('/link-device');
      await user.type(screen.getByLabelText(/link code/i), 'abcd1234');
      await user.click(screen.getByRole('button', { name: /resolve code/i }));
      await screen.findByTestId('ld-resume-banner');

      await user.click(screen.getByRole('button', { name: /discard and start fresh/i }));

      await waitFor(() => {
        expect(mockDeleteExport).toHaveBeenCalledWith('arch-prior');
      });
      // Banner gone; normal approve-link button reappears.
      await waitFor(() => {
        expect(screen.queryByTestId('ld-resume-banner')).not.toBeInTheDocument();
      });
      expect(screen.getByRole('button', { name: /approve link/i })).toBeInTheDocument();
      // Resume mechanic was NOT triggered.
      expect(mockResumeUploadArchiveSession).not.toHaveBeenCalled();
    });

    it('locked vault: resume detection is skipped and the unlock prompt is shown', async () => {
      authState.current = lockedAuth();
      mockFindResumableExport.mockResolvedValue(sampleResumable);

      renderLinkDevice('/link-device');

      // Locked-vault view should appear, no resume detection should fire.
      expect(await screen.findByRole('button', { name: /unlock to approve/i })).toBeInTheDocument();
      expect(mockFindResumableExport).not.toHaveBeenCalled();
      expect(mockResumeUploadArchiveSession).not.toHaveBeenCalled();
    });

    it('preserves the fresh-upload flow when no resumable export exists', async () => {
      authState.current = unlockedAuth();
      setupClaimResolution();
      mockOpenStore.mockResolvedValue({ close: vi.fn() });
      mockExportHistorySnapshot.mockResolvedValue({ version: 1, stores: {} });
      mockFindResumableExport.mockResolvedValue(null);

      const user = userEvent.setup();
      renderLinkDevice('/link-device');
      await user.type(screen.getByLabelText(/link code/i), 'abcd1234');
      await user.click(screen.getByRole('button', { name: /resolve code/i }));

      // Banner not shown; normal approve button is.
      expect(await screen.findByRole('button', { name: /approve link/i })).toBeInTheDocument();
      expect(screen.queryByTestId('ld-resume-banner')).not.toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: /approve link/i }));

      await waitFor(() => {
        expect(mockUploadArchiveSession).toHaveBeenCalledTimes(1);
      });
      expect(mockResumeUploadArchiveSession).not.toHaveBeenCalled();
    });
  });

  // ── Connection-lost banner phase isolation (slice-12 P2 fix) ──────────
  describe('connection-lost banner', () => {
    it('does not appear during a successful finalize phase even if the flow is in progress', async () => {
      mockCreateDeviceIdentity.mockResolvedValue({ publicKeyBase64: 'device-public-key' });
      mockCreateSessionKeyPair.mockResolvedValue({
        privateKey: { type: 'private-key' },
        publicKeyBase64: 'session-public-key',
      });
      mockCreateDeviceLinkRequest.mockResolvedValue({
        requestId: 'req-1',
        secret: 'secret-1',
        code: 'ABCD1234',
        expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      });
      mockBuildLinkApprovalUrl.mockReturnValue('https://app.gethush.live/link-device?payload=abc');
      mockQrToDataUrl.mockResolvedValue('data:image/png;base64,qr-code');
      // Polling succeeds with a non-pending result (the OLD device approved).
      mockConsumeDeviceLinkResult.mockResolvedValue({
        relayCiphertext: 'c', relayIv: 'iv', relayPublicKey: 'pk',
      });
      // Finalize phase succeeds.
      mockDecryptRelayPayload.mockResolvedValue(new Uint8Array([1, 2, 3]));
      mockDecodeTransferBundle.mockResolvedValue({
        version: 3,
        userId: 'user-1', username: 'alice', displayName: 'Alice',
        instanceUrl: 'https://chat.example.com',
        rootPrivateKey: new Uint8Array([1, 2, 3]),
        rootPublicKey: new Uint8Array([4, 5, 6]),
        archive: null,
        historySnapshot: null, guildMetadataKeySnapshot: null, transcriptBlob: null,
      });

      renderLinkDevice('/link-device?mode=new');
      await screen.findByText('ABCD1234');
      // The successful flow must NEVER surface the "Connection lost" banner.
      // Wait long enough for the poll loop + finalize to run.
      await new Promise((r) => setTimeout(r, 50));
      expect(screen.queryByText(/connection lost\. retrying/i)).not.toBeInTheDocument();
    });

  });

  // ── Human-readable device label in approval (slice-12 P3) ─────────────
  describe('approval UI device labelling', () => {
    function unlockedAuth() {
      return {
        completeDeviceLink: vi.fn(), loading: false, isAuthenticated: true,
        hasSession: true, hasVault: true, isVaultUnlocked: true, needsUnlock: false,
        vaultState: 'unlocked', token: 'jwt-token',
        user: { id: 'user-1', username: 'alice', displayName: 'Alice' },
        identityKeyRef: { current: { privateKey: new Uint8Array([1]), publicKey: new Uint8Array([2]) } },
      };
    }

    it('shows the human-readable label from the resolved claim, not the raw deviceId', async () => {
      authState.current = unlockedAuth();
      mockResolveDeviceLinkRequest.mockResolvedValue({
        claimToken: 'claim-1',
        deviceId: '11111111-2222-3333-4444-555555555555',
        devicePublicKey: 'device-public-key',
        sessionPublicKey: 'session-public-key',
        instanceUrl: 'https://chat.example.com',
        expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
        label: 'Chrome on iOS',
      });
      const user = userEvent.setup();
      renderLinkDevice('/link-device');
      await user.type(screen.getByLabelText(/link code/i), 'abcd1234');
      await user.click(screen.getByRole('button', { name: /resolve code/i }));
      // Readable label visible.
      expect(await screen.findByText('Chrome on iOS')).toBeInTheDocument();
      // Raw deviceId NOT visible.
      expect(screen.queryByText('11111111-2222-3333-4444-555555555555')).not.toBeInTheDocument();
    });

    it('falls back to the deviceId when the claim has no label', async () => {
      authState.current = unlockedAuth();
      mockResolveDeviceLinkRequest.mockResolvedValue({
        claimToken: 'claim-1',
        deviceId: 'device-2',
        devicePublicKey: 'device-public-key',
        sessionPublicKey: 'session-public-key',
        instanceUrl: 'https://chat.example.com',
        expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      });
      const user = userEvent.setup();
      renderLinkDevice('/link-device');
      await user.type(screen.getByLabelText(/link code/i), 'abcd1234');
      await user.click(screen.getByRole('button', { name: /resolve code/i }));
      expect(await screen.findByText('device-2')).toBeInTheDocument();
    });
  });

  // ── Copy button success state (slice-12 P4) ───────────────────────────
  describe('copy code button', () => {
    it('exposes idle/copied data-state for the copy button (icon + success state)', async () => {
      mockCreateDeviceIdentity.mockResolvedValue({ publicKeyBase64: 'device-public-key' });
      mockCreateSessionKeyPair.mockResolvedValue({
        privateKey: { type: 'private-key' },
        publicKeyBase64: 'session-public-key',
      });
      mockCreateDeviceLinkRequest.mockResolvedValue({
        requestId: 'req-1', secret: 'secret-1', code: 'ABCD1234',
        expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      });
      mockBuildLinkApprovalUrl.mockReturnValue('https://app.gethush.live/link-device?payload=abc');
      mockQrToDataUrl.mockResolvedValue('data:image/png;base64,qr-code');
      mockConsumeDeviceLinkResult.mockResolvedValue({ status: 'pending' });

      const writeText = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });

      const user = userEvent.setup();
      renderLinkDevice('/link-device?mode=new');
      await screen.findByText('ABCD1234');

      const btn = await screen.findByRole('button', { name: /copy device link code/i });
      expect(btn).toHaveAttribute('data-state', 'idle');
      await user.click(btn);
      await waitFor(() => {
        expect(btn).toHaveAttribute('data-state', 'copied');
      });
    });
  });
});
