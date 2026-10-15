import React, { Component, Suspense, lazy, useState } from 'react';
import { DataNotice } from '../components/DataNotice';

class ViewBoundary extends Component<{
  name: string; onRetry: () => void; children: React.ReactNode;
}, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: unknown): { error: Error } {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  componentDidCatch(error: Error): void {
    console.error(`[View] ${this.props.name} could not render.`, error);
  }

  render(): React.ReactNode {
    if (!this.state.error) return this.props.children;
    return <div className="kh-view-status" role="alert">
      <DataNotice title={`${this.props.name} could not open`}
        error={new Error(`${this.state.error.message} Retry this view without reloading Athena. Other open work is left in place.`)}
        onRetry={this.props.onRetry} />
    </div>;
  }
}

const RELOADED_FOR_KEY = 'kh-reloaded-for-build';

function runningEntry(doc: Document = document): string | null {
  const script = doc.querySelector<HTMLScriptElement>('script[type="module"][src]');
  return script === null ? null : new URL(script.getAttribute('src') ?? '', window.location.origin).pathname;
}

// Each frontend deploy removes the previous build's hashed chunks, so a tab opened
// before a deploy cannot fetch views it has not loaded yet. Reload onto the new build.
export function newerBuildEntry(current: Document, deployedHtml: string): string | null {
  const running = runningEntry(current);
  const deployed = runningEntry(new DOMParser().parseFromString(deployedHtml, 'text/html'));
  return running === null || deployed === null || deployed === running ? null : deployed;
}

export async function reloadIfNewBuildDeployed(): Promise<boolean> {
  const response = await fetch(window.location.pathname, { cache: 'no-store' });
  if (!response.ok) return false;
  const deployed = newerBuildEntry(document, await response.text());
  if (deployed === null) return false;
  if (sessionStorage.getItem(RELOADED_FOR_KEY) === deployed) return false;
  sessionStorage.setItem(RELOADED_FOR_KEY, deployed);
  window.location.reload();
  return true;
}

export function deferredView<P extends object>(
  name: string, load: () => Promise<{ default: React.ComponentType<P> }>,
): React.FC<P> {
  const createView = (): React.LazyExoticComponent<React.FC<{ viewProps: P }>> => lazy(async () => {
    let loaded: { default: React.ComponentType<P> };
    try {
      loaded = await load();
    } catch (error) {
      if (await reloadIfNewBuildDeployed().catch(() => false)) await new Promise<never>(() => undefined);
      throw error;
    }
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
