import { createServer } from "node:net";

function readSignalBindErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) {
    return undefined;
  }
  return typeof error.code === "string" ? error.code : undefined;
}

function formatSignalBindError(params: {
  error: unknown;
  httpHost: string;
  httpPort: number;
}): string {
  const endpoint = `${params.httpHost}:${String(params.httpPort)}`;
  const code = readSignalBindErrorCode(params.error);
  if (code === "EADDRINUSE") {
    return `Signal cannot validate ${endpoint} because that address is already in use. Stop the process using it, then retry setup.`;
  }
  if (code === "EACCES" || code === "EPERM") {
    return `Signal cannot validate ${endpoint} because permission was denied (${code}). Choose an address and port this user can bind, then retry setup.`;
  }
  if (code === "EADDRNOTAVAIL") {
    return `Signal cannot validate ${endpoint} because that address is not available on this machine (${code}). Choose a local interface address, then retry setup.`;
  }
  const detail = params.error instanceof Error ? params.error.message : String(params.error);
  return `Signal cannot validate ${endpoint}${code ? ` (${code})` : ""}: ${detail}. Check the bind host and port, then retry setup.`;
}

export async function assertSignalSetupDaemonBindAvailable(params: {
  httpHost: string;
  httpPort: number;
}): Promise<void> {
  const server = createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen({ host: params.httpHost, port: params.httpPort, exclusive: true }, resolve);
    });
  } catch (error) {
    throw new Error(formatSignalBindError({ ...params, error }), { cause: error });
  } finally {
    if (server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  }
}
