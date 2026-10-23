export type AthenaMotionPhase = 'idle' | 'typing' | 'listening' | 'sending' | 'thinking' | 'writing';
export type AthenaMarkState = 'resting' | 'listening' | 'thinking' | 'answering';

export interface AthenaMotionState {
  pending: boolean;
  activity: string;
  recording: boolean;
  transcribing: boolean;
  restoring: boolean;
  typing?: boolean;
  answered?: boolean;
}

export function athenaMotionPhase(state: AthenaMotionState): AthenaMotionPhase {
  if (state.pending) return state.answered ? 'writing' : 'thinking';
  if (state.recording) return 'listening';
  if (state.transcribing || state.restoring) return 'thinking';
  if (state.typing) return 'typing';
  if (state.answered) return 'writing';
  return 'idle';
}

export function athenaMarkState(phase: AthenaMotionPhase): AthenaMarkState {
  if (phase === 'typing' || phase === 'listening') return 'listening';
  if (phase === 'thinking' || phase === 'sending') return 'thinking';
  return phase === 'writing' ? 'answering' : 'resting';
}

export function microphoneLevel(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (const sample of samples) sum += sample * sample;
  return Math.min(1, Math.sqrt(sum / samples.length) * 4);
}

export const ATHENA_MIN_THINK_MS = 400;
export const ATHENA_TYPING_IDLE_MS = 1500;
export const ATHENA_ANSWER_MS = 1500;
export const ATHENA_RETURN_AT_MS = 1000;

export interface MotionRect { left: number; top: number; right: number; bottom: number }
export function replyAnchorVisible(anchor: MotionRect, thread: MotionRect): boolean {
  return anchor.bottom > anchor.top && anchor.right > anchor.left
    && anchor.top >= thread.top && anchor.bottom <= thread.bottom
    && anchor.left >= thread.left && anchor.right <= thread.right;
}

export interface MotionPoint { x: number; y: number }
export interface AthenaAnchors { dock: MotionPoint; row: MotionPoint; think: MotionPoint; mark: MotionPoint }
export interface AthenaPose { row: number; think: number; mark: number; rotation: number }
const IDLE: AthenaPose = { row: 0, think: 0, mark: 0, rotation: 0 };
const lerp = (a: number, b: number, k: number): number => a + (b - a) * k;
export function athenaExpressiveEase(progress: number): number {
  const x = Math.max(0, Math.min(1, progress));
  let t = x;
  for (let i = 0; i < 6; i++) {
    const derivative = (3 * 1.3 * t - 3) * t + 1.2;
    if (Math.abs(derivative) < 1e-6) break;
    t -= (((1.3 * t - 1.5) * t + 1.2) * t - x) / derivative;
  }
  t = Math.max(0, Math.min(1, t));
  return ((-1.58 * t + 2.16) * t + 0.42) * t;
}
const blend = (from: AthenaPose, to: AthenaPose, k: number): AthenaPose => ({
  row: 0, think: lerp(from.think, to.think, k), mark: lerp(from.mark, to.mark, k), rotation: 0,
});

export function athenaPosition(pose: AthenaPose, anchors: AthenaAnchors): MotionPoint {
  const coordinate = (axis: 'x' | 'y'): number =>
    lerp(lerp(anchors.dock[axis], anchors.think[axis], pose.think), anchors.mark[axis], pose.mark);
  return { x: coordinate('x'), y: coordinate('y') };
}

/** Placement only; the supplied custom element owns all four-quarter animation maths. */
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
    const thinking = this.phase === 'thinking' || this.phase === 'sending';
    if (reduced) return { pose: thinking ? { ...IDLE, think: 1 } : IDLE, active: false, voice: false };
    if (this.phase === 'writing') {
      const mark = { ...IDLE, mark: 1 };
      return {
        pose: elapsed < ATHENA_RETURN_AT_MS
          ? blend(this.from, mark, athenaExpressiveEase(elapsed / 400))
          : blend(mark, IDLE, athenaExpressiveEase((elapsed - ATHENA_RETURN_AT_MS) / 500)),
        active: elapsed < ATHENA_ANSWER_MS, voice: false,
      };
    }
    return {
      pose: blend(this.from, thinking ? { ...IDLE, think: 1 } : IDLE, athenaExpressiveEase(elapsed / (thinking ? 400 : 500))),
      active: elapsed < (thinking ? 400 : 500), voice: this.phase === 'listening',
    };
  }
}
