// Rituals fork: must stay the first import (strips `/space#t=` at once).
import './lib/ritualsSpaceBoot.js';
import { ensureSpaceAccount, readSpaceTicket } from './lib/ritualsSpace';

// Rituals fork (2026-11-05): one local Space identity per Rituals account. The
// check runs before any other module of the app is loaded, so nothing has
// opened the identity databases yet when they must be cleared for a different
// account; the app itself lives in ./appMain.jsx.
function showSwitchBlocked() {
  const root = document.getElementById('root');
  if (!root) return;
  const main = document.createElement('main');
  main.setAttribute('style', 'max-width:28rem;margin:20vh auto;padding:0 1.5rem;font:16px/1.5 system-ui,sans-serif;text-align:center');
  const text = document.createElement('p');
  text.textContent = 'Another Space tab is still open on this device. Close it, then open the space again from Rituals.';
  const retry = document.createElement('button');
  retry.type = 'button';
  retry.textContent = 'Try again';
  retry.setAttribute('style', 'margin-top:1rem;padding:.5rem 1rem;border-radius:999px;border:1px solid currentColor;background:none;font:inherit;cursor:pointer');
  retry.addEventListener('click', () => window.location.reload());
  main.append(text, retry);
  root.replaceChildren(main);
}

ensureSpaceAccount(readSpaceTicket()).then(
  () => import('./appMain.jsx'),
  showSwitchBlocked,
);
