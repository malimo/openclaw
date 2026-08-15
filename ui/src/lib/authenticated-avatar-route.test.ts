import { afterEach, expect, it, vi } from "vitest";
import { AuthenticatedAvatarRouteLoader } from "./authenticated-avatar-route.ts";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("shares a stable missing route across owners until its retry window expires", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce({ ok: false, status: 404 })
    .mockResolvedValueOnce({ ok: true, blob: async () => new Blob(["avatar"]) });
  vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
  vi.stubGlobal(
    "URL",
    class extends URL {
      static override createObjectURL = vi.fn(() => "blob:retried-avatar");
      static override revokeObjectURL = vi.fn();
    },
  );

  const first = new AuthenticatedAvatarRouteLoader(vi.fn(), { cacheNotFound: true });
  expect(first.resolve("/avatar/main", ["token"])).toBeNull();
  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
  first.reset();

  const second = new AuthenticatedAvatarRouteLoader(vi.fn(), { cacheNotFound: true });
  expect(second.resolve("/avatar/main", ["token"])).toBeNull();
  expect(fetchMock).toHaveBeenCalledOnce();
  second.reset();

  await vi.advanceTimersByTimeAsync(30_000);
  const onUpdate = vi.fn();
  const third = new AuthenticatedAvatarRouteLoader(onUpdate, { cacheNotFound: true });
  expect(third.resolve("/avatar/main", ["token"])).toBeNull();
  await vi.waitFor(() => expect(onUpdate).toHaveBeenCalledOnce());
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(third.resolve("/avatar/main", ["token"])).toBe("blob:retried-avatar");
  third.reset();
});

it("keeps a pending route when its release races with a cached miss", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  let finishRequest: ((response: Response) => void) | undefined;
  const fetchMock = vi.fn(
    () =>
      new Promise<Response>((resolve) => {
        finishRequest = resolve;
      }),
  );
  vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

  const first = new AuthenticatedAvatarRouteLoader(vi.fn(), { cacheNotFound: true });
  expect(first.resolve("/avatar/release-race", ["token"])).toBeNull();
  first.reset();
  await vi.advanceTimersByTimeAsync(0);
  finishRequest?.({ ok: false, status: 404 } as Response);
  await Promise.resolve();
  await Promise.resolve();

  const second = new AuthenticatedAvatarRouteLoader(vi.fn(), { cacheNotFound: true });
  expect(second.resolve("/avatar/release-race", ["token"])).toBeNull();
  expect(fetchMock).toHaveBeenCalledOnce();
  second.reset();
});

it("bounds released missing routes while preserving the newest cooldown", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  const fetchMock = vi.fn(async () => ({ ok: false, status: 404 }) as Response);
  vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
  const loaders = Array.from(
    { length: 129 },
    () => new AuthenticatedAvatarRouteLoader(vi.fn(), { cacheNotFound: true }),
  );

  for (const [index, loader] of loaders.entries()) {
    expect(loader.resolve(`/avatar/cache-${String(index)}`, ["token"])).toBeNull();
  }
  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(129));
  await Promise.resolve();
  await Promise.resolve();
  for (const loader of loaders) {
    loader.reset();
  }

  const retryOldest = new AuthenticatedAvatarRouteLoader(vi.fn(), { cacheNotFound: true });
  expect(retryOldest.resolve("/avatar/cache-0", ["token"])).toBeNull();
  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(130));

  const reuseNewest = new AuthenticatedAvatarRouteLoader(vi.fn(), { cacheNotFound: true });
  expect(reuseNewest.resolve("/avatar/cache-128", ["token"])).toBeNull();
  expect(fetchMock).toHaveBeenCalledTimes(130);
  retryOldest.reset();
  reuseNewest.reset();
});

it("shares pending fetches and revokes the resolved blob on reset", async () => {
  const createObjectURL = vi.fn(() => "blob:assistant-avatar");
  const revokeObjectURL = vi.fn();
  vi.stubGlobal(
    "URL",
    class extends URL {
      static override createObjectURL = createObjectURL;
      static override revokeObjectURL = revokeObjectURL;
    },
  );
  let release: ((response: Response) => void) | undefined;
  const fetchMock = vi.fn(
    () =>
      new Promise<Response>((resolve) => {
        release = resolve;
      }),
  );
  vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
  const onUpdate = vi.fn();
  const loader = new AuthenticatedAvatarRouteLoader(onUpdate);

  expect(loader.resolve("/avatar/main", ["token"])).toBeNull();
  expect(loader.resolve("/avatar/main", ["token"])).toBeNull();
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(fetchMock).toHaveBeenCalledWith("/avatar/main", {
    headers: { Authorization: "Bearer token" },
    signal: expect.any(AbortSignal),
  });

  release?.({ ok: true, blob: async () => new Blob(["avatar"]) } as Response);
  await vi.waitFor(() => expect(onUpdate).toHaveBeenCalledTimes(1));
  expect(loader.resolve("/avatar/main", ["token"])).toBe("blob:assistant-avatar");

  loader.reset();
  await vi.waitFor(() => expect(revokeObjectURL).toHaveBeenCalledWith("blob:assistant-avatar"));
});

it("leaves misses retryable for a later identity update", async () => {
  vi.stubGlobal(
    "URL",
    class extends URL {
      static override createObjectURL = vi.fn(() => "blob:retried-avatar");
      static override revokeObjectURL = vi.fn();
    },
  );
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce({ ok: false })
    .mockResolvedValueOnce({ ok: true, blob: async () => new Blob(["avatar"]) });
  vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
  const onUpdate = vi.fn();
  const loader = new AuthenticatedAvatarRouteLoader(onUpdate);

  expect(loader.resolve("/avatar/main", ["token"])).toBeNull();
  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  await Promise.resolve();

  expect(loader.resolve("/avatar/main", ["token"])).toBeNull();
  await vi.waitFor(() => expect(onUpdate).toHaveBeenCalledTimes(1));
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(loader.resolve("/avatar/main", ["token"])).toBe("blob:retried-avatar");
  loader.reset();
});

it("releases resolved and pending routes that leave the active render", async () => {
  const revokeObjectURL = vi.fn();
  vi.stubGlobal(
    "URL",
    class extends URL {
      static override createObjectURL = vi.fn(() => "blob:first-avatar");
      static override revokeObjectURL = revokeObjectURL;
    },
  );
  const pending: Array<{
    resolve: (response: Response) => void;
    signal: AbortSignal;
  }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((_url: string, init?: RequestInit) => {
      const signal = init?.signal;
      if (!signal) {
        throw new Error("missing avatar fetch signal");
      }
      return new Promise<Response>((resolve, reject) => {
        pending.push({ resolve, signal });
        signal.addEventListener("abort", () => reject(new Error("avatar fetch aborted")), {
          once: true,
        });
      });
    }) as unknown as typeof fetch,
  );
  const onUpdate = vi.fn();
  const loader = new AuthenticatedAvatarRouteLoader(onUpdate);

  expect(loader.withActiveRoutes(() => loader.resolve("/avatar/first", ["token"]))).toBeNull();
  pending[0]?.resolve({ ok: true, blob: async () => new Blob(["avatar"]) } as Response);
  await vi.waitFor(() => expect(onUpdate).toHaveBeenCalledOnce());
  expect(loader.withActiveRoutes(() => loader.resolve("/avatar/first", ["token"]))).toBe(
    "blob:first-avatar",
  );

  expect(loader.withActiveRoutes(() => loader.resolve("/avatar/second", ["token"]))).toBeNull();
  await vi.waitFor(() => expect(revokeObjectURL).toHaveBeenCalledWith("blob:first-avatar"));
  expect(pending[0]?.signal.aborted).toBe(true);

  loader.withActiveRoutes(() => null);
  await vi.waitFor(() => expect(pending[1]?.signal.aborted).toBe(true));
});

it("falls through to the next credential when the first is rejected", async () => {
  vi.stubGlobal(
    "URL",
    class extends URL {
      static override createObjectURL = vi.fn(() => "blob:recovered-avatar");
      static override revokeObjectURL = vi.fn();
    },
  );
  // A saved token can go stale while the session password stays valid; without
  // ordered recovery the view keeps its fallback for the rest of the session.
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce({ ok: false, status: 401 })
    .mockResolvedValueOnce({ ok: true, blob: async () => new Blob(["avatar"]) });
  vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
  const onUpdate = vi.fn();
  const loader = new AuthenticatedAvatarRouteLoader(onUpdate);

  expect(loader.resolve("/avatar/main", ["stale-token", "session-password"])).toBeNull();
  await vi.waitFor(() => expect(onUpdate).toHaveBeenCalledTimes(1));

  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
    headers: { Authorization: "Bearer stale-token" },
  });
  expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
    headers: { Authorization: "Bearer session-password" },
  });
  expect(loader.resolve("/avatar/main", ["stale-token", "session-password"])).toBe(
    "blob:recovered-avatar",
  );
  loader.reset();
});
