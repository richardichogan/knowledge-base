import React from 'react';
import type { AlignmentGuide, SpacingIndicator } from './diagramAlignment';

export function DrawingGuides({ guides, spacing, view, width, height }: {
  guides: AlignmentGuide[]; spacing: SpacingIndicator[];
  view: { x: number; y: number; zoom: number }; width: number; height: number;
}): React.ReactElement {
  const z = view.zoom;
  return <g className="dg-drawing-guides" aria-hidden="true">
    {guides.map(guide => <line key={`${guide.axis}:${guide.value}`}
      className={`dg-alignment-guide dg-alignment-guide--${guide.kind}`}
      x1={guide.axis === 'x' ? guide.value : -view.x / z} x2={guide.axis === 'x' ? guide.value : (width - view.x) / z}
      y1={guide.axis === 'y' ? guide.value : -view.y / z} y2={guide.axis === 'y' ? guide.value : (height - view.y) / z} />)}
    {spacing.filter(indicator => indicator.gap > 0.5).map((indicator, index) => {
      const { axis, start, end, position } = indicator;
      const horizontal = axis === 'x';
      const x1 = horizontal ? start : position;
      const y1 = horizontal ? position : start;
      const x2 = horizontal ? end : position;
      const y2 = horizontal ? position : end;
      const cap = 4 / z;
      const label = `${indicator.equal ? '= ' : ''}${Math.round(indicator.gap * 10) / 10}`;
      const labelWidth = label.length * 7 + 10;
      return <g key={`${axis}:${index}`} className={`dg-spacing${indicator.equal ? ' dg-spacing--equal' : ''}`}>
        {indicator.startCross !== undefined && <line className="dg-spacing__witness"
          x1={horizontal ? start : indicator.startCross} y1={horizontal ? indicator.startCross : start} x2={x1} y2={y1} />}
        {indicator.endCross !== undefined && <line className="dg-spacing__witness"
          x1={horizontal ? end : indicator.endCross} y1={horizontal ? indicator.endCross : end} x2={x2} y2={y2} />}
        <line x1={x1} y1={y1} x2={x2} y2={y2} />
        <line x1={x1 - (horizontal ? 0 : cap)} x2={x1 + (horizontal ? 0 : cap)}
          y1={y1 - (horizontal ? cap : 0)} y2={y1 + (horizontal ? cap : 0)} />
        <line x1={x2 - (horizontal ? 0 : cap)} x2={x2 + (horizontal ? 0 : cap)}
          y1={y2 - (horizontal ? cap : 0)} y2={y2 + (horizontal ? cap : 0)} />
        <g transform={`translate(${(x1 + x2) / 2} ${(y1 + y2) / 2}) scale(${1 / z})`}>
          <rect x={-labelWidth / 2} y={-9} width={labelWidth} height={18} rx={2} />
          <text textAnchor="middle" dominantBaseline="central">{label}</text>
        </g>
      </g>;
    })}
  </g>;
}
