let running = false;

export function isConnectionCheckInProgress(): boolean { return running; }

export function beginConnectionCheck(): boolean {
  if (running) return false;
  running = true;
  return true;
}

export function endConnectionCheck(): void { running = false; }
