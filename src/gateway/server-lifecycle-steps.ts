type GatewayLifecycleStep = () => unknown;
type GatewayLifecycleOutcome =
  | { ok: true }
  | {
      ok: false;
      error: unknown;
    };

/** Start cleanup owners together and immediately own every async rejection. */
export function startGatewayLifecycleSteps(
  steps: Iterable<GatewayLifecycleStep>,
): GatewayLifecycleStep[] {
  return Array.from(steps, (step) => {
    let settlement: Promise<GatewayLifecycleOutcome>;
    try {
      settlement = Promise.resolve(step()).then(
        () => ({ ok: true }),
        (error: unknown) => ({ ok: false, error }),
      );
    } catch (error) {
      settlement = Promise.resolve({ ok: false, error });
    }
    return async () => {
      const outcome = await settlement;
      if (!outcome.ok) {
        throw outcome.error;
      }
    };
  });
}

/** Run ordered lifecycle cleanup without letting one failure skip later owners. */
export async function runGatewayLifecycleSteps(
  steps: Iterable<GatewayLifecycleStep>,
  initialFailures: Iterable<unknown> = [],
): Promise<void> {
  const failures = [...new Set(initialFailures)];
  for (const step of steps) {
    try {
      await step();
    } catch (error) {
      if (!failures.includes(error)) {
        failures.push(error);
      }
    }
  }
  if (failures.length === 1) {
    throw failures[0];
  }
  if (failures.length > 1) {
    throw new AggregateError(failures, `${failures.length} Gateway lifecycle cleanup steps failed`);
  }
}
