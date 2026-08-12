type GatewayLifecycleStep = () => PromiseLike<unknown> | unknown;

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
