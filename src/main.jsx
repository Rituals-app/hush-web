// Rituals fork: must stay the first import (strips `/space#t=` at once).
import './lib/ritualsSpaceBoot.js';
import { ensureSpaceAccount, isFramed, postToRitualsParent, readSpaceTicket } from './lib/ritualsSpace';
import { checkFrameStorage } from './lib/ritualsSpaceProbe';
import { isFrameHostTopLevel, pageInstanceOrigin } from './lib/ritualsSpaceInstance';
import { applyWaitingBuildAtStart } from './lib/quietUpdate';

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
  main.append(text, button);
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

async function boot() {
  if (isFrameHostTopLevel()) {
    showOpenInRituals();
    return;
  }
  // Before anything starts: a newer build that is waiting is applied here,
  // with one reload, when this is the only open Space page
  // (src/lib/quietUpdate.ts). The pending ticket survives in sessionStorage.
  if ((await applyWaitingBuildAtStart()) === 'applied') return;
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
  await import('./appMain.jsx');
}

boot();
