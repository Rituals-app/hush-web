/**
 * /space — the Rituals Space entry (Rituals fork, 2026-11-05).
 *
 * Rituals opens `https://space.rit.al/space#t=<ticket>`. The ticket was
 * already moved into memory + sessionStorage and the address bar rewritten
 * to `/space` by src/lib/ritualsSpaceBoot.js before anything rendered.
 * This page then takes the person in with no input:
 *
 *   - no identity on this device → create one silently
 *     (useAuth.provisionRitualsSpaceIdentity: random phrase, ticket as the
 *     invite code, no PIN, `never` vault policy);
 *   - an identity with a PIN → the PIN unlock panel, then continue;
 *   - signed in → POST /api/rituals/spaces/claim {ticket}, refresh the space
 *     list, then replace the URL with the space's channel route.
 *
 * The page is mounted in both route trees (signed out and signed in), so
 * the in-flight steps live in a module-level single-flight map keyed by the
 * ticket: a remount re-attaches instead of registering or claiming twice.
 * Claims are idempotent on the server, so a repeat tap lands in the same
 * space.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowUpRightIcon, RefreshCwIcon } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { RitualsMark } from '@/components/brand/HushLogo';
import { PinUnlockPanel } from '@/components/auth/pin-unlock-panel';
import { PinSetupPanel } from '@/components/auth/pin-setup-panel';
import { useAuth } from '../contexts/AuthContext';
import { useInstanceContext } from '../contexts/InstanceContext';
import { useBootController } from '../hooks/useBootController.jsx';
import { BODY_SCROLL_MODE, useBodyScrollMode } from '../hooks/useBodyScrollMode';
import { getActiveAuthInstanceUrlSync, normalizeInstanceUrl } from '../lib/authInstanceStore';
import { buildGuildRouteRef } from '../lib/slugify';
import {
  RITUALS_HOME_URL,
  SPACE_SOURCE_LINKS,
  claimRitualsSpace,
  classifySpaceError,
  clearSpaceTicket,
  isEmbedded,
  postToRitualsHost,
  readSpaceTicket,
  readSpaceTicketHints,
  spaceDisplayName,
  spaceUsernameCandidates,
  subscribeSpaceTicket,
} from '../lib/ritualsSpace';

/** How long the page waits for a session or the space list before offering Retry. */
const STALL_TIMEOUT_MS = 25_000;

const flights = new Map();

/**
 * Runs `run` once per key while it is in flight; later callers share it.
 * A settled flight is forgotten so Retry can start a new one.
 */
function singleFlight(key, run) {
  const existing = flights.get(key);
  if (existing) return existing;
  const promise = Promise.resolve()
    .then(run)
    .finally(() => {
      if (flights.get(key) === promise) flights.delete(key);
    });
  flights.set(key, promise);
  return promise;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The space origin: the active auth instance, which is this page's origin. */
function spaceInstanceUrl() {
  return (
    normalizeInstanceUrl(getActiveAuthInstanceUrlSync())
    || normalizeInstanceUrl(window.location.origin)
    || window.location.origin
  );
}

const ERROR_COPY = {
  no_ticket: {
    title: 'Open this space from Rituals',
    body: 'Spaces open from a shared task in Rituals. Tap the people on the task to come back here.',
    retry: false,
  },
  expired: {
    title: 'This link has expired',
    body: 'This link has expired. Open the space again from Rituals.',
    retry: false,
  },
  revoked: {
    title: "You're no longer in this space",
    body: "It belongs to a shared task in Rituals, and you're no longer on that task.",
    retry: false,
  },
  full: {
    title: 'This space is full',
    body: "There's no room for another device in this space right now.",
    retry: false,
  },
  used: {
    title: 'This link was already used',
    body: 'Open the space again from Rituals.',
    retry: false,
  },
  seat_conflict: {
    title: 'Already in this space',
    body: 'This device is already in this space as someone else.',
    retry: false,
  },
  banned: {
    title: "You can't join this space",
    body: 'This device can no longer join this space.',
    retry: false,
  },
  invalid: {
    title: "This link doesn't work",
    body: 'Open the space again from Rituals.',
    retry: false,
  },
  unavailable: {
    title: "Spaces aren't available right now",
    body: 'Try again in a little while.',
    retry: true,
  },
  network: {
    title: "Couldn't reach the space",
    body: 'Check your connection and try again.',
    retry: true,
  },
};

function SpaceScreen({ children, footer = true }) {
  useBodyScrollMode(BODY_SCROLL_MODE.SCROLL);
  const inHost = isEmbedded();
  return (
    <main className="flex min-h-svh w-full flex-col bg-sidebar px-6 py-8 text-foreground">
      <div className="my-auto flex w-full max-w-sm flex-col items-center gap-6 self-center text-center">
        <RitualsMark className="size-11 text-foreground" />
        {children}
      </div>
      {footer ? (
        <p className="mt-8 text-center text-xs text-muted-foreground">
          {inHost ? null : (
            <>
              <a
                className="underline-offset-4 hover:text-foreground hover:underline"
                href={RITUALS_HOME_URL}
              >
                Rituals
              </a>
              <span aria-hidden className="px-1.5">·</span>
            </>
          )}
          <a
            className="underline-offset-4 hover:text-foreground hover:underline"
            href={SPACE_SOURCE_LINKS.index}
            target="_blank"
            rel="noopener noreferrer"
          >
            Source
          </a>
        </p>
      ) : null}
    </main>
  );
}

function ProgressScreen({ title, detail }) {
  return (
    <SpaceScreen>
      <div className="flex flex-col items-center gap-2" role="status" aria-live="polite">
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {detail ? (
          <p className="max-w-full break-words text-sm text-muted-foreground">{detail}</p>
        ) : null}
      </div>
      <Spinner className="size-5 text-muted-foreground" />
    </SpaceScreen>
  );
}

function ErrorScreen({ kind, onRetry, retrying }) {
  const copy = ERROR_COPY[kind] ?? ERROR_COPY.network;
  const inHost = isEmbedded();
  return (
    <SpaceScreen>
      <div className="flex flex-col items-center gap-2" role="alert">
        <h1 className="text-xl font-semibold tracking-tight">{copy.title}</h1>
        <p className="text-sm text-muted-foreground">{copy.body}</p>
      </div>
      <div className="flex w-full flex-col gap-2">
        {copy.retry && onRetry ? (
          <Button size="lg" className="w-full" onClick={onRetry} disabled={retrying}>
            {retrying ? <Spinner data-icon="inline-start" /> : <RefreshCwIcon data-icon="inline-start" />}
            {retrying ? 'Trying again…' : 'Try again'}
          </Button>
        ) : null}
        {inHost ? null : (
          <Button
            asChild
            size="lg"
            variant={copy.retry ? 'ghost' : 'default'}
            className="w-full"
          >
            <a href={RITUALS_HOME_URL}>
              Open Rituals
              <ArrowUpRightIcon data-icon="inline-end" />
            </a>
          </Button>
        )}
      </div>
    </SpaceScreen>
  );
}

export default function SpacePage() {
  const navigate = useNavigate();
  const { bootState } = useBootController();
  const auth = useAuth();
  const { mergedGuilds, refreshGuilds } = useInstanceContext();

  const [ticket, setTicket] = useState(() => readSpaceTicket());
  const [errorKind, setErrorKind] = useState(() => (readSpaceTicket() ? null : 'no_ticket'));
  const [attempt, setAttempt] = useState(0);
  const [retrying, setRetrying] = useState(false);
  const [claim, setClaim] = useState(null);

  const authRef = useRef(auth);
  authRef.current = auth;
  const mergedGuildsRef = useRef(mergedGuilds);
  mergedGuildsRef.current = mergedGuilds;
  const reauthTriedRef = useRef(new Set());

  const hints = useMemo(() => (ticket ? readSpaceTicketHints(ticket) : null), [ticket]);
  const userId = auth.user?.id ?? null;
  const token = auth.token ?? null;

  useEffect(() => {
    document.title = 'Rituals Space';
  }, []);

  // A newer ticket delivered to this running page restarts the entry.
  useEffect(() => subscribeSpaceTicket((next) => {
    setTicket(next);
    setClaim(null);
    setErrorKind(null);
    setAttempt((n) => n + 1);
  }), []);

  // Terminal screens tell the native host (it may be showing a loader).
  useEffect(() => {
    if (errorKind) postToRitualsHost({ type: 'error', reason: errorKind });
  }, [errorKind]);

  const fail = useCallback((kind) => {
    setErrorKind(kind);
    setRetrying(false);
  }, []);

  // ── 1. No identity on this device: create one, no input ────────────────
  const needsIdentity = bootState === 'needs_login' && !auth.hasVault;
  useEffect(() => {
    if (!ticket || errorKind || !needsIdentity) return undefined;
    let cancelled = false;
    const usernames = spaceUsernameCandidates(hints);
    const displayName = spaceDisplayName(hints, usernames[0]);
    singleFlight(`provision:${ticket}`, () =>
      authRef.current.provisionRitualsSpaceIdentity({
        ticket,
        displayName,
        usernames,
        instanceUrl: spaceInstanceUrl(),
      }),
    ).catch((err) => {
      if (cancelled) return;
      console.warn('[space] could not set up this device:', err);
      fail(classifySpaceError(err));
    });
    return () => { cancelled = true; };
  }, [ticket, errorKind, needsIdentity, hints, attempt, fail]);

  // ── 2. Signed in: claim the seat (idempotent) ──────────────────────────
  const signedIn = bootState === 'ready' || bootState === 'booted';
  useEffect(() => {
    if (!ticket || errorKind || !signedIn || !token || !userId || claim) return undefined;
    let cancelled = false;
    const instanceUrl = spaceInstanceUrl();
    singleFlight(`claim:${ticket}:${userId}`, () => claimRitualsSpace(token, ticket, instanceUrl))
      .then((result) => {
        if (!cancelled) setClaim(result);
      })
      .catch(async (err) => {
        if (cancelled) return;
        // A stale session: mint a fresh one once, then claim again.
        if (Number(err?.status) === 401 && !reauthTriedRef.current.has(ticket)) {
          reauthTriedRef.current.add(ticket);
          const ok = await authRef.current.reauthenticateNow();
          if (cancelled) return;
          if (ok) {
            setAttempt((n) => n + 1);
            return;
          }
        }
        console.warn('[space] claim failed:', err);
        fail(classifySpaceError(err));
      });
    return () => { cancelled = true; };
  }, [ticket, errorKind, signedIn, token, userId, claim, attempt, fail]);

  // ── 3. Open the space once it is in the list ───────────────────────────
  useEffect(() => {
    if (!claim || errorKind || bootState !== 'booted') return undefined;
    let cancelled = false;
    (async () => {
      const instanceUrl = spaceInstanceUrl();
      const known = () => mergedGuildsRef.current.some((g) => g.id === claim.serverId);
      for (let i = 0; i < 5 && !known(); i++) {
        try {
          await refreshGuilds(instanceUrl);
        } catch {
          // Retried below; the WS member_joined event also refreshes.
        }
        if (cancelled) return;
        if (known()) break;
        await delay(300 * (i + 1));
        if (cancelled) return;
      }
      if (!known()) {
        fail('network');
        return;
      }
      clearSpaceTicket(ticket);
      const host = new URL(instanceUrl).host;
      const ref = buildGuildRouteRef('space', claim.serverId);
      navigate(
        claim.channelId ? `/${host}/${ref}/${claim.channelId}` : `/${host}/${ref}`,
        { replace: true },
      );
    })();
    return () => { cancelled = true; };
  }, [claim, errorKind, bootState, refreshGuilds, navigate, ticket, fail]);

  // ── Watchdog: never spin forever (offline unlock, slow boot) ────────────
  useEffect(() => {
    if (!ticket || errorKind) return undefined;
    if (bootState === 'needs_pin' || bootState === 'pin_setup') return undefined;
    if (bootState === 'needs_login' && auth.hasVault) return undefined;
    const timer = setTimeout(() => fail('network'), STALL_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [ticket, errorKind, bootState, auth.hasVault, attempt, fail]);

  const retry = useCallback(async () => {
    setRetrying(true);
    // Unlocked locally but no server session yet: mint one now.
    const current = authRef.current;
    if (current.vaultState === 'unlocked' && !current.token) {
      await current.reauthenticateNow();
    }
    setClaim(null);
    setErrorKind(null);
    setRetrying(false);
    setAttempt((n) => n + 1);
  }, []);

  // ── Render ──────────────────────────────────────────────────────────────
  if (errorKind) {
    return <ErrorScreen kind={errorKind} onRetry={retry} retrying={retrying} />;
  }

  // An identity with a PIN: unlock first, then the steps above continue.
  if (bootState === 'needs_pin' || (bootState === 'needs_login' && auth.hasVault)) {
    return <PinUnlockPanel />;
  }
  if (bootState === 'pin_setup') {
    return <PinSetupPanel />;
  }

  const spaceName = hints?.name?.trim() || null;
  if (needsIdentity) {
    return <ProgressScreen title="Opening the space" detail={spaceName ?? 'Setting up this device…'} />;
  }
  return <ProgressScreen title="Opening the space" detail={spaceName} />;
}
