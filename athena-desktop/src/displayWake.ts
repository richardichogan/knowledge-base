import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const WAKE_DISPLAY = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class AthenaDisplay {
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern uint SetThreadExecutionState(uint flags);
}
'@
if ([AthenaDisplay]::SetThreadExecutionState(3) -eq 0) { throw 'Windows did not accept the display wake request.' }
`;

/** Wakes Windows display sleep; it cannot power a physically switched-off or unplugged monitor. */
export async function wakePresentationDisplay(): Promise<void> {
  if (process.platform !== 'win32') return;
  await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WAKE_DISPLAY],
    { windowsHide: true, timeout: 10000 });
}
