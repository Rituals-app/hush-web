import { Component } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

// Rituals fork (2026-11-06): src/components/ChunkErrorBoundary.jsx.
const recovery = vi.hoisted(() => ({ offerNewerBuild: vi.fn(async () => true) }));
vi.mock('@/lib/chunkRecovery', () => recovery);

import ChunkErrorBoundary from './ChunkErrorBoundary';

function Throws({ error }) {
  throw error;
}

class Outer extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  render() {
    return this.state.error ? <p data-testid="outer">{this.state.error.message}</p> : this.props.children;
  }
}

beforeEach(() => {
  // React logs every caught render error.
  vi.spyOn(console, 'error').mockImplementation(() => {});
  recovery.offerNewerBuild.mockClear();
});

afterEach(() => {
  // globals: false, so Testing Library does not clean up by itself.
  cleanup();
  vi.restoreAllMocks();
});

describe('ChunkErrorBoundary', () => {
  it('renders its children', () => {
    render(<ChunkErrorBoundary><p>Space</p></ChunkErrorBoundary>);

    expect(screen.getByText('Space')).toBeInTheDocument();
    expect(screen.queryByTestId('chunk-error-fallback')).toBeNull();
  });

  it('shows a retry and offers a newer build when a screen failed to load', () => {
    const failed = new TypeError('Failed to fetch dynamically imported module: https://space.example.test/assets/Settings-old.js');

    render(<Outer><ChunkErrorBoundary><Throws error={failed} /></ChunkErrorBoundary></Outer>);

    expect(screen.getByTestId('chunk-error-fallback')).toBeInTheDocument();
    expect(screen.getByText('This space could not load. Check your connection, then try again.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    expect(screen.queryByTestId('outer')).toBeNull();
    expect(recovery.offerNewerBuild).toHaveBeenCalledOnce();
  });

  it('reloads when Try again is pressed', () => {
    const reload = vi.fn();
    vi.stubGlobal('location', { ...window.location, reload });
    try {
      render(<ChunkErrorBoundary><Throws error={new Error('Importing a module script failed.')} /></ChunkErrorBoundary>);
      screen.getByRole('button', { name: 'Try again' }).click();

      expect(reload).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('passes any other error on to the next boundary up, without an offer', () => {
    render(<Outer><ChunkErrorBoundary><Throws error={new Error('boom')} /></ChunkErrorBoundary></Outer>);

    expect(screen.getByTestId('outer')).toHaveTextContent('boom');
    expect(screen.queryByTestId('chunk-error-fallback')).toBeNull();
    expect(recovery.offerNewerBuild).not.toHaveBeenCalled();
  });
});
