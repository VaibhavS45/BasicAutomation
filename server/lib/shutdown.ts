// server/lib/shutdown.ts  Owner: Vaibhav (Phase V-7)
// Graceful-shutdown registry: pollers and timers register stop callbacks;
// SIGTERM/SIGINT (or Nitro close) runs them LIFO with a per-callback
// timeout. Errors never block the remaining callbacks. Pure enough to test
// without a server: register fns, call shutdown(), assert order + tolerance.
export type ShutdownFn = () => void | Promise<void>;

const stack: Array<{ name: string; fn: ShutdownFn }> = [];
let shuttingDown = false;

export function onShutdown(name: string, fn: ShutdownFn): void {
  stack.push({ name, fn });
}

export interface ShutdownResult {
  stopped: string[];
  errors: Array<{ name: string; error: string }>;
}

export async function shutdown(timeoutMs = 5000, reason = "shutdown"): Promise<ShutdownResult> {
  if (shuttingDown) return { stopped: [], errors: [] };
  shuttingDown = true;
  const result: ShutdownResult = { stopped: [], errors: [] };
  console.log(`[shutdown] ${reason}: stopping ${stack.length} task(s)`);
  while (stack.length > 0) {
    const task = stack.pop();
    if (!task) break;
    try {
      await Promise.race([
        Promise.resolve().then(() => task.fn()),
        new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), timeoutMs)),
      ]);
      result.stopped.push(task.name);
    } catch (err) {
      result.errors.push({ name: task.name, error: err instanceof Error ? err.message : String(err) });
    }
  }
  console.log(`[shutdown] done: ${result.stopped.length} stopped, ${result.errors.length} error(s)`);
  return result;
}

/** Test hook: clear the registry and the shutting-down latch. */
export function resetShutdownForTests(): void {
  stack.length = 0;
  shuttingDown = false;
}
