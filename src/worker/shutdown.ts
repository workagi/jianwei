import { type StructuredLogger } from "@/lib/structured-log";

export interface ShutdownHandle {
  /** Resolves when a SIGTERM/SIGINT has been received. */
  signal: AbortSignal;
  /** True after the shutdown signal has been received. */
  readonly isShuttingDown: boolean;
}

/**
 * Create a shutdown handle that listens for SIGTERM and SIGINT. The returned
 * signal is aborted on either event. This is a single-use handle — calling
 * setup more than once per process is harmless (the second AbortController
 * will fire immediately) but wasteful.
 */
export function setupShutdown(log: StructuredLogger): ShutdownHandle {
  const controller = new AbortController();
  let shuttingDown = false;

  const stop = () => {
    shuttingDown = true;
    if (!controller.signal.aborted) {
      controller.abort(new Error("WORKER_SHUTDOWN"));
    }
  };

  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  log.info("worker.shutdown.listeners_registered");

  return {
    signal: controller.signal,
    get isShuttingDown() {
      return shuttingDown;
    },
  };
}
