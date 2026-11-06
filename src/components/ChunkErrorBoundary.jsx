import { Component } from 'react';
import { Button } from '@/components/ui/button';
import { isChunkLoadError } from '@/lib/chunkErrors';
import { offerNewerBuild } from '@/lib/chunkRecovery';

/**
 * Rituals fork (2026-11-06): a screen whose files did not load (React.lazy
 * rejects with the failed import) shows a retry here instead of unmounting
 * the whole app, so the Update dialog mounted beside it can still offer a
 * newer build (src/lib/chunkRecovery.ts). Any other error is passed on
 * unchanged to the next boundary up.
 */
export class ChunkErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error) {
    if (isChunkLoadError(error)) void offerNewerBuild();
  }

  render() {
    const { error } = this.state;
    if (error === null) return this.props.children;
    if (!isChunkLoadError(error)) throw error;
    return (
      <div
        className="flex h-full flex-col items-center justify-center gap-4 bg-background p-6 text-center"
        data-testid="chunk-error-fallback"
      >
        <p className="max-w-sm text-sm text-muted-foreground">
          This space could not load. Check your connection, then try again.
        </p>
        <Button type="button" variant="outline" onClick={() => window.location.reload()}>
          Try again
        </Button>
      </div>
    );
  }
}

export default ChunkErrorBoundary;
