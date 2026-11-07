// Rituals fork: must stay the first import (strips `/space#t=` at once).
import './lib/ritualsSpaceBoot.js';
import { ensureSpaceAccount, isFramed, postToRitualsParent, readSpaceTicket } from './lib/ritualsSpace';
import { checkFrameStorage } from './lib/ritualsSpaceProbe';
import { isFrameHostTopLevel, pageInstanceOrigin } from './lib/ritualsSpaceInstance';
import { activateWaitingBuild, applyWaitingBuildAtStart, controllerChangedSinceBoot } from './lib/quietUpdate';
import { isChunkLoadError } from './lib/chunkErrors';

// Rituals fork (2026-11-05): one local Space identity per Rituals account. The
// check runs before any other module of the app is loaded, so nothing has
// opened the identity databases yet when they must be cleared for a different
// account; the app itself lives in ./appMain.jsx. In the rituals.app frame a
// storage check runs first (src/lib/ritualsSpaceProbe.js).
const BUTTON_STYLE = 'margin-top:1rem;padding:.5rem 1rem;border-radius:999px;border:1px solid currentColor;background:none;font:inherit;cursor:pointer';

function showNotice(message, button, compact) {
  const root = document.getElementById('root');
  if (!root) return;
  const main = document.createElement('main');
  main.setAttribute('style', compact
    ? 'max-width:22rem;margin:0 auto;padding:30vh 1rem 0;font:15px/1.5 system-ui,sans-serif;text-align:center'
    : 'max-width:28rem;margin:20vh auto;padding:0 1.5rem;font:16px/1.5 system-ui,sans-serif;text-align:center');
  const text = document.createElement('p');
  text.textContent = message;
  main.append(text);
  if (button) main.append(button);
  root.replaceChildren(main);
}

function retryButton() {
  const retry = document.createElement('button');
  retry.type = 'button';
  retry.textContent = 'Try again';
  retry.setAttribute('style', BUTTON_STYLE);
  retry.addEventListener('click', () => window.location.reload());
  return retry;
}

function showSwitchBlocked() {
  if (isFramed()) {
    // In the Rituals pane: a pane state, and the parent hears why.
    postToRitualsParent({ type: 'busy' });
    showNotice('Another Space tab is still open. Close it, then try again.', retryButton(), true);
    return;
  }
  showNotice('Another Space tab is still open on this device. Close it, then open the space again from Rituals.', retryButton(), false);
}

// Framed with storage that does not work at all (private mode, blocked
// storage): never boot, never create an identity. The parent hears why; the
// door opens the space top-level on the Space host (ticket in the fragment).
function showStorageUnavailable(ticket, reason) {
  postToRitualsParent({ type: 'storage-unavailable', reason });
  // The notice is a pane state: shown at once, not after the settle timer.
  postToRitualsParent({ type: 'busy' });
  const open = document.createElement('button');
  open.type = 'button';
  open.textContent = 'Open space \u2197';
  open.setAttribute('style', BUTTON_STYLE);
  open.addEventListener('click', () => {
    const base = `${pageInstanceOrigin()}/space`;
    window.open(ticket ? `${base}#t=${encodeURIComponent(ticket)}` : base, '_blank', 'noopener');
  });
  showNotice('This browser is not keeping data for this space here.', open, true);
}

// The frame host opened on its own: a plain page, nothing booted or stored.
function showOpenInRituals() {
  const link = document.createElement('a');
  link.href = 'https://rituals.app';
  link.textContent = 'Open in Rituals';
  link.setAttribute('style', `${BUTTON_STYLE};display:inline-block;color:inherit;text-decoration:none`);
  showNotice('Spaces open inside Rituals.', link, false);
}

function updateButton() {
  const update = document.createElement('button');
  update.type = 'button';
  update.textContent = 'Update';
  update.setAttribute('style', BUTTON_STYLE);
  update.addEventListener('click', () => {
    update.disabled = true;
    void activateWaitingBuild();
  });
  return update;
}

// Outcomes after which this page is reloading, so boot must stop.
const RELOADING = new Set(['applied', 'taken-over']);
// The newer build is ready but this page will not activate it unasked: other
// Space pages are open (activating it reloads them too), this browser cannot
// tell whether they are, or it cannot record a reload (no retry guard). The
// person decides; the notice says what Update does in each case.
const ASK_FIRST = new Map([
  ['other-pages', 'A newer version of this space is ready. Updating also reloads other open Space tabs.'],
  ['no-locks', 'A newer version of this space is ready. Updating also reloads any other open Space tabs.'],
  ['lock-late', 'A newer version of this space is ready. Updating also reloads any other open Space tabs.'],
  ['no-storage', 'A newer version of this space is ready.'],
]);

// The app module (or a file it needs) did not load. After a release that is
// usually this page's old build asking for files the host no longer has:
// load the newer build when it is ready, else offer a retry.
async function recoverFromFailedLoad(framed) {
  showNotice('Loading the latest version of this space\u2026', null, framed);
  const outcome = await applyWaitingBuildAtStart({ awaitInstall: true });
  if (RELOADING.has(outcome)) return;
  if (ASK_FIRST.has(outcome)) {
    // Another page may activate the newer build first; it then controls this
    // page too, so load it here as well.
    navigator.serviceWorker?.addEventListener('controllerchange', () => window.location.reload(), { once: true });
    showNotice(ASK_FIRST.get(outcome), updateButton(), framed);
    return;
  }
  // No app runs behind this notice, so loading again loses nothing. 'online'
  // fires only when the connection comes back, so this cannot loop.
  window.addEventListener('online', () => window.location.reload(), { once: true });
  showNotice('This space could not load. Check your connection, then try again.', retryButton(), framed);
}

async function boot() {
  if (isFrameHostTopLevel()) {
    showOpenInRituals();
    return;
  }
  // Before anything starts: a newer build that is waiting is applied here,
  // with one reload, when this is the only open Space page
  // (src/lib/quietUpdate.ts). The pending ticket survives in sessionStorage.
  if (RELOADING.has(await applyWaitingBuildAtStart())) return;
  const ticket = readSpaceTicket();
  // Before any identity work (the account check may clear storage). The
  // frame boots whatever the partitioning; only unusable storage stops it.
  if (isFramed()) {
    const storage = await checkFrameStorage().catch(() => ({ usable: false, reason: 'indexeddb_unavailable' }));
    if (!storage.usable) {
      showStorageUnavailable(ticket, storage.reason);
      return;
    }
  }
  try {
    await ensureSpaceAccount(ticket);
  } catch {
    showSwitchBlocked();
    return;
  }
  // Another page may have activated a newer build while this one booted; this
  // page's build would then load from a worker that no longer holds it.
  if (controllerChangedSinceBoot() && RELOADING.has(await applyWaitingBuildAtStart())) return;
  try {
    await import('./appMain.jsx');
  } catch (error) {
    const framed = isFramed();
    // A pane state: the parent shows the frame at once.
    if (framed) postToRitualsParent({ type: 'busy' });
    if (isChunkLoadError(error)) {
      await recoverFromFailedLoad(framed);
      return;
    }
    // The app module itself threw: no newer build fixes that. The page shows a
    // retry and the console keeps the error.
    showNotice('This space could not load. Try again.', retryButton(), framed);
    console.error(error);
  }
}

boot();
