export type SessionTurnSource =
  | "message"
  | "queued-message"
  | "cooldown"
  | "dynamic-delay"
  | "poke"
  | "chat-runtime";

interface SessionTurnEntry<T> {
  source: SessionTurnSource;
  dedupeKey?: string;
  run: () => Promise<T>;
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

interface SessionTurnState {
  running: boolean;
  pending: SessionTurnEntry<unknown>[];
}

export class SessionTurnSchedulerDisposedError extends Error {
  constructor() {
    super("Session turn scheduler has been disposed");
    this.name = "SessionTurnSchedulerDisposedError";
  }
}

export class SessionTurnScheduler {
  private readonly sessions = new Map<string, SessionTurnState>();
  private disposed = false;

  run<T>(
    sessionId: string,
    source: SessionTurnSource,
    task: () => Promise<T>,
    options: { dedupeKey?: string } = {},
  ): Promise<T> {
    if (this.disposed) {
      return Promise.reject(new SessionTurnSchedulerDisposedError());
    }

    const state = this.getOrCreateState(sessionId);
    if (options.dedupeKey) {
      const existing = state.pending.find(
        (entry) => entry.dedupeKey === options.dedupeKey,
      );
      if (existing) return existing.promise as Promise<T>;
    }

    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    const entry: SessionTurnEntry<T> = {
      source,
      dedupeKey: options.dedupeKey,
      run: task,
      promise,
      resolve,
      reject,
    };

    state.pending.push(entry as SessionTurnEntry<unknown>);
    if (!state.running) void this.drain(sessionId, state);
    return promise;
  }

  isBusy(sessionId: string): boolean {
    const state = this.sessions.get(sessionId);
    return Boolean(state?.running || state?.pending.length);
  }

  pendingCount(sessionId: string): number {
    return this.sessions.get(sessionId)?.pending.length ?? 0;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const error = new SessionTurnSchedulerDisposedError();

    for (const [sessionId, state] of this.sessions) {
      for (const entry of state.pending.splice(0)) entry.reject(error);
      if (!state.running) this.sessions.delete(sessionId);
    }
  }

  private getOrCreateState(sessionId: string): SessionTurnState {
    let state = this.sessions.get(sessionId);
    if (!state) {
      state = { running: false, pending: [] };
      this.sessions.set(sessionId, state);
    }
    return state;
  }

  private async drain(
    sessionId: string,
    state: SessionTurnState,
  ): Promise<void> {
    if (state.running || this.disposed) return;
    state.running = true;

    try {
      while (!this.disposed) {
        const entry = state.pending.shift();
        if (!entry) break;
        try {
          entry.resolve(await entry.run());
        } catch (err) {
          entry.reject(err);
        }
      }
    } finally {
      state.running = false;
      if (state.pending.length === 0) {
        this.sessions.delete(sessionId);
      } else if (!this.disposed) {
        void this.drain(sessionId, state);
      }
    }
  }
}
