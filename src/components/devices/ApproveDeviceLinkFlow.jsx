/**
 * ApproveDeviceLinkFlow — extracted from pages/LinkDevice.jsx.
 *
 * Owns the entirety of the approve-from-existing-device flow: code/QR
 * resolution, vault gating, MLS history snapshot, transcript blob seal,
 * chunked archive upload + resume, and verify-then-emit. The component
 * is layout-agnostic: callers inject navigation via callbacks and pick a
 * layout shell via `mode`.
 *
 * Props:
 *   mode                 — "page" (full-bleed Card with legacy ld-* classes)
 *                          or "embedded" (compact, suitable for a settings dialog).
 *   initialPayload?      — optional decoded QR payload from the URL query.
 *   unlockResumePath?    — used by callers in page mode to wire
 *                          onVaultUnlockNeeded back to the unlock route.
 *                          Embedded callers ignore this and instead supply
 *                          their own onVaultUnlockNeeded handler.
 *   onCancel             — fires on Close/Back. Caller decides destination.
 *   onSuccess?           — fires once a device link verify succeeds.
 *   onVaultUnlockNeeded  — fires when the locked-vault gate is shown and
 *                          the user clicks "Unlock". Caller decides path.
 */
import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { getDeviceId } from '../../hooks/useAuth';
import { useHomeInstanceSession } from '../../hooks/useHomeInstanceSession';
import { Button as ShadcnButton } from '../ui/button.tsx';
import { Card } from '../ui/card.tsx';
import { Alert, AlertDescription } from '../ui/alert.tsx';
import { Input } from '../ui/input.tsx';
import QRCodeScanner from '../QRCodeScanner';
import * as mlsStore from '../../lib/mlsStore';
import { preDecryptForLinkExport } from '../../lib/preDecryptForLinkExport';
import {
  buildTranscriptBlobForExport,
  listTranscriptCacheEntries,
} from '../../lib/transcriptVault';
import {
  exportGuildMetadataKeySnapshot,
  openGuildMetadataKeyStore,
} from '../../lib/guildMetadataKeyStore';
import {
  resolveDeviceLinkRequest,
  verifyDeviceLinkRequest,
} from '../../lib/api';
import {
  HOSTED_AUTH_INSTANCE_URL,
  normalizeInstanceUrl,
} from '../../lib/authInstanceStore';
import {
  bytesToBase64,
  certifyDevice,
  claimMatchesPayloadKeys,
  decodeQRPayload,
  encodeTransferBundle,
  encryptRelayPayload,
  base64ToBytes,
} from '../../lib/deviceLinking';
import {
  uploadArchiveSession,
  resumeUploadArchiveSession,
} from '../../lib/linkArchiveSession';
import {
  sweepStaleExports,
  findResumableExport,
  deleteExport,
} from '../../lib/linkArchiveExportStore';
import { deleteArchive } from '../../lib/linkArchiveTransport';

function extractQRPayload(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const trimmed = raw.trim();
  try {
    const url = new URL(trimmed);
    const param = url.searchParams.get('payload');
    if (param) return param;
  } catch {
    // not a URL — fall through
  }
  return trimmed;
}

function formatCountdown(expiresAt, now = Date.now()) {
  const remaining = Math.max(
    0,
    Math.floor((new Date(expiresAt).getTime() - now) / 1000),
  );
  const minutes = Math.floor(remaining / 60);
  const seconds = remaining % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function resolveTrustedApiBaseUrl(homeInstanceUrl) {
  const explicit = normalizeInstanceUrl(homeInstanceUrl);
  if (explicit) return explicit;

  if (homeInstanceUrl) {
    return HOSTED_AUTH_INSTANCE_URL;
  }

  const currentOrigin = typeof window !== 'undefined'
    ? normalizeInstanceUrl(window.location?.origin)
    : null;
  return currentOrigin || HOSTED_AUTH_INSTANCE_URL;
}

export default function ApproveDeviceLinkFlow({
  mode,
  initialPayload,
  homeInstanceUrl,
  onCancel,
  onSuccess,
  onVaultUnlockNeeded,
}) {
  const {
    user,
    token,
    loading,
    hasSession,
    hasVault,
    isVaultUnlocked,
    needsUnlock,
    identityKeyRef,
  } = useAuth();
  const [code, setCode] = useState('');
  const [claim, setClaim] = useState(null);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [isResolving, setIsResolving] = useState(false);
  const [isApproving, setIsApproving] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const trustedHomeInstanceUrl = resolveTrustedApiBaseUrl(homeInstanceUrl);

  const {
    token: homeInstanceToken,
    isMissingExplicitHomeInstanceToken: isMissingHomeInstanceToken,
  } = useHomeInstanceSession({
    homeInstanceUrl: trustedHomeInstanceUrl,
    fallbackToken: token,
  });
  const hasUnlockedIdentity = hasSession
    && isVaultUnlocked
    && !!identityKeyRef.current?.privateKey
    && !!identityKeyRef.current?.publicKey
    && !!homeInstanceToken;
  const needsVaultUnlock = needsUnlock;

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    sweepStaleExports().catch((err) => {
      console.warn('[ApproveDeviceLinkFlow] sweepStaleExports failed', err);
    });
  }, []);

  const [resumableExport, setResumableExport] = useState(null);
  const [isResuming, setIsResuming] = useState(false);
  useEffect(() => {
    if (!claim || !hasUnlockedIdentity) {
      setResumableExport(null);
      return;
    }
    const baseUrlForApi = trustedHomeInstanceUrl;
    let cancelled = false;
    findResumableExport(baseUrlForApi)
      .then((rec) => {
        if (!cancelled) setResumableExport(rec ?? null);
      })
      .catch((err) => {
        console.warn('[ApproveDeviceLinkFlow] findResumableExport failed', err);
        if (!cancelled) setResumableExport(null);
      });
    return () => {
      cancelled = true;
    };
  }, [claim, hasUnlockedIdentity, homeInstanceUrl]);

  const resolveRequest = useCallback(
    async (body, committedKeys = null) => {
      if (!homeInstanceToken) return;
      setError('');
      setStatus('');
      setIsResolving(true);
      try {
        // Embedded callers (DevicesPanel) supply the auth/home
        // instance URL so resolve/verify do not silently fall through
        // to window.location.origin in a federated context. Page mode
        // omits it intentionally — the page lives at the home origin.
        const resolved = await resolveDeviceLinkRequest(
          homeInstanceToken,
          body,
          trustedHomeInstanceUrl,
        );
        // QR-commitment guard: when the QR payload carried committed
        // device/session public keys, reject the claim if the
        // server-returned material does not match. Fall-back-code
        // path passes `committedKeys = null` and behaves unchanged.
        // No approval UI, no predecrypt, no approve/verify call.
        if (committedKeys && !claimMatchesPayloadKeys(committedKeys, resolved)) {
          setError(
            'Device link verification failed: the link target does not match the original QR code. Generate a new link on the other device.',
          );
          return;
        }
        setClaim(resolved);
      } catch (err) {
        const rawMessage = err.message || '';
        if (rawMessage.includes('expired or already claimed')) {
          setError(
            'Code expired or already used. Please generate a new link on the other device.',
          );
        } else {
          setError(rawMessage || 'Failed to resolve the link request.');
        }
      } finally {
        setIsResolving(false);
      }
    },
    [homeInstanceToken, trustedHomeInstanceUrl],
  );

  useEffect(() => {
    if (
      !initialPayload?.requestId
      || !initialPayload?.secret
      || !hasUnlockedIdentity
    ) {
      return;
    }
    resolveRequest(
      {
        requestId: initialPayload.requestId,
        secret: initialPayload.secret,
      },
      {
        devicePublicKey: initialPayload.devicePublicKey ?? null,
        sessionPublicKey: initialPayload.sessionPublicKey ?? null,
      },
    );
  }, [hasUnlockedIdentity, initialPayload, resolveRequest]);

  const handleResolveCode = useCallback(
    async (event) => {
      event.preventDefault();
      if (!code.trim()) {
        setError('Enter the code shown on the new device.');
        return;
      }
      await resolveRequest({ code: code.trim().toUpperCase() });
    },
    [code, resolveRequest],
  );

  // QR camera scanner
  const [showScanner, setShowScanner] = useState(false);
  const [scannerError, setScannerError] = useState('');
  const [scannerUnavailable, setScannerUnavailable] = useState(false);
  const handleScannerResult = useCallback(
    (rawText) => {
      setShowScanner(false);
      const payload = extractQRPayload(rawText);
      if (!payload) {
        setError('Could not read QR code.');
        return;
      }
      let decoded;
      try {
        decoded = decodeQRPayload(payload);
      } catch {
        setError('Invalid QR code.');
        return;
      }
      resolveRequest(
        { requestId: decoded.requestId, secret: decoded.secret },
        {
          devicePublicKey: decoded.devicePublicKey ?? null,
          sessionPublicKey: decoded.sessionPublicKey ?? null,
        },
      );
    },
    [resolveRequest],
  );
  const handleScannerCancel = useCallback(() => {
    setShowScanner(false);
    setScannerError('');
  }, []);
  const handleScannerError = useCallback((msg) => {
    setShowScanner(false);
    setScannerError(msg);
  }, []);
  const handleScannerUnavailable = useCallback(() => {
    setShowScanner(false);
    setScannerUnavailable(true);
  }, []);

  const handleApprove = useCallback(async () => {
    if (
      !claim
      || !homeInstanceToken
      || !user?.id
      || !identityKeyRef.current?.privateKey
      || !identityKeyRef.current?.publicKey
    ) {
      return;
    }

    setError('');
    setStatus('');
    setIsApproving(true);
    let historyDb = null;
    let metadataDb = null;
    try {
      historyDb = await mlsStore.openStore(user.id, getDeviceId());
      const baseUrlForApi = trustedHomeInstanceUrl;
      try {
        const summary = await preDecryptForLinkExport({
          activeDb: historyDb,
          token: homeInstanceToken,
          baseUrl: baseUrlForApi,
        });
        console.info(
          '[ApproveDeviceLinkFlow] pre-decrypt-for-link-export summary:',
          summary,
        );
      } catch (err) {
        console.warn(
          '[ApproveDeviceLinkFlow] pre-decrypt-for-link-export failed:',
          err,
        );
      }

      let transcriptBlob = null;
      try {
        const localPlaintextRows
          = await mlsStore.listAllLocalPlaintexts(historyDb);

        let transcriptCacheRows = [];
        try {
          transcriptCacheRows = listTranscriptCacheEntries();
        } catch (err) {
          console.warn(
            '[ApproveDeviceLinkFlow] transcript-blob seal: transcript cache read failed; falling back to localPlaintext only',
            err,
          );
          transcriptCacheRows = [];
        }

        const mergedById = new Map();
        for (const row of transcriptCacheRows) {
          if (row?.messageId) mergedById.set(row.messageId, row);
        }
        for (const row of localPlaintextRows) {
          if (row?.messageId) mergedById.set(row.messageId, row);
        }
        const mergedRows = Array.from(mergedById.values());

        const sampleIds = mergedRows.slice(0, 3).map((r) => r.messageId);
        console.info(
          '[ApproveDeviceLinkFlow] transcript-blob seal: harvested rows for export',
          {
            localPlaintextRowCount: localPlaintextRows.length,
            transcriptCacheRowCount: transcriptCacheRows.length,
            mergedRowCount: mergedRows.length,
            firstIds: sampleIds,
          },
        );

        if (mergedRows.length > 0) {
          transcriptBlob = await buildTranscriptBlobForExport(
            identityKeyRef.current.privateKey,
            mergedRows,
          );
          console.info(
            '[ApproveDeviceLinkFlow] transcript-blob seal: produced encrypted blob',
            {
              byteLength: transcriptBlob.byteLength,
              rowCount: mergedRows.length,
            },
          );
        } else {
          console.warn(
            '[ApproveDeviceLinkFlow] transcript-blob seal: zero rows — new device will inherit no plaintext history',
          );
        }
      } catch (err) {
        console.warn(
          '[ApproveDeviceLinkFlow] transcript-blob seal failed (link will continue without transcript):',
          err,
        );
        transcriptBlob = null;
      }

      const historySnapshot = await mlsStore.exportHistorySnapshot(historyDb);
      metadataDb = await openGuildMetadataKeyStore(user.id, getDeviceId());
      const guildMetadataKeySnapshot
        = await exportGuildMetadataKeySnapshot(metadataDb);

      let archiveDescriptor = null;
      try {
        archiveDescriptor = await uploadArchiveSession({
          token: homeInstanceToken,
          sessionPublicKeyBase64: claim.sessionPublicKey,
          baseUrl: baseUrlForApi,
          historySnapshot,
          guildMetadataKeySnapshot,
          transcriptBlob,
          rootPrivateKey: identityKeyRef.current.privateKey,
        });
        console.info('[ApproveDeviceLinkFlow] archive uploaded', {
          archiveId: archiveDescriptor.id,
          totalChunks: archiveDescriptor.totalChunks,
          totalBytes: archiveDescriptor.totalBytes,
          transcriptBlobOmitted: archiveDescriptor.transcriptBlobOmitted,
        });
      } catch (err) {
        console.error(
          '[ApproveDeviceLinkFlow] chunked archive upload failed',
          err,
        );
        throw err;
      }

      const archivePayload = {
        id: archiveDescriptor.id,
        downloadToken: archiveDescriptor.downloadToken,
        totalChunks: archiveDescriptor.totalChunks,
        totalBytes: archiveDescriptor.totalBytes,
        chunkSize: archiveDescriptor.chunkSize,
        manifestHash: archiveDescriptor.manifestHash,
        archiveSha256: archiveDescriptor.archiveSha256,
        format: archiveDescriptor.format,
        chunkPlaintextHashes: archiveDescriptor.chunkPlaintextHashes,
        ephPub: archiveDescriptor.ephPub,
        nonceBase: archiveDescriptor.nonceBase,
        transcriptBlobOmitted: archiveDescriptor.transcriptBlobOmitted,
      };

      const transferBundle = await encodeTransferBundle({
        userId: user.id,
        username: user.username,
        displayName: user.displayName,
        instanceUrl: baseUrlForApi,
        rootPrivateKey: identityKeyRef.current.privateKey,
        rootPublicKey: identityKeyRef.current.publicKey,
        archive: archivePayload,
      });
      const certificate = await certifyDevice(
        base64ToBytes(claim.devicePublicKey),
        identityKeyRef.current.privateKey,
      );
      const relayEnvelope = await encryptRelayPayload(
        transferBundle,
        claim.sessionPublicKey,
      );

      try {
        await verifyDeviceLinkRequest(
          homeInstanceToken,
          {
            claimToken: claim.claimToken,
            certificate: bytesToBase64(certificate),
            signingDeviceId: getDeviceId(),
            ...relayEnvelope,
          },
          baseUrlForApi,
        );
      } catch (err) {
        try {
          await deleteArchive(
            archiveDescriptor.id,
            { uploadToken: archiveDescriptor.uploadToken },
            baseUrlForApi,
          );
        } catch {
          // ignore
        }
        throw err;
      }

      setStatus('Device linked. Return to the new device to finish setup.');
      onSuccess?.();
    } catch (err) {
      const rawMessage = err.message || '';
      if (rawMessage.includes('Linking failed')) {
        setError('Linking failed. Please try again.');
      } else {
        setError(rawMessage || 'Failed to approve the device link.');
      }
    } finally {
      try {
        historyDb?.close();
      } catch {
        // ignore close errors
      }
      try {
        metadataDb?.close();
      } catch {
        // ignore close errors
      }
      setIsApproving(false);
    }
  }, [
    claim,
    homeInstanceToken,
    identityKeyRef,
    onSuccess,
    trustedHomeInstanceUrl,
    user?.displayName,
    user?.id,
    user?.username,
  ]);

  const handleResume = useCallback(async () => {
    if (
      !claim
      || !homeInstanceToken
      || !user?.id
      || !identityKeyRef.current?.privateKey
      || !identityKeyRef.current?.publicKey
    ) {
      return;
    }
    if (!resumableExport) return;
    setError('');
    setStatus('Resuming previous upload…');
    setIsResuming(true);
    try {
      const baseUrlForApi = trustedHomeInstanceUrl;
      const archiveDescriptor = await resumeUploadArchiveSession({
        token: homeInstanceToken,
        baseUrl: baseUrlForApi,
        rootPrivateKey: identityKeyRef.current.privateKey,
        exportRecord: resumableExport,
      });
      const archivePayload = {
        id: archiveDescriptor.id,
        downloadToken: archiveDescriptor.downloadToken,
        totalChunks: archiveDescriptor.totalChunks,
        totalBytes: archiveDescriptor.totalBytes,
        chunkSize: archiveDescriptor.chunkSize,
        manifestHash: archiveDescriptor.manifestHash,
        archiveSha256: archiveDescriptor.archiveSha256,
        format: archiveDescriptor.format,
        chunkPlaintextHashes: archiveDescriptor.chunkPlaintextHashes,
        ephPub: archiveDescriptor.ephPub,
        nonceBase: archiveDescriptor.nonceBase,
        transcriptBlobOmitted: archiveDescriptor.transcriptBlobOmitted,
      };
      const transferBundle = await encodeTransferBundle({
        userId: user.id,
        username: user.username,
        displayName: user.displayName,
        instanceUrl: baseUrlForApi,
        rootPrivateKey: identityKeyRef.current.privateKey,
        rootPublicKey: identityKeyRef.current.publicKey,
        archive: archivePayload,
      });
      const certificate = await certifyDevice(
        base64ToBytes(claim.devicePublicKey),
        identityKeyRef.current.privateKey,
      );
      const relayEnvelope = await encryptRelayPayload(
        transferBundle,
        claim.sessionPublicKey,
      );
      try {
        await verifyDeviceLinkRequest(
          homeInstanceToken,
          {
            claimToken: claim.claimToken,
            certificate: bytesToBase64(certificate),
            signingDeviceId: getDeviceId(),
            ...relayEnvelope,
          },
          baseUrlForApi,
        );
      } catch (err) {
        try {
          await deleteArchive(
            archiveDescriptor.id,
            { uploadToken: archiveDescriptor.uploadToken },
            baseUrlForApi,
          );
        } catch {
          // ignore
        }
        throw err;
      }
      setResumableExport(null);
      setStatus('Device linked. Return to the new device to finish setup.');
      onSuccess?.();
    } catch (err) {
      const rawMessage = err.message || '';
      setError(rawMessage || 'Failed to resume the previous upload.');
    } finally {
      setIsResuming(false);
    }
  }, [
    claim,
    homeInstanceToken,
    identityKeyRef,
    onSuccess,
    resumableExport,
    trustedHomeInstanceUrl,
    user?.displayName,
    user?.id,
    user?.username,
  ]);

  const handleDiscardResume = useCallback(async () => {
    if (!resumableExport) return;
    try {
      await deleteExport(resumableExport.archiveId);
    } catch (err) {
      console.warn('[ApproveDeviceLinkFlow] deleteExport on discard failed', err);
    }
    setResumableExport(null);
  }, [resumableExport]);

  // ── render ────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <FlowShell mode={mode}>
        <div className="text-sm text-muted-foreground">Loading…</div>
      </FlowShell>
    );
  }

  if (needsVaultUnlock) {
    return (
      <FlowShell mode={mode}>
        <Heading mode={mode}>Approve device link</Heading>
        <Subtitle mode={mode}>
          This browser is recognized for your spaces account, but the vault
          is locked in this tab. Unlock your spaces, then return to approve
          the new device.
        </Subtitle>
        {initialPayload && (
          <div className={'text-xs text-muted-foreground'}>
            QR request detected. Unlock this browser to resume approval automatically.
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          <ShadcnButton
            variant="ghost"
            size="lg"
            onClick={onCancel}
          >
            Back
          </ShadcnButton>
          <ShadcnButton
            variant="default"
            size="lg"
            className="flex-1"
            onClick={onVaultUnlockNeeded}
          >
            Unlock to approve
          </ShadcnButton>
        </div>
      </FlowShell>
    );
  }

  if (!hasUnlockedIdentity) {
    return (
      <FlowShell mode={mode}>
        <Heading mode={mode}>Approve device link</Heading>
        {isMissingHomeInstanceToken ? (
          <Subtitle mode={mode}>
            Sign in to the home instance before approving this device link.
          </Subtitle>
        ) : (
          <Subtitle mode={mode}>
            Open this page in a browser profile that is already signed in to the
            account you want to link.
          </Subtitle>
        )}
        {initialPayload && !hasVault && !isMissingHomeInstanceToken && (
          <div className={'text-xs text-muted-foreground'}>
            QR request detected. This browser does not have a local vault for that account.
          </div>
        )}
        <ShadcnButton variant="ghost" size="lg" onClick={onCancel}>
          Back
        </ShadcnButton>
      </FlowShell>
    );
  }

  return (
    <FlowShell mode={mode}>
      <Heading mode={mode}>Approve device link</Heading>
      <Subtitle mode={mode}>
        Scan the QR from your phone camera or enter the fallback code shown on
        the new device.
      </Subtitle>

      {!claim && !showScanner && (
        <form
          className="flex flex-col gap-3"
          onSubmit={handleResolveCode}
        >
          <label
            htmlFor="device-link-code"
            className="text-xs font-medium uppercase tracking-wide text-muted-foreground"
          >
            Link code
          </label>
          <Input
            id="device-link-code"
            className=""
            value={code}
            onChange={(event) => setCode(event.target.value.toUpperCase())}
            placeholder="ABCD1234"
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck="false"
          />
          <ShadcnButton
            type="submit"
            variant="default"
            size="lg"
            className="w-full"
            disabled={isResolving}
          >
            {isResolving ? 'Checking…' : 'Resolve code'}
          </ShadcnButton>
          <ShadcnButton
            type="button"
            variant="secondary"
            size="lg"
            className="w-full"
            onClick={() => {
              setScannerError('');
              setShowScanner(true);
            }}
            aria-label="Scan QR code with camera"
          >
            Scan QR with camera
          </ShadcnButton>
          {scannerError && (
            <Alert variant="destructive" className={''}>
              <AlertDescription>{scannerError}</AlertDescription>
            </Alert>
          )}
          {scannerUnavailable && (
            <div className={'text-xs text-muted-foreground'}>
              Camera scanning is not supported in this browser. Use the manual code instead.
            </div>
          )}
        </form>
      )}

      {!claim && showScanner && (
        <QRCodeScanner
          onResult={handleScannerResult}
          onCancel={handleScannerCancel}
          onError={handleScannerError}
          onUnavailable={handleScannerUnavailable}
        />
      )}

      {claim && (
        <div className="flex flex-col gap-1 rounded-lg border bg-muted/30 px-3 py-2 text-sm">
          {/* claim summary */}
          <div className={'flex justify-between gap-4'}>
            <span className="text-muted-foreground">Device</span>
            <strong className="truncate">
              {claim.label?.trim() ? claim.label : claim.deviceId}
            </strong>
          </div>
          <div className={'flex justify-between gap-4'}>
            <span className="text-muted-foreground">Expires</span>
            <strong>{formatCountdown(claim.expiresAt, now)}</strong>
          </div>
          <div className={'flex justify-between gap-4'}>
            <span className="text-muted-foreground">Instance</span>
            <strong className="truncate">
              {trustedHomeInstanceUrl}
            </strong>
          </div>
        </div>
      )}

      {status && (
        <div className="text-sm text-muted-foreground">{status}</div>
      )}
      {error && (
        <Alert variant="destructive" className={''}>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {claim && resumableExport && !isApproving && !isResuming && (
        <div
          className="rounded-md border bg-muted/30 p-3 text-sm"
          data-testid="ld-resume-banner"
        >
          <p>
            A previous device-link upload was interrupted. Resume it to finish
            the same archive, or discard it to start a fresh upload.
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <ShadcnButton
              variant="secondary"
              size="lg"
              className="flex-1"
              onClick={handleDiscardResume}
            >
              Discard and start fresh
            </ShadcnButton>
            <ShadcnButton
              variant="default"
              size="lg"
              className="flex-1"
              onClick={handleResume}
            >
              Resume upload
            </ShadcnButton>
          </div>
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        <ShadcnButton variant="ghost" size="lg" onClick={onCancel}>
          Close
        </ShadcnButton>
        {claim && !resumableExport && (
          <ShadcnButton
            variant="default"
            size="lg"
            className="flex-1"
            onClick={handleApprove}
            disabled={isApproving || isResuming}
          >
            {isApproving ? 'Approving…' : 'Approve link'}
          </ShadcnButton>
        )}
        {claim && resumableExport && isResuming && (
          <ShadcnButton variant="default" size="lg" className="flex-1" disabled>
            Resuming…
          </ShadcnButton>
        )}
      </div>
    </FlowShell>
  );
}

function FlowShell({ mode, children }) {
  if (mode === 'page') {
    return (
      <Card className="w-full max-w-md gap-4 p-6">{children}</Card>
    );
  }
  return <div className="flex flex-col gap-4">{children}</div>;
}

function Heading({ children }) {
  return <h2 className="text-lg font-semibold">{children}</h2>;
}

function Subtitle({ children }) {
  return <p className="text-sm text-muted-foreground">{children}</p>;
}
