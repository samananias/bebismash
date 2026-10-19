import { Component } from 'react';
import type { ReactNode } from 'react';
/** Optional UI chunk failures must never unmount local files or the download. */
export class LazyBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <p>These details need saved app assets. Connect and reload to load them.</p>
    ) : (
      this.props.children
    );
  }
}
