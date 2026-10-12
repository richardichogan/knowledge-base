import React, { Component, Suspense, lazy, useState } from 'react';
import { DataNotice } from '../components/DataNotice';

class ViewBoundary extends Component<{
  name: string; onRetry: () => void; children: React.ReactNode;
}, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } { return { failed: true }; }

  componentDidCatch(error: Error): void {
    console.error(`[View] ${this.props.name} could not render.`, error);
  }

  render(): React.ReactNode {
    if (!this.state.failed) return this.props.children;
    return <div className="kh-view-status" role="alert">
      <DataNotice title={`${this.props.name} could not open`}
        error={new Error('Retry this view without reloading Athena. Other open work is left in place.')}
        onRetry={this.props.onRetry} />
    </div>;
  }
}

export function deferredView<P extends object>(
  name: string, load: () => Promise<{ default: React.ComponentType<P> }>,
): React.FC<P> {
  const createView = (): React.LazyExoticComponent<React.FC<{ viewProps: P }>> => lazy(async () => {
    const loaded = await load();
    return { default: ({ viewProps }: { viewProps: P }) => React.createElement(loaded.default, viewProps) };
  });
  return function DeferredView(props: P): React.ReactElement {
    const [attempt, setAttempt] = useState(0);
    const [View, setView] = useState(createView);
    return <ViewBoundary key={attempt} name={name} onRetry={() => {
      setView(() => createView());
      setAttempt(value => value + 1);
    }}>
      <Suspense fallback={<div className="kh-view-status" role="status" aria-live="polite">Opening {name}…</div>}>
        <View viewProps={props} />
      </Suspense>
    </ViewBoundary>;
  };
}
