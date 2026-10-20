import { execFile } from 'node:child_process';

/** A test run pins what macOS would report (`ACT_TEST_ASSISTIVE_TECH=1|0`), so
 * journeys don't depend on VoiceOver or other accessibility clients on the host.
 * Outside tests the app always asks Chromium. */
export function assistiveTechnologyOverride(testMode: boolean, value: string | undefined): boolean | undefined {
  if (!testMode) return undefined;
  return value === '1' ? true : value === '0' ? false : undefined;
}

export const voiceOverRunning = () => new Promise<boolean>(resolve => { execFile('/usr/bin/pgrep', ['-x', 'VoiceOver'], error => resolve(!error)); });

/** Whether a screen reader needs the terminals' text copy. macOS raises
 * Chromium's accessibility flag for every client of the accessibility API
 * (window managers, launchers, automation), and the copy makes each terminal
 * redraw lay out the whole window, so on macOS only a running VoiceOver counts.
 * The flag still gates the lookup: without any client there is nothing to find. */
export class ScreenReaderWatch {
  private active = false;
  private readonly platform: string;
  private readonly reported: () => boolean;
  private readonly voiceOver: () => Promise<boolean>;
  private readonly changed: (active: boolean) => void;
  constructor(platform: string, reported: () => boolean, voiceOver: () => Promise<boolean>, changed: (active: boolean) => void) {
    this.platform = platform; this.reported = reported; this.voiceOver = voiceOver; this.changed = changed;
  }
  async refresh() {
    const next = this.reported() && (this.platform !== 'darwin' || await this.voiceOver());
    if (next !== this.active) { this.active = next; this.changed(next); }
    return this.active;
  }
}
