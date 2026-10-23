import { StrictProviderError } from "./strictProviders";

/**
 * Races a provider call against its deadline and the task's cancellation, so an
 * uncooperative provider cannot hold a phase past its remaining active time.
 */
export async function withDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  outer: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  const onAbort = (): void => controller.abort();
  if (outer.aborted) controller.abort();
  else outer.addEventListener("abort", onAbort, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  if (typeof timer.unref === "function") timer.unref();
  try {
    return await Promise.race([operation(controller.signal), rejectOnAbort(controller.signal)]);
  } catch (error) {
    if (outer.aborted) throw new StrictProviderError("cancelled", "The task was cancelled.");
    if (timedOut) throw new StrictProviderError("timed_out", `A provider request exceeded ${Math.round(timeoutMs / 1_000)} seconds.`);
    throw error;
  } finally {
    clearTimeout(timer);
    outer.removeEventListener("abort", onAbort);
  }
}

function rejectOnAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    const abort = (): void => reject(new StrictProviderError("cancelled", "The request was aborted."));
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}
