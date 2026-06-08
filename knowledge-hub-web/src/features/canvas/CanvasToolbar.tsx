/**
 * CanvasToolbar.tsx
 * Top toolbar for the canvas editor.
 */
import React from 'react';
import { ZoomIn, ZoomOut, FitToScreen, TextCreation, Add, ArrowLeft } from '@carbon/icons-react';
import type { EdgeType } from './canvasTypes';

const EDGE_TYPES: { value: EdgeType; label: string }[] = [
  { value: 'relates-to',  label: 'Relates to' },
  { value: 'supports',    label: 'Supports' },
  { value: 'contradicts', label: 'Contradicts' },
  { value: 'leads-to',    label: 'Leads to' },
  { value: 'part-of',     label: 'Part of' },
];

interface Props {
  title: string;
  zoom: number;
  defaultEdgeType: EdgeType;
  onZoomIn:          () => void;
  onZoomOut:         () => void;
  onFit:             () => void;
  onAddText:         () => void;
  onEdgeTypeChange:  (t: EdgeType) => void;
  onTitleChange:     (t: string) => void;
  onTitleBlur:       () => void;
  onToggleSidebar:   () => void;
  sidebarOpen:       boolean;
  onBack?:           () => void;
}

export const CanvasToolbar: React.FC<Props> = ({
  title, zoom, defaultEdgeType,
  onZoomIn, onZoomOut, onFit, onAddText,
  onEdgeTypeChange, onTitleChange, onTitleBlur,
  onToggleSidebar, sidebarOpen, onBack,
}) => {
  return (
  <div className="cv-toolbar">
    {/* Back */}
    {onBack !== undefined && (
      <button className="cv-toolbar__btn" onClick={onBack} title="Back to canvases">
        <ArrowLeft size={16} />
      </button>
    )}

    <div className="cv-toolbar__sep" />

    {/* Title */}
    <input
      className="cv-toolbar__title"
      value={title}
      onChange={(e) => { onTitleChange(e.target.value); }}
      onBlur={onTitleBlur}
      aria-label="Canvas title"
    />

    <div className="cv-toolbar__sep" />

    {/* Zoom controls */}
    <button className="cv-toolbar__btn" onClick={onZoomOut} title="Zoom out">
      <ZoomOut size={16} />
    </button>
    <span className="cv-toolbar__zoom">{Math.round(zoom * 100)}%</span>
    <button className="cv-toolbar__btn" onClick={onZoomIn} title="Zoom in">
      <ZoomIn size={16} />
    </button>
    <button className="cv-toolbar__btn" onClick={onFit} title="Fit all nodes (Cmd+Shift+H)">
      <FitToScreen size={16} />
    </button>

    <div className="cv-toolbar__sep" />

    {/* Add text node */}
    <button className="cv-toolbar__btn cv-toolbar__btn--accent" onClick={onAddText} title="Add text node (double-click canvas)">
      <TextCreation size={16} /> <span>Add text</span>
    </button>

    {/* Default edge type */}
    <select
      className="cv-toolbar__select"
      value={defaultEdgeType}
      onChange={(e) => { onEdgeTypeChange(e.target.value as EdgeType); }}
      title="Default edge type for new connections"
    >
      {EDGE_TYPES.map((t) => (
        <option key={t.value} value={t.value}>{t.label}</option>
      ))}
    </select>

    <div className="cv-toolbar__spacer" />

    {/* Hub item sidebar toggle */}
    <button
      className={`cv-toolbar__btn${sidebarOpen ? ' cv-toolbar__btn--active' : ''}`}
      onClick={onToggleSidebar}
      title="Toggle hub items panel"
    >
      <Add size={16} /> <span>Hub items</span>
    </button>
  </div>
  );
};
