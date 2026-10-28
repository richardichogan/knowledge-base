/** Both canvas editors pan with middle drag or Space plus left drag. */
export function isCanvasPanGesture(button: number, spaceDown: boolean): boolean {
  return button === 1 || (button === 0 && spaceDown);
}
