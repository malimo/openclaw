// Guards bind-alignment for managed-native connection URLs: only the ambiguous
// "localhost" name bridges IPv4/IPv6; exact cross-family pairs are different
// sockets whose URLs must survive bind-port reassignment untouched.
import { describe, expect, it } from "vitest";
import type { SignalTransportConfig } from "./account-types.js";
import {
  assignSignalManagedNativePort,
  isSignalManagedNativeConnectionUrlForBind,
} from "./transport-policy.js";

type SignalManagedNativeTransport = Extract<SignalTransportConfig, { kind: "managed-native" }>;

function managedTransport(url: string, httpHost?: string): SignalManagedNativeTransport {
  return {
    kind: "managed-native",
    url,
    ...(httpHost ? { httpHost } : {}),
    httpPort: 8080,
  };
}

describe("assignSignalManagedNativePort", () => {
  it("rewrites a localhost connection URL aligned with a loopback bind", () => {
    const next = assignSignalManagedNativePort(
      managedTransport("http://localhost:8080", "127.0.0.1"),
      9090,
    );
    expect(next.url).toBe("http://localhost:9090");
    expect(next.httpPort).toBe(9090);
  });

  it("keeps a cross-family loopback URL untouched on bind-port changes", () => {
    const next = assignSignalManagedNativePort(
      managedTransport("http://[::1]:8080", "127.0.0.1"),
      9090,
    );
    expect(next.url).toBe("http://[::1]:8080");
    expect(next.httpPort).toBe(9090);
  });
});

describe("isSignalManagedNativeConnectionUrlForBind", () => {
  it.each(["192.0.2.10", "signal-host.local"])(
    "treats %s as owned by an IPv4 wildcard bind when supplied as a local alias",
    (alias) => {
      expect(
        isSignalManagedNativeConnectionUrlForBind(
          managedTransport(`http://${alias}:8080`, "0.0.0.0"),
          { localEndpointAliases: new Set(["192.0.2.10", "signal-host.local"]) },
        ),
      ).toBe(true);
    },
  );

  it("does not claim an unrelated host for a wildcard bind", () => {
    expect(
      isSignalManagedNativeConnectionUrlForBind(
        managedTransport("http://signal-helper:8080", "0.0.0.0"),
        { localEndpointAliases: new Set(["192.0.2.10", "signal-host.local"]) },
      ),
    ).toBe(false);
  });
});
