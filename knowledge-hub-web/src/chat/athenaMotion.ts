export type AthenaMotionPhase = 'idle' | 'listening' | 'sending' | 'thinking' | 'writing';

export interface AthenaMotionState {
  pending: boolean;
  text: string;
  activity: string;
  recording: boolean;
  transcribing: boolean;
  restoring: boolean;
  typing?: boolean;
  answered?: boolean;
}

export function athenaMotionPhase(state: AthenaMotionState): AthenaMotionPhase {
  if (state.pending) {
    if (state.text !== '' || state.answered) return 'writing';
    return state.activity === 'Sending' ? 'sending' : 'thinking';
  }
  if (state.recording) return 'listening';
  if (state.transcribing || state.restoring) return 'thinking';
  if (state.typing) return 'sending';
  if (state.answered) return 'writing';
  return 'idle';
}

export interface MotionRect { left: number; top: number; right: number; bottom: number }

/** Keep the character at the composer when its reply is outside the visible thread. */
export function replyAnchorVisible(anchor: MotionRect, thread: MotionRect): boolean {
  return anchor.bottom > anchor.top && anchor.right > anchor.left
    && anchor.top >= thread.top && anchor.bottom <= thread.bottom
    && anchor.left >= thread.left && anchor.right <= thread.right;
}

export interface MotionPoint { x: number; y: number }
export interface AthenaAnchors { dock: MotionPoint; row: MotionPoint; think: MotionPoint; mark: MotionPoint }
export interface AthenaPose { row: number; think: number; mark: number; rotation: number }
export interface AthenaPiece {
  x: number;
  y: number;
  size: number;
  radius: number[];
  scale: number;
  rotation: number;
  colorMix: number;
  colorIndex: number;
}

export const ATHENA_ANSWER_MS = 2100;
const IDLE: AthenaPose = { row: 0, think: 0, mark: 0, rotation: 0 };
const lerp = (a: number, b: number, k: number): number => a + (b - a) * k;
const ease = (value: number): number => {
  const t = Math.max(0, Math.min(1, value));
  return t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2;
};
const blend = (from: AthenaPose, to: AthenaPose, t: number): AthenaPose => ({
  row: lerp(from.row, to.row, t), think: lerp(from.think, to.think, t),
  mark: lerp(from.mark, to.mark, t), rotation: lerp(from.rotation, to.rotation, t),
});

/**
 * The four-piece geometry from the supplied athena-v3.jsx, at half its 1080px
 * artboard scale. Real turn events replace the demo's fixed Ask/Think cues.
 */
export function athenaGlyphFrame(pose: AthenaPose, seconds: number, voice: boolean): AthenaPiece[] {
  const { row: kRow, think: kThink, mark: kMark, rotation } = pose;
  const q = lerp(lerp(lerp(20, 14, kRow), 30, kThink), 12, kMark);
  const pulse = Math.sin(seconds * Math.PI * 2 * 1.4);
  const gap = lerp(lerp(lerp(0, 10, kRow), 14 + 4 * pulse, kThink), 0, kMark);
  const outerRadius = lerp(lerp(lerp(q, q / 2, kRow), 0, kThink), q, kMark);
  const innerRadius = lerp(lerp(0, q / 2, kRow), 0, kThink);
  const rad = rotation * Math.PI / 180;
  return [0, 1, 2, 3].map(i => {
    const col = i % 2, row = i >> 1;
    const gx = (col - 0.5) * (q + gap), gy = (row - 0.5) * (q + gap);
    const rx = (i - 1.5) * (q + gap);
    const ry = voice
      ? -(0.55 + 0.45 * Math.sin(seconds * 11 + i * 2.1)) * Math.abs(Math.sin(seconds * 7 + i * 0.9)) * 30
      : -Math.abs(Math.sin(seconds * 17 + i * 1.3)) * 12;
    const ox = lerp(gx, rx, kRow), oy = lerp(gy, ry, kRow);
    return {
      x: (ox * Math.cos(rad) - oy * Math.sin(rad)) / 2,
      y: (ox * Math.sin(rad) + oy * Math.cos(rad)) / 2,
      size: q / 2,
      radius: [row === 0 && col === 0, row === 0 && col === 1, row === 1 && col === 1, row === 1 && col === 0]
        .map(outer => (outer ? outerRadius : innerRadius) / 2),
      scale: 1 - 0.2 * kThink * (0.5 + 0.5 * Math.sin(seconds * Math.PI * 2 * 1.4 - i * Math.PI / 2)),
      rotation, colorMix: kThink, colorIndex: [0, 1, 3, 2][i]!,
    };
  });
}

export function athenaPosition(pose: AthenaPose, anchors: AthenaAnchors): MotionPoint {
  const coordinate = (axis: 'x' | 'y'): number => lerp(
    lerp(lerp(anchors.dock[axis], anchors.row[axis], pose.row), anchors.think[axis], pose.think),
    anchors.mark[axis], pose.mark,
  );
  return { x: coordinate('x'), y: coordinate('y') };
}

/** Interruptible choreography; answer handoff continues when streaming becomes a saved reply. */
export class AthenaMotion {
  private phase: AthenaMotionPhase = 'idle';
  private from: AthenaPose = IDLE;
  private startedAt = 0;
  private answerAt: number | null = null;

  setPhase(phase: AthenaMotionPhase, now: number, answerAt: number | null = null): void {
    if (phase === 'writing' && answerAt !== null && now - answerAt >= ATHENA_ANSWER_MS) phase = 'idle';
    if (this.phase === phase && this.answerAt === answerAt) return;
    this.from = this.sample(now).pose;
    this.phase = phase;
    this.startedAt = phase === 'writing' && answerAt !== null ? answerAt : now;
    this.answerAt = answerAt;
  }

  sample(now: number, reduced = false): { pose: AthenaPose; active: boolean; voice: boolean } {
    const elapsed = Math.max(0, now - this.startedAt);
    const fullTurn = Math.ceil(this.from.rotation / 360) * 360;
    const home = { ...IDLE, rotation: fullTurn };
    if (reduced) {
      const pose = this.phase === 'thinking' ? { ...home, think: 1 }
        : this.phase === 'sending' || this.phase === 'listening' ? { ...home, row: 1 } : home;
      return { pose, active: false, voice: false };
    }
    if (this.phase === 'writing') {
      const mark = { ...IDLE, mark: 1, rotation: Math.ceil(this.from.rotation / 90) * 90 };
      const pose = elapsed < 1600
        ? blend(this.from, mark, ease(elapsed / 300))
        : blend(mark, { ...IDLE, rotation: mark.rotation + 90 }, ease((elapsed - 1600) / 500));
      return { pose, active: elapsed < ATHENA_ANSWER_MS, voice: false };
    }
    if (this.phase === 'thinking') {
      const turns = elapsed / 1600;
      const rotation = this.from.rotation + 270 * (Math.floor(turns) + ease(turns % 1));
      return {
        pose: { ...blend(this.from, { ...home, think: 1 }, ease(elapsed / 500)), rotation },
        active: true, voice: false,
      };
    }
    const asking = this.phase === 'sending' || this.phase === 'listening';
    return {
      pose: blend(this.from, { ...home, row: asking ? 1 : 0 }, ease(elapsed / (asking ? 250 : 500))),
      active: asking || elapsed < 500, voice: this.phase === 'listening',
    };
  }
}
