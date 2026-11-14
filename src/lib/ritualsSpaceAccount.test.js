import { afterEach, describe, expect, it } from 'vitest';
import { ensureSpaceAccount, SPACE_ACCOUNT_KEY, SPACE_TICKET_STORAGE_KEY } from './ritualsSpace.js';
import { QUIET_UPDATE_STORAGE_KEY } from './quietUpdate';

// Rituals fork: an account switch (src/lib/ritualsSpace.js ensureSpaceAccount)
// clears this tab's storage, but keeps the quiet-update retry guard so a
// second automatic reload cannot follow within the retry window.

const OLD_ACCT = 'a'.repeat(64);
const NEW_ACCT = 'b'.repeat(64);

function ticketFor(acct) {
  const payload = btoa(JSON.stringify({ acct, dn: 'Test Person' }))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return `rt1.${payload}.sig`;
}

afterEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
});

describe('ensureSpaceAccount on an account switch', () => {
  it('keeps the quiet-update guard and clears everything else', async () => {
    const ticket = ticketFor(NEW_ACCT);
    window.localStorage.setItem(SPACE_ACCOUNT_KEY, OLD_ACCT);
    window.localStorage.setItem('old_local', '1');
    window.sessionStorage.setItem(QUIET_UPDATE_STORAGE_KEY, '1700000000000');
    window.sessionStorage.setItem('old_session', '1');

    expect(await ensureSpaceAccount(ticket)).toBe('switched');

    expect(window.sessionStorage.getItem(QUIET_UPDATE_STORAGE_KEY)).toBe('1700000000000');
    expect(window.sessionStorage.getItem(SPACE_TICKET_STORAGE_KEY)).toBe(ticket);
    expect(window.sessionStorage.getItem('old_session')).toBeNull();
    expect(window.sessionStorage.length).toBe(2);
    expect(window.localStorage.getItem('old_local')).toBeNull();
    expect(window.localStorage.getItem(SPACE_ACCOUNT_KEY)).toBe(NEW_ACCT);
  });

  it('does not invent a guard when none was set', async () => {
    window.localStorage.setItem(SPACE_ACCOUNT_KEY, OLD_ACCT);
    window.sessionStorage.setItem('old_session', '1');

    expect(await ensureSpaceAccount(ticketFor(NEW_ACCT))).toBe('switched');

    expect(window.sessionStorage.getItem(QUIET_UPDATE_STORAGE_KEY)).toBeNull();
    expect(window.sessionStorage.getItem('old_session')).toBeNull();
  });
});
