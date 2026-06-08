/**
 * graph/graphShapes.ts
 * Canvas shape drawers for graph nodes.
 * Four shapes: circle, square, diamond, triangle.
 * Shape encodes content type within a colour family.
 */

export type NodeShape = 'circle' | 'square' | 'diamond' | 'triangle';

/** Maps each ref_type to its canvas shape. */
export const TYPE_TO_SHAPE: Record<string, NodeShape> = {
  discover_item:   'circle',
  cfp_item:        'triangle',
  note:            'circle',
  spark:           'diamond',
  commit:          'square',
  pull_request:    'square',
  blog_post:       'circle',
  podcast_episode: 'diamond',
  document:        'circle',
  canvas:          'circle',
  task:            'circle',
};

/**
 * Draws a filled circle centred at (x, y) with radius r.
 * Caller must set fillStyle and globalAlpha before calling.
 */
export function drawCircle(ctx: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, 2 * Math.PI);
  ctx.fill();
}

/**
 * Draws a filled axis-aligned square centred at (x, y).
 * Side length = r * 1.8 so visual area matches the circle at the same r.
 */
export function drawSquare(ctx: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  const s = r * 1.8;
  ctx.beginPath();
  ctx.rect(x - s / 2, y - s / 2, s, s);
  ctx.fill();
}

/**
 * Draws a filled diamond (rotated square) centred at (x, y).
 * Half-diagonal = r * 1.3.
 */
export function drawDiamond(ctx: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  const d = r * 1.3;
  ctx.beginPath();
  ctx.moveTo(x,     y - d);
  ctx.lineTo(x + d, y);
  ctx.lineTo(x,     y + d);
  ctx.lineTo(x - d, y);
  ctx.closePath();
  ctx.fill();
}

/**
 * Draws a filled upward-pointing equilateral triangle centred at (x, y).
 * Circumradius = r * 1.3.
 */
export function drawTriangle(ctx: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  const cr = r * 1.3;
  ctx.beginPath();
  ctx.moveTo(x,                       y - cr);
  ctx.lineTo(x + cr * Math.sin(2.094), y + cr * 0.5);
  ctx.lineTo(x - cr * Math.sin(2.094), y + cr * 0.5);
  ctx.closePath();
  ctx.fill();
}

/**
 * Dispatches to the correct shape drawer based on shape name.
 */
export function drawShape(
  ctx: CanvasRenderingContext2D,
  shape: NodeShape,
  x: number, y: number, r: number,
): void {
  switch (shape) {
    case 'circle':   drawCircle(ctx, x, y, r);   break;
    case 'square':   drawSquare(ctx, x, y, r);   break;
    case 'diamond':  drawDiamond(ctx, x, y, r);  break;
    case 'triangle': drawTriangle(ctx, x, y, r); break;
  }
}

/**
 * Draws the selection / hover ring as a circle regardless of node shape.
 * (A circle ring around any shape is visually cleaner than a shape outline.)
 */
export function drawRing(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, r: number,
  strokeStyle: string, lineWidth: number,
): void {
  ctx.beginPath();
  ctx.arc(x, y, r + 3, 0, 2 * Math.PI);
  ctx.strokeStyle = strokeStyle;
  ctx.lineWidth = lineWidth;
  ctx.stroke();
}
