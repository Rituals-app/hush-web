import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const { authState, bootState, mockProvision } = vi.hoisted(() => ({
  authState: { current: null },
  bootState: { current: 'needs_login' },
  mockProvision: vi.fn(),
}));

const TICKET = `rt1.${'A'.repeat(40)}.${'B'.repeat(43)}`;

vi.mock('../contexts/AuthContext', () => ({ useAuth: () => authState.current }));
vi.mock('../hooks/useAuth', () => ({ getDeviceId: () => 'synthetic-device' }));
vi.mock('../hooks/useBootController.jsx', () => ({ useBootController: () => ({ bootState: bootState.current }) }));
vi.mock('../contexts/InstanceContext', () => ({
  useInstanceContext: () => ({ mergedGuilds: [], refreshGuilds: vi.fn(async () => {}) }),
}));
vi.mock('@/components/auth/pin-unlock-panel', () => ({ PinUnlockPanel: () => <div>pin unlock</div> }));
vi.mock('@/components/auth/pin-setup-panel', () => ({ PinSetupPanel: () => <div>pin setup</div> }));
vi.mock('../lib/ritualsSpace', async (importOriginal) => ({
  ...(await importOriginal()),
  readSpaceTicket: () => TICKET,
  readSpaceTicketHints: () => ({ name: 'Synthetic task', dn: 'Synthetic' }),
  subscribeSpaceTicket: () => () => {},
}));

import SpacePage from './SpacePage.jsx';

describe('SpacePage with no identity on this device', () => {
  let fetchSpy;

  beforeEach(() => {
    bootState.current = 'needs_login';
    mockProvision.mockReset();
    mockProvision.mockReturnValue(new Promise(() => {}));
    authState.current = {
      user: null,
      token: null,
      hasVault: false,
      provisionRitualsSpaceIdentity: mockProvision,
      reauthenticateNow: vi.fn(async () => false),
    };
    // The old peek would have said this account is seated on another device.
    fetchSpy = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ claimed: true, selfSeated: true, othersSeated: false }),
    }));
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('opens the space straight away: no offer, no peek, provisioning starts', async () => {
    render(
      <MemoryRouter initialEntries={['/space']}>
        <SpacePage />
      </MemoryRouter>,
    );
    await waitFor(() => expect(mockProvision).toHaveBeenCalledTimes(1));
    expect(mockProvision.mock.calls[0][0]).toMatchObject({ ticket: TICKET });
    expect(screen.getByText('Opening the space')).toBeTruthy();
    expect(screen.queryByText(/already in this space/i)).toBeNull();
    expect(screen.queryByText('Add this device')).toBeNull();
    expect(screen.queryByText('Start fresh here')).toBeNull();
    expect(fetchSpy.mock.calls.some(([url]) => String(url).includes('/spaces/peek'))).toBe(false);
  });
});
