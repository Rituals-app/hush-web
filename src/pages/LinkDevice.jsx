import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import QRCode from 'qrcode';
import { ArrowLeftIcon, CopyIcon, CheckIcon } from '@radix-ui/react-icons';
import { useAuth } from '../contexts/AuthContext';
import { normalizeInstanceUrl } from '../lib/authInstanceStore';
import { BODY_SCROLL_MODE, useBodyScrollMode } from '../hooks/useBodyScrollMode';
import { getDeviceId } from '../hooks/useAuth';
import { useAuthInstanceSelection } from '../hooks/useAuthInstanceSelection.js';
import { Button as ShadcnButton } from '../components/ui/button.tsx';
import { Card } from '../components/ui/card.tsx';
import { Alert, AlertDescription } from '../components/ui/alert.tsx';
import ApproveDeviceLinkFlow from '../components/devices/ApproveDeviceLinkFlow.jsx';
import {
  consumeDeviceLinkResult,
  createDeviceLinkRequest,
} from '../lib/api';
import {
  buildLinkApprovalUrl,
  bytesToBase64,
  createDeviceIdentity,
  createSessionKeyPair,
  decodeQRPayload,
  decodeTransferBundle,
  decryptRelayPayload,
} from '../lib/deviceLinking';
import { downloadArchiveSession } from '../lib/linkArchiveSession';
import { deleteArchive } from '../lib/linkArchiveTransport';

const POLL_INITIAL_MS = 2000;
const POLL_BACKOFF_MULTIPLIER = 1.5;
const POLL_MAX_MS = 15000;

/**
 * Pull the encoded QR payload from a scanned string. Accepts either the
 * full approval URL produced by `buildLinkApprovalUrl` (with `?payload=…`)
 * or the bare base64 payload itself.
 *
 * @param {string} raw
 * @returns {string|null}
 */
function extractQRPayload(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const trimmed = raw.trim();
  try {
    const url = new URL(trimmed);
    const param = url.searchParams.get('payload');
    if (param) return param;
  } catch {
    // Not a URL — fall through.
  }
  return trimmed;
}

function formatCountdown(expiresAt, now = Date.now()) {
  const remaining = Math.max(0, Math.floor((new Date(expiresAt).getTime() - now) / 1000));
  const minutes = Math.floor(remaining / 60);
  const seconds = remaining % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

// Rituals fork: device linking always runs against this origin (the space
// host); never fall back to the upstream hosted instance.
function resolveDeviceLinkInstanceUrl(instanceUrl) {
  return normalizeInstanceUrl(instanceUrl) || window.location.origin;
}

function buildUnlockResumePath(location) {
  const current = `${location.pathname}${location.search}`;
  return `/?returnTo=${encodeURIComponent(current)}`;
}


function NewDeviceLinkView({ onLinked, selectedInstanceUrl }) {
  const { completeDeviceLink, loading: authLoading } = useAuth();
  const [requestState, setRequestState] = useState(null);
  const [error, setError] = useState('');
  const [codeCopied, setCodeCopied] = useState(false);
  const handleCopyCode = useCallback(async () => {
    if (!requestState?.code) return;
    try {
      await navigator.clipboard.writeText(requestState.code);
      setCodeCopied(true);
      setTimeout(() => setCodeCopied(false), 1500);
    } catch {
      // Clipboard may be denied (HTTP, permission); fail silently — user
      // can still copy by hand from the displayed value.
    }
  }, [requestState?.code]);
  const [status, setStatus] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [connectionLost, setConnectionLost] = useState(false);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function createRequest() {
      setError('');
      setStatus('');
      setRequestState(null);

      try {
        const instanceUrl = resolveDeviceLinkInstanceUrl(selectedInstanceUrl);
        const deviceIdentity = await createDeviceIdentity();
        const session = await createSessionKeyPair();
        const response = await createDeviceLinkRequest({
          devicePublicKey: deviceIdentity.publicKeyBase64,
          sessionPublicKey: session.publicKeyBase64,
          deviceId: getDeviceId(),
          instanceUrl,
        }, instanceUrl);
        let qrDataUrl = '';
        try {
          qrDataUrl = await QRCode.toDataURL(buildLinkApprovalUrl(instanceUrl, {
            requestId: response.requestId,
            secret: response.secret,
            expiresAt: response.expiresAt,
            // Commit to the new device's key material in the QR
            // payload so the approving device can verify, after
            // resolving the claim, that the server-returned keys
            // match what this device originally published.
            // CORE-INVARIANTS - Auth/Vault/Device Identity.
            devicePublicKey: deviceIdentity.publicKeyBase64,
            sessionPublicKey: session.publicKeyBase64,
          }), {
            width: 240,
            margin: 2,
            errorCorrectionLevel: 'M',
          });
        } catch {}

        if (cancelled) return;
        setRequestState({
          ...response,
          instanceUrl,
          qrDataUrl,
          sessionPrivateKey: session.privateKey,
        });
      } catch (err) {
        if (!cancelled) {
          setError(err.message || 'Failed to create a device link request.');
        }
      }
    }

    createRequest();
    return () => {
      cancelled = true;
    };
  }, [refreshKey, selectedInstanceUrl]);

  useEffect(() => {
    if (!requestState?.requestId || !requestState?.secret || !requestState?.sessionPrivateKey) return undefined;

    let cancelled = false;
    let inFinalize = false;
    const expiresAtMs = new Date(requestState.expiresAt).getTime();
    let currentInterval = POLL_INITIAL_MS;
    let timerId = null;

    const scheduleNext = () => {
      if (cancelled) return;
      timerId = setTimeout(poll, currentInterval);
    };

    const poll = async () => {
      if (cancelled || Date.now() >= expiresAtMs) return;
      try {
        const result = await consumeDeviceLinkResult({
          requestId: requestState.requestId,
          secret: requestState.secret,
        }, requestState.instanceUrl);

        if (cancelled) return;

        // Successful HTTP response — clear connection-lost state and apply backoff.
        setConnectionLost(false);
        currentInterval = Math.min(currentInterval * POLL_BACKOFF_MULTIPLIER, POLL_MAX_MS);

        if (result?.status === 'pending') {
          scheduleNext();
          return;
        }

        // Past the polling stage. Errors that fire during the
        // finalize phase below are NOT poll-loop network blips and
        // must NOT trigger the "Connection lost. Retrying..." banner
        // — the flow is progressing forward, just doing crypto + a
        // chunked archive download. The downloadArchiveSession
        // transport already retries transient fetch errors
        // internally; anything that surfaces here is a real error.
        inFinalize = true;
        setStatus('Finalizing linked device…');
        const relayBytes = await decryptRelayPayload(result, requestState.sessionPrivateKey);
        const bundle = await decodeTransferBundle(relayBytes);

        // v3 chunked-archive bundle: pull the bulk archive over the chunked
        // transport, decrypt + reassemble, and patch its decoded contents
        // back onto the bundle so completeDeviceLink can keep using the
        // historySnapshot / guildMetadataKeySnapshot / transcriptBlob path.
        if (bundle.archive) {
          setStatus('Importing message history…');
          const importBaseUrl = requestState.instanceUrl || bundle.instanceUrl || window.location.origin;
          try {
            const fetched = await downloadArchiveSession({
              archive: bundle.archive,
              sessionPrivateKey: requestState.sessionPrivateKey,
              baseUrl: importBaseUrl,
              // Hand the unlocked root private key + userId in so the
              // chunked archive consumer can stream wire frames
              // straight into the per-user transcriptVault at-rest IDB
              // (no whole-rows array materialises on import).
              rootPrivateKey: bundle.rootPrivateKey,
              userId: bundle.userId,
            });
            bundle.historySnapshot = fetched.historySnapshot;
            bundle.guildMetadataKeySnapshot = fetched.guildMetadataKeySnapshot;
            bundle.transcriptBlob = fetched.transcriptBlob;
            if (Array.isArray(fetched.transcriptRows)) {
              bundle.transcriptRows = fetched.transcriptRows;
            }
            if (fetched.transcriptPersistedAtRest) {
              bundle.transcriptPersistedAtRest = true;
            }
          } catch (err) {
            console.error('[LinkDevice] chunked archive download failed', err);
            throw err;
          } finally {
            // Best-effort cleanup of server-side staging on EVERY exit
            // path — success and failure alike. On failure this frees
            // the per-user concurrent-archive quota slot so the next
            // device-link retry is not blocked by a stale `available`
            // archive (the server purger only reaps after the hard
            // deadline). On success this releases bytes the NEW device
            // already imported. The DELETE is idempotent and always
            // best-effort: the link is never blocked on this call.
            try {
              await deleteArchive(bundle.archive.id, {
                downloadToken: bundle.archive.downloadToken,
              }, importBaseUrl);
            } catch {
              // Server purger reaps; never block the link on cleanup.
            }
          }
        }

        // Pass the originally selected/polled instance URL so
        // completeDeviceLink can enforce it over the untrusted
        // `bundle.instanceUrl` field. See useAuth.completeDeviceLink
        // for the mismatch fail-closed contract.
        await completeDeviceLink(bundle, requestState.instanceUrl);
        if (bundle.archive?.transcriptBlobOmitted) {
          setStatus('Linked. Local message history was too large to transfer.');
        }
        onLinked();
      } catch (err) {
        if (cancelled) return;
        const rawMessage = err?.message || '';
        const isRetryableNetworkError = err instanceof TypeError
          || (err.name && err.name === 'AbortError')
          || rawMessage.includes('Could not reach ');
        // Only the polling phase's transient network errors should
        // surface as "Connection lost. Retrying..." — once we are in
        // the finalize phase, any error is a real failure (or has
        // already been retried internally by the transport layer)
        // and the banner must NOT appear, even if the underlying
        // exception happens to be a TypeError.
        if (!inFinalize && isRetryableNetworkError) {
          setConnectionLost(true);
          scheduleNext();
          return;
        }
        // Make sure a stale poll-phase banner doesn't linger across
        // a finalize-phase failure.
        setConnectionLost(false);
        setError(err.message || 'Failed to finalize the device link.');
      }
    };

    poll();
    return () => {
      cancelled = true;
      if (timerId !== null) clearTimeout(timerId);
    };
  }, [completeDeviceLink, onLinked, requestState]);

  const isExpired = requestState
    ? new Date(requestState.expiresAt).getTime() <= now
    : false;

  const hasActiveRequest = Boolean(requestState && !isExpired);
  const hasCode = Boolean(requestState?.code);

  const placeholderMessage = error
    ? 'Could not create link request.'
    : authLoading
    ? 'Finalizing device link…'
    : isExpired
    ? 'Link request expired.'
    : hasActiveRequest
    ? 'QR unavailable. Use the fallback code below.'
    : 'Generating link request…';

  return (
    // Legacy `ld-*` classes are kept as test-only structural markers
    // (no CSS rules attached) so the existing structural-stability
    // suite keeps working without coupling tests to Tailwind utility
    // classes that may legitimately churn.
    <Card className="ld-card w-full max-w-md gap-4 p-6">
      <div className="flex flex-col gap-1">
        <h1 className="home-section-title text-lg font-semibold">
          Link this device
        </h1>
        <p className="ld-subtitle text-sm text-muted-foreground">
          Scan this QR code from a device that is already signed in to the
          same account.
        </p>
      </div>

      {connectionLost && (
        <div className="ld-connection-lost rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-600 dark:text-amber-400">
          Connection lost. Retrying…
        </div>
      )}

      <section
        aria-label="Device link QR area"
        data-state={hasActiveRequest ? 'active' : 'pending'}
        className="ld-qr-block flex flex-col items-center gap-2"
      >
        <div className="ld-qr-frame flex h-[260px] w-[260px] items-center justify-center rounded-lg border bg-background p-3">
          {hasActiveRequest && requestState.qrDataUrl ? (
            <img
              className="ld-qr-image h-full w-full object-contain"
              src={requestState.qrDataUrl}
              alt="Device link QR code"
            />
          ) : (
            <div
              className="ld-qr-placeholder px-2 text-center text-xs text-muted-foreground"
              role="status"
              aria-live="polite"
            >
              {placeholderMessage}
            </div>
          )}
        </div>
        <div
          className="ld-qr-timer font-mono text-xs text-muted-foreground"
          aria-live="polite"
        >
          {hasActiveRequest
            ? `Expires in ${formatCountdown(requestState.expiresAt, now)}`
            : ' '}
        </div>
      </section>

      <div
        className="ld-divider flex items-center gap-3"
        role="separator"
        aria-orientation="horizontal"
      >
        <span className="h-px flex-1 bg-border" aria-hidden="true" />
        <span className="text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground">
          or use fallback code
        </span>
        <span className="h-px flex-1 bg-border" aria-hidden="true" />
      </div>

      <div className="ld-code-block grid grid-cols-[2rem_minmax(0,1fr)_2rem] items-center gap-2 rounded-md border bg-muted/30 px-3 py-2">
        <span aria-hidden="true" />
        <code
          className="ld-code-value min-w-0 truncate text-center font-mono text-xl font-normal tracking-[0.14em]"
          data-state={hasCode ? 'ready' : 'placeholder'}
          aria-label="Device link code"
        >
          {hasCode ? requestState.code : '••••••'}
        </code>
        <ShadcnButton
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={handleCopyCode}
          aria-label="Copy device link code"
          data-state={codeCopied ? 'copied' : 'idle'}
          disabled={!hasCode}
          className="ld-code-copy justify-self-end"
        >
          {codeCopied ? (
            <CheckIcon aria-hidden="true" />
          ) : (
            <CopyIcon aria-hidden="true" />
          )}
        </ShadcnButton>
      </div>

      {/* Rituals fork: no instance picker; spaces live on this origin. */}

      {status && (
        <div className="ld-status text-sm text-muted-foreground">{status}</div>
      )}
      {error && (
        <Alert variant="destructive" className="ld-error">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <div className="ld-footer flex items-center gap-2">
        <ShadcnButton
          variant="ghost"
          size="lg"
          className="ld-back-link"
          asChild
        >
          <Link to="/">
            <ArrowLeftIcon data-icon="inline-start" />
            Back
          </Link>
        </ShadcnButton>
        <ShadcnButton
          variant="secondary"
          size="lg"
          className="flex-1"
          onClick={() => setRefreshKey((value) => value + 1)}
        >
          Regenerate
        </ShadcnButton>
      </div>
    </Card>
  );
}


function ApproveLinkView({ initialPayload, unlockResumePath, homeInstanceUrl }) {
  const navigate = useNavigate();
  return (
    <ApproveDeviceLinkFlow
      mode="page"
      initialPayload={initialPayload}
      homeInstanceUrl={homeInstanceUrl}
      onCancel={() => navigate('/')}
      onVaultUnlockNeeded={() => navigate(unlockResumePath)}
    />
  );
}

export default function LinkDevice() {
  useBodyScrollMode(BODY_SCROLL_MODE.SCROLL);

  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const { selectedInstanceUrl } = useAuthInstanceSelection();

  const isNewDeviceMode = searchParams.get('mode') === 'new';
  const qrPayload = useMemo(() => {
    const encoded = searchParams.get('payload');
    if (!encoded) return null;
    try {
      return decodeQRPayload(encoded);
    } catch {
      return null;
    }
  }, [searchParams]);
  const unlockResumePath = useMemo(() => buildUnlockResumePath(location), [location]);

  return (
    <div className="flex min-h-svh w-full justify-center bg-background px-4 py-6 sm:px-6">
      <div className="my-auto flex w-full max-w-md flex-col gap-4">
        {isNewDeviceMode ? (
          <NewDeviceLinkView
            onLinked={() => navigate('/', { replace: true })}
            selectedInstanceUrl={selectedInstanceUrl}
          />
        ) : (
          <ApproveLinkView
            initialPayload={qrPayload}
            unlockResumePath={unlockResumePath}
            homeInstanceUrl={selectedInstanceUrl}
          />
        )}
      </div>
    </div>
  );
}
