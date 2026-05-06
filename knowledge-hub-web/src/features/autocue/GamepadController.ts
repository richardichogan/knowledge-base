/**
 * features/autocue/GamepadController.ts
 * Wraps the Web Gamepad API. Polls button state on each animation frame.
 *
 * Standard Xbox controller button mapping:
 *   0 = A  (start/resume)
 *   1 = B  (pause)
 *   2 = X  (stop + reset)
 *   4 = LB (speed down)
 *   5 = RB (speed up)
 *   9 = Start (back to selector)
 */

export interface GamepadControllerOptions {
  onStart: () => void;
  onPause: () => void;
  onStop: () => void;
  onSpeedUp: () => void;
  onSpeedDown: () => void;
  onBack: () => void;
  onGamepadConnected?: () => void;
}

const DEBOUNCE_MS = 150;

const BUTTON_MAP: Record<number, keyof Omit<GamepadControllerOptions, 'onGamepadConnected'>> = {
  0: 'onStart',
  1: 'onPause',
  2: 'onStop',
  4: 'onSpeedDown',
  5: 'onSpeedUp',
  9: 'onBack',
};

export class GamepadController {
  private readonly options: GamepadControllerOptions;
  private rafId: number | null = null;
  private lastPress: Record<number, number> = {};

  public constructor(options: GamepadControllerOptions) {
    this.options = options;
  }

  public connect(): void {
    if (!('getGamepads' in navigator)) {
      console.warn('[GamepadController] Gamepad API not available');
      return;
    }

    window.addEventListener('gamepadconnected', this.onConnected);
    this.startPolling();
  }

  public disconnect(): void {
    window.removeEventListener('gamepadconnected', this.onConnected);
    if (this.rafId !== null) { cancelAnimationFrame(this.rafId); this.rafId = null; }
  }

  private onConnected = (): void => {
    this.options.onGamepadConnected?.();
  };

  private startPolling(): void {
    const poll = (): void => {
      this.pollButtons();
      this.rafId = requestAnimationFrame(poll);
    };
    this.rafId = requestAnimationFrame(poll);
  }

  private pollButtons(): void {
    const gamepads = navigator.getGamepads();
    for (const gp of gamepads) {
      if (gp === null) continue;
      for (const [indexStr, action] of Object.entries(BUTTON_MAP)) {
        const index = parseInt(indexStr, 10);
        const button = gp.buttons[index];
        if (button === undefined) continue;
        if (button.pressed) {
          const now = Date.now();
          const last = this.lastPress[index] ?? 0;
          if (now - last > DEBOUNCE_MS) {
            this.lastPress[index] = now;
            this.options[action]();
          }
        }
      }
    }
  }
}
