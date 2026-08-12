import { describe, expect, it, vi } from "vitest";
import { runGatewayLifecycleSteps, startGatewayLifecycleSteps } from "./server-lifecycle-steps.js";

describe("Gateway lifecycle steps", () => {
  it("owns every started cleanup before joining their settlements", async () => {
    let releaseFirst: (() => void) | undefined;
    const firstSettlement = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const asyncError = new Error("async cleanup failed");
    const syncError = new Error("sync cleanup failed");
    const starts = vi.fn<(name: string) => void>();

    const started = startGatewayLifecycleSteps([
      () => {
        starts("first");
        return firstSettlement;
      },
      () => {
        starts("second");
        return Promise.reject(asyncError);
      },
      () => {
        starts("third");
        throw syncError;
      },
      () => {
        starts("fourth");
      },
    ]);

    expect(starts.mock.calls).toEqual([["first"], ["second"], ["third"], ["fourth"]]);
    // Keep the first owner paused across an event-loop turn. The later rejection
    // must already be owned even though ordered joining has not reached it.
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    releaseFirst?.();

    const failure = await runGatewayLifecycleSteps(started).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([asyncError, syncError]);
  });
});
