/* @vitest-environment jsdom */

import { GatewayProtocolRequestError } from "@openclaw/gateway-client/browser";
import { buildSystemAgentSessionInvalidatedErrorDetails } from "@openclaw/gateway-protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { createContext, mountPage } from "./custodian-page.test-harness.ts";

const QR_DATA_URL = "data:image/png;base64,AAAA";
const SESSION_ID = "qr-session";

function qrResult(expiresInMs = 60_000, stepId = "qr-step") {
  return {
    sessionId: SESSION_ID,
    reply: "Scan this code and approve the device.",
    action: "none" as const,
    wizardSettling: true,
    step: {
      id: stepId,
      type: "qr" as const,
      title: "Link a device",
      message: "Scan this QR code and approve the device.",
      qrDataUrl: QR_DATA_URL,
      expiresInMs,
      executor: "client" as const,
    },
  };
}

function terminalResult(reply = "Signal is configured.", sessionId = SESSION_ID) {
  return { sessionId, reply, action: "none" as const };
}

describe("custodian QR wizard step", () => {
  beforeEach(() => {
    vi.spyOn(crypto, "randomUUID").mockReturnValue("00000000-0000-4000-8000-000000000001");
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it("renders QR and polls until its owner completes", async () => {
    vi.useFakeTimers();
    const request = vi
      .fn()
      .mockResolvedValueOnce(qrResult())
      .mockResolvedValueOnce(terminalResult("Device linked."));
    const { page } = await mountPage(createContext(request).context);
    await vi.advanceTimersByTimeAsync(0);

    await waitForFast(() => expect(page.querySelector(".wizard-step__qr")).not.toBeNull());
    const image = page.querySelector<HTMLImageElement>(".wizard-step__qr");
    expect(image?.getAttribute("src")).toBe(QR_DATA_URL);
    expect(page.textContent).not.toContain(QR_DATA_URL);

    expect(page.querySelector(".custodian__wizard-step .btn.primary")).toBeNull();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(request.mock.calls[1]?.[1]).toEqual({ sessionId: SESSION_ID, pollStepId: "qr-step" });
    await waitForFast(() => expect(page.textContent).toContain("Device linked."));
    await waitForFast(() =>
      expect(page.store.messages.some((message) => message.step?.qrDataUrl)).toBe(false),
    );
  });

  it("cancels QR setup through the dedicated typed action", async () => {
    vi.useFakeTimers();
    const request = vi
      .fn()
      .mockResolvedValueOnce(qrResult())
      .mockResolvedValueOnce(terminalResult("Signal setup cancelled."));
    const { page } = await mountPage(createContext(request).context);
    await vi.advanceTimersByTimeAsync(0);

    const cancelButtons = Array.from(
      page.querySelectorAll<HTMLButtonElement>(".custodian__wizard-step .btn"),
    ).filter((button) => button.textContent?.trim() === "Cancel");
    expect(cancelButtons).toHaveLength(1);
    cancelButtons[0]?.click();
    await vi.advanceTimersByTimeAsync(2_000);
    await page.updateComplete;

    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[1]?.[1]).toEqual({
      sessionId: SESSION_ID,
      wizardCancel: { stepId: "qr-step" },
    });
    await waitForFast(() => expect(page.textContent).toContain("Signal setup cancelled."));
  });

  it.each([
    ["exit setup", (page: Awaited<ReturnType<typeof mountPage>>["page"]) => page.store.exitSetup()],
    [
      "open model setup",
      (page: Awaited<ReturnType<typeof mountPage>>["page"]) => page.store.openModelSetup(),
    ],
    [
      "open channels",
      (page: Awaited<ReturnType<typeof mountPage>>["page"]) =>
        page.store.openChannelsFromOnboarding(),
    ],
  ])("stops QR polling and scrubs image bytes when users %s", async (_name, navigate) => {
    vi.useFakeTimers();
    const request = vi.fn().mockResolvedValueOnce(qrResult());
    const { page } = await mountPage(createContext(request).context);
    await vi.advanceTimersByTimeAsync(0);

    navigate(page);
    await vi.advanceTimersByTimeAsync(2_000);
    await page.updateComplete;

    expect(request).toHaveBeenCalledOnce();
    expect(page.store.messages.some((message) => message.step?.qrDataUrl)).toBe(false);
  });

  it("polls without duplicating the QR transcript and shows owner completion", async () => {
    vi.useFakeTimers();
    const request = vi
      .fn()
      .mockResolvedValueOnce(qrResult())
      .mockResolvedValueOnce(qrResult(30_000))
      .mockResolvedValueOnce(terminalResult());
    const { page } = await mountPage(createContext(request).context);
    await vi.advanceTimersByTimeAsync(0);

    const messageCount = page.store.messages.length;
    await vi.advanceTimersByTimeAsync(1_000);
    await page.updateComplete;

    expect(request.mock.calls[1]?.[1]).toEqual({ sessionId: SESSION_ID, pollStepId: "qr-step" });
    expect(page.store.messages).toHaveLength(messageCount);
    const qrMessages = page.store.messages.filter((message) => message.step?.id === "qr-step");
    expect(qrMessages).toHaveLength(1);
    expect(qrMessages[0]?.step?.expiresInMs).toBe(30_000);

    await vi.advanceTimersByTimeAsync(1_000);
    await page.updateComplete;

    expect(request.mock.calls[2]?.[1]).toEqual({ sessionId: SESSION_ID, pollStepId: "qr-step" });
    expect(page.store.messages).toHaveLength(messageCount + 1);
    expect(page.textContent).toContain("Signal is configured.");
    expect(page.querySelector(".wizard-step__qr")).toBeNull();
    expect(page.store.messages.some((message) => message.step?.qrDataUrl)).toBe(false);
  });

  it("retries a transient QR poll failure", async () => {
    vi.useFakeTimers();
    const request = vi
      .fn()
      .mockResolvedValueOnce(qrResult())
      .mockRejectedValueOnce(new Error("temporary poll failure"))
      .mockResolvedValueOnce(terminalResult());
    const { page } = await mountPage(createContext(request).context);
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(2_000);
    await page.updateComplete;

    expect(request).toHaveBeenCalledTimes(3);
    expect(request.mock.calls[2]?.[1]).toEqual({ sessionId: SESSION_ID, pollStepId: "qr-step" });
    expect(page.textContent).toContain("Signal is configured.");
    expect(page.store.messages.some((message) => message.step?.qrDataUrl)).toBe(false);
  });

  it("resumes polling a pending QR step after a same-client reconnect", async () => {
    vi.useFakeTimers();
    const request = vi
      .fn()
      .mockResolvedValueOnce(qrResult())
      .mockResolvedValueOnce(terminalResult());
    const { context, setGatewaySnapshot } = createContext(request);
    const hello = context.gateway.snapshot.hello;
    const { page } = await mountPage(context);
    await vi.advanceTimersByTimeAsync(0);

    setGatewaySnapshot({ phase: "reconnecting", hello: null });
    await page.updateComplete;
    expect(page.querySelector(".wizard-step__qr")).toBeNull();
    expect(page.store.messages.some((message) => message.step?.qrDataUrl)).toBe(false);

    setGatewaySnapshot({
      phase: "connected",
      hello,
    });
    await page.updateComplete;
    await vi.advanceTimersByTimeAsync(1_000);
    await page.updateComplete;

    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[1]?.[1]).toEqual({ sessionId: SESSION_ID, pollStepId: "qr-step" });
    expect(page.textContent).toContain("Signal is configured.");
  });

  it("resumes the same QR session after a client replacement", async () => {
    vi.useFakeTimers();
    const request = vi
      .fn()
      .mockResolvedValueOnce(qrResult())
      .mockResolvedValueOnce(terminalResult());
    const { context, setGatewaySnapshot } = createContext(request);
    const { page } = await mountPage(context);
    await vi.advanceTimersByTimeAsync(0);

    setGatewaySnapshot({
      client: { request } as unknown as GatewayBrowserClient,
    });
    await page.updateComplete;
    expect(page.querySelector(".wizard-step__qr")).toBeNull();

    await vi.advanceTimersByTimeAsync(1_000);
    await page.updateComplete;

    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[1]?.[1]).toEqual({ sessionId: SESSION_ID, pollStepId: "qr-step" });
    expect(page.textContent).toContain("Signal is configured.");
  });

  it("starts fresh instead of polling when the authenticated owner changes", async () => {
    vi.useFakeTimers();
    const request = vi
      .fn()
      .mockResolvedValueOnce(qrResult())
      .mockResolvedValueOnce(terminalResult("Fresh owner session.", "replacement-session"));
    const { context, setGatewaySnapshot } = createContext(request);
    const hello = context.gateway.snapshot.hello!;
    const { page } = await mountPage(context);
    await vi.advanceTimersByTimeAsync(0);

    setGatewaySnapshot({
      client: { request } as unknown as GatewayBrowserClient,
      hello: {
        ...hello,
        auth: { ...hello.auth, recoveryScope: "different-owner" },
      },
    });
    await page.updateComplete;
    await vi.advanceTimersByTimeAsync(0);

    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[1]?.[1]).not.toHaveProperty("pollStepId");
    expect(request.mock.calls[1]?.[1]?.sessionId).not.toBe(SESSION_ID);
    expect(page.store.messages.some((message) => message.step?.qrDataUrl)).toBe(false);
  });

  it("does not poll while replacement-client ownership is unresolved", async () => {
    vi.useFakeTimers();
    const request = vi
      .fn()
      .mockResolvedValueOnce(qrResult())
      .mockResolvedValueOnce(terminalResult("Fresh unowned session.", "replacement-session"));
    let recoveryScopeReady = false;
    const replacement = {
      request,
      get recoveryScopeReady() {
        return recoveryScopeReady;
      },
      get recoveryScope() {
        return "";
      },
    } as unknown as GatewayBrowserClient;
    const { context, setGatewaySnapshot } = createContext(request);
    const hello = context.gateway.snapshot.hello!;
    const { page } = await mountPage(context);
    await vi.advanceTimersByTimeAsync(0);

    setGatewaySnapshot({
      client: replacement,
      hello: { ...hello, auth: { role: "operator", scopes: ["operator.admin"] } },
    });
    await vi.advanceTimersByTimeAsync(2_000);

    expect(request).toHaveBeenCalledOnce();
    expect(page.store.messages.some((message) => message.step?.qrDataUrl)).toBe(false);

    recoveryScopeReady = true;
    setGatewaySnapshot({});
    await vi.advanceTimersByTimeAsync(0);

    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[1]?.[1]).not.toHaveProperty("pollStepId");
    expect(request.mock.calls[1]?.[1]?.sessionId).not.toBe(SESSION_ID);
  });

  it("scrubs the QR and starts fresh after poll session invalidation", async () => {
    vi.useFakeTimers();
    const request = vi
      .fn()
      .mockResolvedValueOnce(qrResult())
      .mockRejectedValueOnce(
        new GatewayProtocolRequestError({
          code: "INVALID_REQUEST",
          message: "QR session was evicted.",
          details: buildSystemAgentSessionInvalidatedErrorDetails(),
        }),
      )
      .mockResolvedValueOnce(terminalResult("Fresh session ready.", "replacement-session"));
    const { page } = await mountPage(createContext(request).context);
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(1_000);
    await page.updateComplete;

    expect(request).toHaveBeenCalledTimes(3);
    expect(request.mock.calls[2]?.[1]).not.toHaveProperty("pollStepId");
    expect(request.mock.calls[2]?.[1]?.sessionId).not.toBe(SESSION_ID);
    expect(page.textContent).toContain("Fresh session ready.");
    expect(page.store.messages.some((message) => message.step?.qrDataUrl)).toBe(false);
  });

  it("scrubs expired image bytes while a result poll is still pending", async () => {
    vi.useFakeTimers();
    const pendingPoll = new Promise<never>(() => {});
    const request = vi.fn().mockResolvedValueOnce(qrResult(2_000)).mockReturnValueOnce(pendingPoll);
    const { page } = await mountPage(createContext(request).context);
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(2_000);
    await page.updateComplete;

    expect(page.querySelector(".wizard-step__qr")).toBeNull();
    expect(page.textContent).toContain("This QR code expired.");
    expect(page.store.messages.some((message) => message.step?.qrDataUrl)).toBe(false);
  });

  it("does not restore an expired QR from a poll that started before expiry", async () => {
    vi.useFakeTimers();
    let resolvePoll!: (result: ReturnType<typeof qrResult>) => void;
    const pendingPoll = new Promise<ReturnType<typeof qrResult>>((resolve) => {
      resolvePoll = resolve;
    });
    const request = vi.fn().mockResolvedValueOnce(qrResult(2_000)).mockReturnValueOnce(pendingPoll);
    const { page } = await mountPage(createContext(request).context);
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(request).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(page.querySelector(".wizard-step__qr")).toBeNull();

    resolvePoll(qrResult(60_000));
    await vi.advanceTimersByTimeAsync(0);
    await page.updateComplete;

    expect(page.querySelector(".wizard-step__qr")).toBeNull();
    expect(page.textContent).toContain("This QR code expired.");
    expect(page.store.messages.some((message) => message.step?.qrDataUrl)).toBe(false);
  });

  it("keeps polling and offers typed cancellation after QR expiry", async () => {
    vi.useFakeTimers();
    const pendingResult = {
      sessionId: SESSION_ID,
      reply: "Setup is still finishing the QR attempt.",
      action: "none" as const,
      wizardSettling: true,
    };
    const request = vi
      .fn()
      .mockResolvedValueOnce(qrResult(1_000))
      .mockResolvedValueOnce(pendingResult)
      .mockResolvedValueOnce(pendingResult)
      .mockResolvedValueOnce(terminalResult("Signal setup cancelled."));
    const { context, emitGatewayEvent } = createContext(request);
    const { page } = await mountPage(context, { onboarding: false });
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(1_000);
    await page.updateComplete;
    expect(page.querySelector(".wizard-step__qr")).toBeNull();
    expect(page.textContent).toContain("This QR code expired.");
    expect(page.store.wizardInputPending).toBe(false);
    expect(page.store.wizardSettling).toBe(true);
    expect(page.store.messages.some((message) => message.step?.qrDataUrl)).toBe(false);

    emitGatewayEvent({
      event: "health",
      payload: { channels: { telegram: { configured: true, healthState: "stale-socket" } } },
    });
    await page.updateComplete;
    const nudge = page.querySelector<HTMLButtonElement>(".custodian__nudge-action");
    expect(nudge).not.toBeNull();
    expect(nudge?.disabled).toBe(true);
    nudge?.click();
    await expect(page.store.send("check health now")).resolves.toBe("rejected");
    expect(request).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(request.mock.calls.filter((call) => call[1]?.pollStepId === "qr-step")).toHaveLength(2);

    const cancelButton = Array.from(
      page.querySelectorAll<HTMLButtonElement>(".custodian__wizard-step .btn"),
    ).find((button) => button.textContent?.trim() === "Cancel");
    cancelButton?.click();
    await waitForFast(() => expect(request).toHaveBeenCalledTimes(4));
    expect(request.mock.calls[3]?.[1]).toEqual({
      sessionId: SESSION_ID,
      wizardCancel: { stepId: "qr-step" },
    });
    await waitForFast(() => expect(page.textContent).toContain("Signal setup cancelled."));
    expect(page.store.messages.some((message) => message.step?.qrDataUrl)).toBe(false);
  });
});
