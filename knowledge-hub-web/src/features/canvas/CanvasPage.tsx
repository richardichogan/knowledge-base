/**
 * CanvasPage.tsx
 * Route wrapper — shows CanvasList at /think/canvas,
 * CanvasEditor at /think/canvas/:id.
 */
import React from 'react';
import { Routes, Route, useParams } from 'react-router-dom';
import { CanvasList } from './CanvasList';
import { CanvasEditor } from './CanvasEditor';

class CanvasErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error: Error) { return { error }; }
  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: '2rem', color: '#ff8389', fontFamily: 'IBM Plex Mono, monospace', fontSize: '13px' }}>
          <strong>Canvas error:</strong>
          <pre style={{ whiteSpace: 'pre-wrap', marginTop: '1rem' }}>{this.state.error.message}{'\n'}{this.state.error.stack}</pre>
        </div>
      );
    }
    return this.props.children;
  }
}

const CanvasEditorRoute: React.FC = () => {
  const { canvasId } = useParams<{ canvasId: string }>();
  if (!canvasId) return null;
  return <CanvasEditor canvasId={canvasId} />;
};

export const CanvasPage: React.FC = () => (
  <div className="cv-page">
    <CanvasErrorBoundary>
      <Routes>
        <Route index element={<CanvasList />} />
        <Route path=":canvasId" element={<CanvasEditorRoute />} />
      </Routes>
    </CanvasErrorBoundary>
  </div>
);
