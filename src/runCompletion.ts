type WaitResult = { status?: string };
type Outcome = 'success' | 'failed' | 'unknown';
type Run = {
  id: string;
  waiting: boolean;
  unavailable: boolean;
  cancelled?: boolean;
  terminal?: Outcome;
  timer?: ReturnType<typeof setTimeout>;
};
type Session = {
  runs: Map<string, Run>;
  sends: Set<symbol>;
  succeeded: boolean;
  failed: boolean;
};

// A message boundary is only a hint. Confirm the exact run before notifying.
export class RunCompletionTracker {
  private sessions = new Map<string, Session>();
  private retired = new Set<string>();

  constructor(
    private wait: (runId: string) => Promise<WaitResult | undefined>,
    private busy: (sessionKey: string, busy: boolean) => void,
    private complete: (sessionKey: string) => void
  ) {}

  private session(key: string) {
    let session = this.sessions.get(key);
    if (!session) {
      session = { runs: new Map(), sends: new Set(), succeeded: false, failed: false };
      this.sessions.set(key, session);
    }
    return session;
  }

  beginSend(key: string) {
    const token = Symbol();
    this.session(key).sends.add(token);
    this.busy(key, true);
    return token;
  }

  acknowledge(key: string, token: symbol, runId?: string) {
    const session = this.sessions.get(key);
    if (!session?.sends.delete(token)) return;
    if (runId) this.start(key, runId);
    // Older Gateways may omit the ID. Keep their existing inactivity fallback.
    if (runId) this.flush(key, session);
  }

  failSend(key: string, token: symbol) {
    const session = this.sessions.get(key);
    if (!session?.sends.delete(token)) return;
    session.failed = true;
    this.flush(key, session);
  }

  runId(key: string) {
    return [...(this.sessions.get(key)?.runs.keys() || [])].at(-1);
  }

  hasConfirmedTracking(key: string) {
    const session = this.sessions.get(key);
    return Boolean(session && [...session.runs.values()].some((run) => !run.unavailable));
  }

  abort(key: string, id?: string) {
    const session = this.sessions.get(key);
    if (!session) return;
    if (!id) session.failed = true;
    const run = id ? session.runs.get(id) : undefined;
    if (run) run.cancelled = true;
  }

  private start(key: string, id: string) {
    if (this.retired.has(`${key}\0${id}`)) return;
    const session = this.session(key);
    if (session.runs.has(id)) {
      this.busy(key, true);
      return;
    }
    const run: Run = { id, waiting: false, unavailable: false };
    session.runs.set(id, run);
    this.busy(key, true);
    this.confirm(key, session, run);
  }

  event(key: string, name: string, payload: Record<string, any>) {
    const id = typeof payload.runId === 'string' ? payload.runId : '';
    if (!id) return false;
    if (this.retired.has(`${key}\0${id}`)) return true;
    const lifecycle = name === 'agent' && (payload.stream || payload.type) === 'lifecycle';
    const phase = lifecycle ? payload.phase || payload.data?.phase : undefined;
    const failed = Boolean(
      payload.error ||
      payload.aborted ||
      payload.data?.aborted ||
      payload.state === 'error' ||
      payload.state === 'aborted' ||
      phase === 'error'
    );
    const terminal =
      failed ||
      (name === 'chat' &&
        (payload.final || payload.state === 'final' || payload.state === 'completed')) ||
      phase === 'end';

    if (!terminal) {
      this.start(key, id);
      return true;
    }
    const session = this.sessions.get(key);
    const run = session?.runs.get(id);
    // Unknown/older terminal events must never take ownership of a newer run.
    if (!session || !run) return true;
    run.cancelled ||=
      payload.state === 'aborted' || Boolean(payload.aborted || payload.data?.aborted);
    run.terminal = failed ? 'failed' : lifecycle ? 'success' : 'unknown';
    if (run.unavailable) this.finish(key, session, run, run.cancelled ? 'failed' : run.terminal);
    return true;
  }

  private confirm(key: string, session: Session, run: Run) {
    if (run.waiting) return;
    run.waiting = true;
    const current = () => this.sessions.get(key) === session && session.runs.get(run.id) === run;
    const unavailable = () => {
      if (!current()) return;
      run.unavailable = true;
      if (run.terminal) this.finish(key, session, run, run.cancelled ? 'failed' : run.terminal);
    };
    const retry = () => {
      if (!current()) return;
      run.timer = setTimeout(() => {
        run.timer = undefined;
        this.confirm(key, session, run);
      }, 1000);
    };
    Promise.resolve()
      .then(() => this.wait(run.id))
      .then((result) => {
        if (!current()) return;
        run.waiting = false;
        if (result?.status === 'ok') {
          this.finish(
            key,
            session,
            run,
            run.cancelled || run.terminal === 'failed' ? 'failed' : 'success'
          );
        } else if (result?.status === 'error') {
          this.finish(key, session, run, 'failed');
        } else if (result?.status === 'timeout' || result?.status === 'pending') {
          retry();
        } else {
          unavailable();
        }
      })
      .catch((error) => {
        if (!current()) return;
        run.waiting = false;
        if (
          /unknown method|method not found|not supported|forbidden|scope|permission|not found/i.test(
            String(error)
          )
        ) {
          unavailable();
        } else {
          retry();
        }
      });
  }

  private finish(key: string, session: Session, run: Run, outcome: Outcome) {
    if (run.timer) clearTimeout(run.timer);
    session.runs.delete(run.id);
    this.retire(key, run.id);
    session.succeeded ||= outcome === 'success';
    session.failed ||= outcome !== 'success';
    this.flush(key, session);
  }

  private flush(key: string, session: Session) {
    if (session.runs.size || session.sends.size) return;
    this.sessions.delete(key);
    this.busy(key, false);
    if (session.succeeded && !session.failed) this.complete(key);
  }

  private retire(key: string, id: string) {
    this.retired.add(`${key}\0${id}`);
    if (this.retired.size > 256) this.retired.delete(this.retired.values().next().value!);
  }

  cancel(key: string) {
    const session = this.sessions.get(key);
    if (session) {
      for (const run of session.runs.values()) {
        if (run.timer) clearTimeout(run.timer);
        this.retire(key, run.id);
      }
      this.sessions.delete(key);
    }
    this.busy(key, false);
  }

  clear() {
    for (const key of this.sessions.keys()) this.cancel(key);
    this.retired.clear();
  }
}
