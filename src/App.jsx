import { lazy, Suspense, useEffect, useState } from 'react';
import { Routes, Route, Navigate, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import { InstanceProvider, useInstanceContext } from './contexts/InstanceContext';
import { BootProvider, useBootController } from './hooks/useBootController.jsx';
import AppBackground from './components/AppBackground';
import { BlockedTabView } from './components/blocked-tab-view.tsx';
import { DesktopShell } from './components/desktop/DesktopShell.jsx';
import { DesktopUpdateBoundary } from './components/desktop/DesktopUpdateBoundary.jsx';
import { DesktopWindowFloorSync } from './components/desktop/DesktopWindowFloorSync.jsx';
import { useSingleTab } from './hooks/useSingleTab';
import { useDesktopShell } from './hooks/useDesktopShell';
import { buildGuildRouteRef } from './lib/slugify';
import { hasPendingSpaceEntry } from './lib/ritualsSpace';
import { Toaster } from './components/ui/sonner';
import { UpdateRequiredDialog } from './components/UpdateRequiredDialog';
import { ChunkErrorBoundary } from './components/ChunkErrorBoundary.jsx';
import { E2eTestAuthBridge } from './components/dev/E2eTestAuthBridge.jsx';

// Rituals fork: removed from the route trees and the shell, because Rituals
// owns a space's lifecycle and ships client and server together: the
// roadmap page, guild discovery (/explore), invite links (/invite, /join),
// the desktop manual-update prompt and the outdated-server banners.

const UnauthenticatedShell = lazy(() =>
  import('./components/auth/unauthenticated-shell').then((m) => ({
    default: m.UnauthenticatedShell,
  }))
);
const LinkDevice = lazy(() => import('./pages/LinkDevice.jsx'));
const AuthenticatedApp = lazy(() =>
  import('./components/authenticated-app').then((m) => ({ default: m.AuthenticatedApp }))
);
// Rituals fork: the signed-ticket entry, /space#t=<ticket>.
const SpacePage = lazy(() => import('./pages/SpacePage.jsx'));

const fallback = (
  <div style={{
    height: '100%',
    background: 'var(--sidebar)',
  }} />
);

// ── PostLoginRedirect ─────────────────────────────────────────────────────────

/**
 * Shown at "/" when the user is authenticated. Redirects to the first guild
 * (if any) or to /home (empty state). Rituals fork: no `?join=` invite
 * params or queued invite links (spaces are entered from Rituals with a
 * signed ticket at /space).
 *
 * This replaces the routing logic that was previously in Home.jsx's vault-state
 * effect. The BootController guarantees this only renders when auth is ready.
 */
function PostLoginRedirect() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { mergedGuilds, guildsLoaded } = useInstanceContext();
  const returnTo = searchParams.get('returnTo');

  useEffect(() => {
    if (
      returnTo
      && returnTo.startsWith('/')
      && !returnTo.startsWith('//')
      && !returnTo.startsWith('/?')
      && returnTo !== '/'
    ) {
      navigate(returnTo, { replace: true });
      return;
    }

    // Wait for instance boot so mergedGuilds is populated.
    if (!guildsLoaded) return;

    // Navigate to first guild or empty state.
    if (mergedGuilds.length > 0) {
      const first = mergedGuilds[0];
      const instanceHost = first.instanceUrl
        ? new URL(first.instanceUrl).host
        : null;
      // Rituals fork: a neutral slug, never a task title, in the URL path.
      const guildRouteRef = buildGuildRouteRef('space', first.id);
      if (instanceHost) {
        navigate(`/${instanceHost}/${guildRouteRef}`, { replace: true });
        return;
      }
    }

    navigate('/home', { replace: true });
  }, [guildsLoaded, mergedGuilds, navigate, returnTo]);

  return fallback;
}

function TransparencyErrorScreen() {
  const { transparencyError } = useAuth();
  const message = transparencyError
    || 'A security check on your account failed. Do not continue on this device.';
  return (
    <div
      role="alert"
      aria-live="assertive"
      data-testid="transparency-error-screen"
      className="flex min-h-svh w-full items-center justify-center bg-background p-6"
    >
      <div className="flex max-w-md flex-col gap-3 rounded-lg border border-destructive/40 bg-card p-6 text-card-foreground shadow-sm">
        <h1 className="text-lg font-semibold text-destructive">
          Security check failed
        </h1>
        <p className="text-sm text-muted-foreground">{message}</p>
        <p className="text-xs text-muted-foreground">
          Your transparency log entries could not be verified. To protect
          your account, the app cannot continue on this device. Recover
          from another trusted device.
        </p>
      </div>
    </div>
  );
}

// ── AppContent ────────────────────────────────────────────────────────────────

/**
 * Top-level rendering switch driven by useBootController.
 *
 * This is the single place that decides what the user sees. No other component
 * independently checks auth/vault/guild state for routing decisions.
 *
 * Boot states:
 *   'loading'             → blank screen (auth rehydrating)
 *   'needs_login'         → Home (login/register UI) for all non-public routes
 *   'needs_pin'           → Home (PIN unlock screen) for all non-public routes
 *   'pin_setup'           → Home (PIN setup after registration) for all non-public routes
 *   'transparency_error'  → full-screen blocking security failure (no route tree)
 *   'ready'               → full route tree (instances still booting)
 *   'booted'              → full route tree (everything loaded)
 */
function AppContent() {
  const { bootState } = useBootController();

  if (bootState === 'loading') return fallback;

  // ── Unauthenticated: show login/PIN for most routes, keep public routes ──

  if (bootState === 'needs_login' || bootState === 'needs_pin' || bootState === 'pin_setup') {
    return (
      <Suspense fallback={fallback}>
        <Routes>
          {/* Rituals space entry: creates the identity / unlocks, then claims */}
          <Route path="/space" element={<SpacePage />} />

          {/* Public routes - accessible without auth */}
          <Route path="/link-device" element={<LinkDevice />} />
          <Route path="/room/:roomName" element={<Navigate to="/" replace />} />

          {/* Everything else → login/PIN screen */}
          <Route path="*" element={<UnauthenticatedShell />} />
        </Routes>
      </Suspense>
    );
  }

  if (bootState === 'transparency_error') {
    return <TransparencyErrorScreen />;
  }

  // ── Authenticated (ready or booted): full route tree ─────────────────────

  return (
    <>
      <Suspense fallback={fallback}>
        <Routes>
          {/* Post-login redirect: "/" → first guild or /home */}
          <Route path="/" element={<PostLoginRedirect />} />

          {/* DM landing / no-guild empty state */}
          <Route path="/home" element={<AuthenticatedApp />} />
          <Route
            path="/home/:channelSlug"
            element={<AuthenticatedApp />}
          />

          {/* Rituals space entry: claims the ticket, then opens the space */}
          <Route path="/space" element={<SpacePage />} />

          {/* Rituals fork: no discovery and no invite links (Rituals owns
              who is in a space). Old links land on the app. */}
          <Route path="/explore" element={<Navigate to="/" replace />} />
          <Route path="/join/:instance/:code" element={<Navigate to="/" replace />} />
          <Route path="/invite/:code" element={<Navigate to="/" replace />} />

          {/* Device-link approval/new-device handoff */}
          <Route path="/link-device" element={<LinkDevice />} />

          {/* Instance-aware guild route: /:instance/:guildSlug/:channelSlug? */}
          <Route
            path="/:instance/:guildSlug/:channelSlug?"
            element={<AuthenticatedApp />}
          />

          {/* Legacy redirects */}
          <Route path="/servers/:serverId/*" element={<Navigate to="/home" replace />} />
          <Route path="/guilds" element={<Navigate to="/home" replace />} />
          <Route path="/channels" element={<Navigate to="/home" replace />} />
          <Route path="/channels/:channelId" element={<Navigate to="/home" replace />} />

          {/* Utility pages */}
          <Route path="/room/:roomName" element={<Navigate to="/" replace />} />
          <Route path="/roadmap" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    </>
  );
}

// ── App root ─────────────────────────────────────────────────────────────────

export default function App() {
  useDesktopShell();
  const location = useLocation();
  // Rituals fork: a space entry (someone just tapped the people on a shared
  // task) takes the session over from an older tab instead of being blocked.
  // The favicon is the Rituals mark SVG, which follows the OS appearance by
  // itself, so upstream's favicon theme sync is gone.
  const [preferThisTab] = useState(() => hasPendingSpaceEntry());
  const { isBlockedTab, takeOver } = useSingleTab({ preferThisTab });
  const blockedFlow = location.pathname === '/link-device'
    ? 'device-link'
    : 'generic';

  if (isBlockedTab) {
    return <BlockedTabView blockedFlow={blockedFlow} takeOver={takeOver} />;
  }

  return (
    <DesktopUpdateBoundary>
      <AuthProvider>
        <InstanceProvider>
          <BootProvider>
            <DesktopWindowFloorSync />
            <E2eTestAuthBridge />
            <AppBackground />
            <DesktopShell>
              {/* Rituals fork: a screen that fails to load keeps the Update dialog mounted. */}
              <ChunkErrorBoundary>
                <AppContent />
              </ChunkErrorBoundary>
            </DesktopShell>
            <UpdateRequiredDialog />
            <Toaster position="bottom-right" richColors />
          </BootProvider>
        </InstanceProvider>
      </AuthProvider>
    </DesktopUpdateBoundary>
  );
}
