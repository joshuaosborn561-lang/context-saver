/**
 * In-process job poller: up to N jobs in flight, drain on shutdown.
 */

export interface PollerJob {
  id: string;
}

export interface JobPoller {
  tick: () => Promise<void>;
  drain: () => Promise<void>;
  getInFlight: () => number;
  getStopping: () => boolean;
}

export function createJobPoller<T extends PollerJob>(opts: {
  concurrency: number;
  claim: (limit: number) => Promise<T[]>;
  execute: (job: T) => Promise<void>;
  onError?: (err: unknown, job?: T) => void;
}): JobPoller {
  let inFlight = 0;
  let stopping = false;
  let claiming = false;
  const running = new Set<Promise<void>>();

  const launch = (job: T): void => {
    inFlight += 1;
    const p = opts
      .execute(job)
      .catch((err) => {
        opts.onError?.(err, job);
      })
      .finally(() => {
        inFlight -= 1;
        running.delete(p);
      });
    running.add(p);
  };

  const tick = async (): Promise<void> => {
    if (stopping || claiming) return;
    const free = opts.concurrency - inFlight;
    if (free <= 0) return;
    claiming = true;
    try {
      const jobs = await opts.claim(free);
      for (const job of jobs) {
        // Claimed rows must run even if shutdown started during claim.
        launch(job);
      }
    } catch (err) {
      opts.onError?.(err);
    } finally {
      claiming = false;
    }
  };

  const drain = async (): Promise<void> => {
    stopping = true;
    await Promise.allSettled([...running]);
  };

  return {
    tick,
    drain,
    getInFlight: () => inFlight,
    getStopping: () => stopping,
  };
}
