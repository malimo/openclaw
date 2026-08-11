import { createServer } from "node:net";
import { describe, expect, it } from "vitest";
import { assertSignalSetupDaemonBindAvailable } from "./setup-daemon-bind.js";

describe("assertSignalSetupDaemonBindAvailable", () => {
  it("preserves an address-in-use bind failure", async () => {
    const owner = createServer();
    await new Promise<void>((resolve, reject) => {
      owner.once("error", reject);
      owner.listen({ host: "127.0.0.1", port: 0, exclusive: true }, resolve);
    });
    const address = owner.address();
    if (!address || typeof address === "string") {
      throw new Error("expected TCP test address");
    }
    try {
      await expect(
        assertSignalSetupDaemonBindAvailable({
          httpHost: "127.0.0.1",
          httpPort: address.port,
        }),
      ).rejects.toThrow("address is already in use");
    } finally {
      await new Promise<void>((resolve, reject) => {
        owner.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("preserves an unavailable-address bind failure", async () => {
    await expect(
      assertSignalSetupDaemonBindAvailable({
        httpHost: "192.0.2.1",
        httpPort: 8080,
      }),
    ).rejects.toThrow("address is not available on this machine (EADDRNOTAVAIL)");
  });
});
