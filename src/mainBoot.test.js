import { afterEach, describe, expect, it, vi } from 'vitest';

// Rituals fork (2026-11-06): boot in src/main.jsx. The boot-time update step
// (src/lib/quietUpdate.ts) runs before the ticket is read, the account is
// checked or the app is loaded, and boot stops when it is reloading the page.
// When the app module fails to load (after a release, this page's old build
// asks for files the host no longer has), boot loads the newer build, asks
// first while other Space pages are open, or offers a retry.

const calls = vi.hoisted(() => []);
const state = vi.hoisted(() => ({ outcomes: [], controllerChanged: false, framed: false, appError: null }));

vi.mock('./lib/ritualsSpaceBoot.js', () => ({}));
vi.mock('./lib/ritualsSpace', () => ({
  ensureSpaceAccount: vi.fn(async () => { calls.push('account'); }),
  isFramed: vi.fn(() => state.framed),
  postToRitualsParent: vi.fn((message) => { calls.push(`parent:${message.type}`); }),
  readSpaceTicket: vi.fn(() => { calls.push('ticket'); return null; }),
}));
vi.mock('./lib/ritualsSpaceProbe', () => ({
  checkFrameStorage: vi.fn(async () => { calls.push('storage'); return { usable: true }; }),
}));
vi.mock('./lib/ritualsSpaceInstance', () => ({
  isFrameHostTopLevel: vi.fn(() => { calls.push('frame-host'); return false; }),
  pageInstanceOrigin: vi.fn(() => 'https://space.example.test'),
}));
vi.mock('./lib/quietUpdate', () => ({
  applyWaitingBuildAtStart: vi.fn(async (options) => {
    calls.push(options?.awaitInstall ? 'quiet-await' : 'quiet');
    return state.outcomes.shift() ?? 'none-waiting';
  }),
  controllerChangedSinceBoot: vi.fn(() => state.controllerChanged),
  activateWaitingBuild: vi.fn(async () => { calls.push('activate'); }),
}));
vi.mock('./lib/chunkErrors', async (importOriginal) => {
  const actual = await importOriginal();
  // An error thrown by a vi.doMock factory reaches the importer wrapped by
  // vitest, with the thrown error as its cause.
  return { ...actual, isChunkLoadError: (error) => actual.isChunkLoadError(error?.cause ?? error) };
});

const LOADING = 'Loading the latest version of this space…';
const ASK = 'A newer version of this space is ready. Updating also reloads other open Space tabs.';
const RETRY = 'This space could not load. Check your connection, then try again.';
const BROKEN = 'This space could not load. Try again.';

function chunkError() {
  return new TypeError('Failed to fetch dynamically imported module: https://space.example.test/assets/appMain-old.js');
}

function notice() {
  return document.querySelector('#root main p')?.textContent ?? null;
}

function noticeButton() {
  return document.querySelector('#root main button');
}

/** Boots src/main.jsx and waits until `settled` passes, then one more tick. */
async function boot(setup, settled) {
  calls.length = 0;
  Object.assign(state, { outcomes: [], controllerChanged: false, framed: false, appError: null }, setup);
  state.outcomes = [...state.outcomes];
  document.body.innerHTML = '<div id="root"></div>';
  vi.resetModules();
  // Registered per boot: a vi.mock factory runs only once per file.
  vi.doMock('./appMain.jsx', () => {
    calls.push('app');
    if (state.appError) throw state.appError;
    return {};
  });
  await import('./main.jsx');
  await vi.waitFor(settled);
  // Let any step that should not run have its chance to run.
  await new Promise((resolve) => setTimeout(resolve, 0));
  return [...calls];
}

const lastCall = (name) => () => expect(calls.at(-1)).toBe(name);
const showsNotice = (text) => () => expect(notice()).toBe(text);

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('boot order (src/main.jsx)', () => {
  it.each(['none-waiting', 'other-pages', 'recent', 'error', 'no-locks', 'uncontrolled'])(
    'runs the update step first, then boots the app (%s)',
    async (outcome) => {
      expect(await boot({ outcomes: [outcome] }, lastCall('app'))).toEqual(['frame-host', 'quiet', 'ticket', 'account', 'app']);
    },
  );

  it.each(['applied', 'taken-over'])(
    'stops before the ticket, the account check and the app when it is reloading (%s)',
    async (outcome) => {
      expect(await boot({ outcomes: [outcome] }, lastCall('quiet'))).toEqual(['frame-host', 'quiet']);
    },
  );

  it('checks again right before the app loads when another page activated a newer build meanwhile', async () => {
    const order = await boot(
      { outcomes: ['none-waiting', 'taken-over'], controllerChanged: true },
      () => expect(calls.filter((call) => call === 'quiet')).toHaveLength(2),
    );

    expect(order).toEqual(['frame-host', 'quiet', 'ticket', 'account', 'quiet']);
  });

  it('boots the app after that second check when it does not reload', async () => {
    const order = await boot({ outcomes: ['none-waiting', 'recent'], controllerChanged: true }, lastCall('app'));

    expect(order).toEqual(['frame-host', 'quiet', 'ticket', 'account', 'quiet', 'app']);
  });

  it('does not check again when the worker did not change', async () => {
    const order = await boot({ outcomes: ['none-waiting', 'applied'] }, lastCall('app'));

    expect(order).toEqual(['frame-host', 'quiet', 'ticket', 'account', 'app']);
  });
});

describe('when the app module fails to load (src/main.jsx)', () => {
  it.each(['applied', 'taken-over'])(
    'loads the newer build, waiting for one still installing (%s)',
    async (outcome) => {
      const order = await boot({ outcomes: ['none-waiting', outcome], appError: chunkError() }, lastCall('quiet-await'));

      expect(order).toEqual(['frame-host', 'quiet', 'ticket', 'account', 'app', 'quiet-await']);
      expect(notice()).toBe(LOADING);
      expect(noticeButton()).toBeNull();
    },
  );

  it.each(['other-pages', 'no-locks', 'lock-late', 'no-storage'])(
    'asks before loading the newer build, because that reloads other Space pages (%s)',
    async (outcome) => {
      await boot({ outcomes: ['none-waiting', outcome], appError: chunkError() }, showsNotice(ASK));

      const button = noticeButton();
      expect(button?.textContent).toBe('Update');
      expect(calls).not.toContain('activate');
      button.click();
      expect(button.disabled).toBe(true);
      expect(calls.at(-1)).toBe('activate');
      expect(calls.filter((call) => call === 'activate')).toHaveLength(1);
    },
  );

  it.each(['none-waiting', 'uncontrolled', 'recent', 'no-registration', 'post-failed', 'error'])(
    'offers a retry when no newer build can be loaded (%s)',
    async (outcome) => {
      const order = await boot({ outcomes: ['none-waiting', outcome], appError: chunkError() }, showsNotice(RETRY));

      expect(order).toEqual(['frame-host', 'quiet', 'ticket', 'account', 'app', 'quiet-await']);
      expect(noticeButton()?.textContent).toBe('Try again');
    },
  );

  it.each([
    ['Firefox', new TypeError('error loading dynamically imported module: https://space.example.test/assets/appMain-old.js')],
    ['Safari', new TypeError('Importing a module script failed.')],
    ['a stylesheet', new Error('Unable to preload CSS for /assets/appMain-old.css')],
  ])('recognises a failed load as %s words it', async (_label, error) => {
    const order = await boot({ outcomes: ['none-waiting', 'applied'], appError: error }, lastCall('quiet-await'));

    expect(order.at(-1)).toBe('quiet-await');
  });

  it('in the Rituals pane, tells the parent first and uses the pane layout', async () => {
    const order = await boot(
      { outcomes: ['none-waiting', 'none-waiting'], framed: true, appError: chunkError() },
      showsNotice(RETRY),
    );

    expect(order).toEqual(['frame-host', 'quiet', 'ticket', 'storage', 'account', 'app', 'parent:busy', 'quiet-await']);
    expect(document.querySelector('#root main')?.getAttribute('style')).toContain('max-width:22rem');
  });

  it('shows a retry and logs the error when the app module itself throws', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const broken = new Error('boom');

    const order = await boot({ outcomes: ['none-waiting'], appError: broken }, showsNotice(BROKEN));

    expect(order).toEqual(['frame-host', 'quiet', 'ticket', 'account', 'app']);
    expect(noticeButton()?.textContent).toBe('Try again');
    expect(consoleError).toHaveBeenCalledOnce();
    const logged = consoleError.mock.calls[0][0];
    expect(logged === broken || logged?.cause === broken).toBe(true);
  });

  it('tells the Rituals parent when the app module itself throws in the pane', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const order = await boot({ outcomes: ['none-waiting'], framed: true, appError: new Error('boom') }, showsNotice(BROKEN));

    expect(order).toEqual(['frame-host', 'quiet', 'ticket', 'storage', 'account', 'app', 'parent:busy']);
  });
});
