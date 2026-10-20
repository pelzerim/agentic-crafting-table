export interface SupervisorNotification { event: string; data: unknown }

/** Views read session output through `sessions.read`; the supervisor's events
 * only say that a watched session has something new, so a reader wakes at
 * once instead of waiting out its poll delay. Events arriving in one turn
 * become one message. */
export class SessionWake {
  private watching = new Map<string, number>();
  private due = new Set<string>();
  private scheduled = false;
  private readonly call: (method: string, input: { sessionId: string }) => Promise<unknown>;
  private readonly send: (sessionIds: string[]) => void;
  private readonly schedule: (run: () => void) => void;
  constructor(call: (method: string, input: { sessionId: string }) => Promise<unknown>, send: (sessionIds: string[]) => void, schedule: (run: () => void) => void = run => setImmediate(run)) {
    this.call = call; this.send = send; this.schedule = schedule;
  }
  async attach(sessionId: string) {
    const count = this.watching.get(sessionId) ?? 0;
    if (!count) await this.call('sessions.attach', { sessionId });
    this.watching.set(sessionId, count + 1);
  }
  async detach(sessionId: string) {
    const count = this.watching.get(sessionId);
    if (!count) return;
    if (count > 1) { this.watching.set(sessionId, count - 1); return; }
    this.watching.delete(sessionId);
    await this.call('sessions.detach', { sessionId });
  }
  /** A fresh supervisor connection has no subscriptions. */
  async reconnected() {
    for (const sessionId of this.watching.keys()) await this.call('sessions.attach', { sessionId });
  }
  notify(notification: SupervisorNotification) {
    if (notification.event !== 'session') return;
    const data = notification.data as { kind?: string; sessionId?: string; session?: { id?: string } } | null;
    const sessionId = data?.kind === 'output' ? data.sessionId : data?.session?.id;
    if (!sessionId || !this.watching.has(sessionId)) return;
    this.due.add(sessionId);
    if (this.scheduled) return;
    this.scheduled = true;
    this.schedule(() => {
      this.scheduled = false;
      const sessionIds = [...this.due]; this.due.clear();
      if (sessionIds.length) this.send(sessionIds);
    });
  }
}
