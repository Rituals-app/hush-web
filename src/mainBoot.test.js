import { afterEach, describe, expect, it, vi } from 'vitest';

// Rituals fork (2026-11-06): boot order in src/main.jsx. The boot-time update
// step (src/lib/quietUpdate.ts) runs before the ticket is read, the account is
// checked or the app is loaded, and boot stops when it is reloading the page.

const calls = vi.hoisted(() => []);
const quietOutcome = vi.hoisted(() => ({ value: 'none-waiting' }));

vi.mock('./lib/ritualsSpaceBoot.js', () => ({}));
vi.mock('./lib/ritualsSpace', () => ({
  ensureSpaceAccount: vi.fn(async () => { calls.push('account'); }),
  isFramed: vi.fn(() => false),
  postToRitualsParent: vi.fn(),
  readSpaceTicket: vi.fn(() => { calls.push('ticket'); return null; }),
}));
vi.mock('./lib/ritualsSpaceProbe', () => ({
  checkFrameStorage: vi.fn(async () => ({ usable: true })),
}));
vi.mock('./lib/ritualsSpaceInstance', () => ({
  isFrameHostTopLevel: vi.fn(() => { calls.push('frame-host'); return false; }),
  pageInstanceOrigin: vi.fn(() => 'https://space.example.test'),
}));
vi.mock('./lib/quietUpdate', () => ({
  applyWaitingBuildAtStart: vi.fn(async () => { calls.push('quiet'); return quietOutcome.value; }),
}));

async function bootWith(outcome) {
  calls.length = 0;
  quietOutcome.value = outcome;
  vi.resetModules();
  // Registered per boot: a vi.mock factory runs only once per file.
  vi.doMock('./appMain.jsx', () => { calls.push('app'); return {}; });
  await import('./main.jsx');
  await vi.waitFor(() => {
    expect(calls.at(-1)).toBe(outcome === 'applied' ? 'quiet' : 'app');
  });
  // Let any step that should not run have its chance to run.
  await new Promise((resolve) => setTimeout(resolve, 0));
  return [...calls];
}

afterEach(() => {
  quietOutcome.value = 'none-waiting';
});

describe('boot order (src/main.jsx)', () => {
  it.each(['none-waiting', 'other-pages', 'recent', 'error'])(
    'runs the update step first, then boots the app (%s)',
    async (outcome) => {
      expect(await bootWith(outcome)).toEqual(['frame-host', 'quiet', 'ticket', 'account', 'app']);
    },
  );

  it('stops before the ticket, the account check and the app when it is reloading', async () => {
    expect(await bootWith('applied')).toEqual(['frame-host', 'quiet']);
  });
});
