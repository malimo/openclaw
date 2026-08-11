// Wizard session helpers track onboarding session ids and state.
import { randomUUID } from "node:crypto";
import type { WizardStep as ProtocolWizardStep } from "../../packages/gateway-protocol/src/index.js";
import { QR_PNG_DATA_URL_MAX_LENGTH } from "../../packages/gateway-protocol/src/schema/qr.js";
import { renderQrPngDataUrlWithinLimit } from "../media/qr-image.js";
import { createDeferredCore, type Deferred } from "../shared/deferred.js";
import {
  WizardCancelledError,
  type WizardProgress,
  type WizardPrompter,
  type WizardQrCodeParams,
} from "./prompts.js";

// WizardSession exposes interactive setup as a step/answer protocol for remote
// clients while reusing the same WizardPrompter contract as the local CLI.
type ProtocolWizardQrStep = Extract<ProtocolWizardStep, { type: "qr" }>;
type ProtocolWizardNonQrStep = Exclude<ProtocolWizardStep, ProtocolWizardQrStep>;

// WizardSession owns absolute deadlines and may scrub QR bytes before dropping
// its final reference. Client projection restores the required wire fields.
type WizardQrStep = Omit<ProtocolWizardQrStep, "qrDataUrl" | "expiresInMs"> & {
  qrDataUrl?: string;
  /** Internal owner deadline; client projections receive a relative `expiresInMs`. */
  qrExpiresAtMs?: number;
};
export type WizardStep = ProtocolWizardNonQrStep | WizardQrStep;
type DistributiveOmit<T, Key extends PropertyKey> = T extends unknown
  ? Omit<T, Extract<keyof T, Key>>
  : never;
type WizardStepInput = DistributiveOmit<WizardStep, "id">;

type WizardStepInputRequirement = "always" | "never" | "client-executor";

const WIZARD_STEP_INPUT_REQUIREMENT_BY_TYPE = {
  note: "never",
  select: "always",
  text: "always",
  confirm: "always",
  multiselect: "always",
  progress: "never",
  action: "client-executor",
  qr: "never",
} as const satisfies Record<WizardStep["type"], WizardStepInputRequirement>;

/** Whether a step needs a user answer instead of client or gateway acknowledgement. */
export function wizardStepAwaitsInput(step: {
  type: WizardStep["type"];
  executor?: "gateway" | "client";
}): boolean {
  const requirement = WIZARD_STEP_INPUT_REQUIREMENT_BY_TYPE[step.type];
  switch (requirement) {
    case "always":
      return true;
    case "never":
      return false;
    case "client-executor":
      return step.executor === "client";
  }
  const unhandledRequirement: never = requirement;
  return unhandledRequirement;
}

/** Remove secret prefill before a wizard step crosses a client boundary. */
export function sanitizeWizardStepForClient(
  step: WizardStep,
  qrExpiresInMs?: number,
): ProtocolWizardStep {
  if (step.type === "qr") {
    const { qrExpiresAtMs: _qrExpiresAtMs, ...safe } = step;
    if (!safe.qrDataUrl || qrExpiresInMs === undefined) {
      throw new Error("wizard: QR projection requires image bytes and a relative expiry");
    }
    return { ...safe, qrDataUrl: safe.qrDataUrl, expiresInMs: qrExpiresInMs };
  }
  const safe = { ...step };
  if (safe.sensitive === true) {
    delete safe.initialValue;
  }
  return safe;
}

type WizardSessionStatus = "running" | "done" | "cancelled" | "error";

type WizardNextResult = {
  done: boolean;
  step?: WizardStep;
  status: WizardSessionStatus;
  error?: string;
  channels?: string[];
  accounts?: Array<{ channel: string; accountId: string }>;
  preparedModelRef?: string;
};

function normalizeTextAnswer(value: unknown): string | undefined {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  return undefined;
}

class WizardSessionPrompter implements WizardPrompter {
  readonly qrCode?: (params: WizardQrCodeParams) => Promise<void>;

  constructor(
    private session: WizardSession,
    supportsQrCode: boolean,
  ) {
    if (supportsQrCode) {
      this.qrCode = async (params) => {
        if (
          params.expiresAtMs !== undefined &&
          (!Number.isSafeInteger(params.expiresAtMs) || params.expiresAtMs < 0)
        ) {
          throw new RangeError("expiresAtMs must be a non-negative safe integer.");
        }
        const qrDataUrl = await renderQrPngDataUrlWithinLimit(
          params.text,
          QR_PNG_DATA_URL_MAX_LENGTH,
        );
        const step = this.createStep({
          type: "qr",
          title: params.title,
          message: params.message,
          qrDataUrl,
          ...(params.expiresAtMs !== undefined ? { qrExpiresAtMs: params.expiresAtMs } : {}),
          executor: "client",
        });
        const owner = this.session.awaitAnswer(step, undefined, true);
        void params.dismissed.then(
          () => this.session.dismissStep(step.id, { value: undefined }),
          (error: unknown) => this.session.dismissStep(step.id, { error }),
        );
        await owner;
      };
    }
  }

  async intro(title: string): Promise<void> {
    await this.prompt({
      type: "note",
      title,
      message: "",
      executor: "client",
    });
  }

  async outro(message: string): Promise<void> {
    await this.prompt({
      type: "note",
      title: "Done",
      message,
      executor: "client",
    });
  }

  async note(message: string, title?: string): Promise<void> {
    await this.prompt({
      type: "note",
      title,
      message,
      executor: "client",
    });
  }

  async deviceCode(params: {
    title: string;
    code: string;
    expiresInMinutes?: number;
    message?: string;
  }): Promise<void> {
    const fallbackMessage = [
      params.message ?? "Enter this one-time code on the provider's sign-in page.",
      `Code: ${params.code}`,
      ...(params.expiresInMinutes
        ? [`Code expires in ${params.expiresInMinutes} minutes. Never share it.`]
        : []),
    ].join("\n");
    await this.prompt({
      type: "note",
      title: params.title,
      message: fallbackMessage,
      deviceCode: {
        code: params.code,
        ...(params.expiresInMinutes ? { expiresInMinutes: params.expiresInMinutes } : {}),
        ...(params.message ? { message: params.message } : {}),
      },
      executor: "client",
    });
  }

  async plain(message: string): Promise<void> {
    await this.prompt({
      type: "note",
      message,
      format: "plain",
      executor: "client",
    });
  }

  async select<T>(params: {
    message: string;
    options: Array<{ value: T; label: string; hint?: string }>;
    initialValue?: T;
  }): Promise<T> {
    const res = await this.prompt({
      type: "select",
      message: params.message,
      options: params.options.map((opt) => ({
        value: opt.value,
        label: opt.label,
        hint: opt.hint,
      })),
      initialValue: params.initialValue,
      executor: "client",
    });
    return res as T;
  }

  async multiselect<T>(params: {
    message: string;
    options: Array<{ value: T; label: string; hint?: string }>;
    initialValues?: T[];
  }): Promise<T[]> {
    const res = await this.prompt({
      type: "multiselect",
      message: params.message,
      options: params.options.map((opt) => ({
        value: opt.value,
        label: opt.label,
        hint: opt.hint,
      })),
      initialValue: params.initialValues,
      executor: "client",
    });
    return (Array.isArray(res) ? res : []) as T[];
  }

  async text(params: {
    message: string;
    initialValue?: string;
    placeholder?: string;
    validate?: (value: string) => string | undefined;
    sensitive?: boolean;
  }): Promise<string> {
    const res = await this.session.awaitAnswer(
      this.createStep({
        type: "text",
        message: params.message,
        initialValue: params.initialValue,
        placeholder: params.placeholder,
        sensitive: params.sensitive,
        executor: "client",
      }),
      params.validate,
    );
    const value =
      res === null || res === undefined
        ? ""
        : typeof res === "string"
          ? res
          : typeof res === "number" || typeof res === "boolean" || typeof res === "bigint"
            ? String(res)
            : "";
    return value;
  }

  async confirm(params: Parameters<WizardPrompter["confirm"]>[0]): Promise<boolean> {
    const res = await this.prompt({
      type: "confirm",
      message: params.message,
      initialValue: params.initialValue,
      executor: "client",
    });
    return Boolean(res);
  }

  progress(label: string): WizardProgress {
    let stopped = false;
    this.session.pushProgress(label);
    return {
      update: (message) => {
        if (!stopped) {
          this.session.pushProgress(message);
        }
      },
      stop: (message) => {
        if (stopped) {
          return;
        }
        stopped = true;
        if (message) {
          this.session.pushProgress(message);
        }
      },
    };
  }

  async openUrl(url: string): Promise<void> {
    this.session.queueExternalUrl(url);
  }

  private async prompt(step: WizardStepInput): Promise<unknown> {
    return await this.session.awaitAnswer(this.createStep(step));
  }

  private createStep(step: WizardStepInput): WizardStep {
    // Each emitted step receives an id so remote clients can answer the exact
    // pending prompt and stale answers can be rejected. Explicit browser
    // destinations bind to the very next step regardless of its input type.
    const externalUrl = this.session.consumeExternalUrl();
    const id = randomUUID();
    return step.type === "qr"
      ? { ...step, ...(externalUrl ? { externalUrl } : {}), id }
      : { ...step, ...(externalUrl ? { externalUrl } : {}), id };
  }
}

export class WizardSession {
  private readonly abortController = new AbortController();
  private readonly expiryTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly runnerPromise: Promise<void>;
  private currentStep: WizardStep | null = null;
  private progressSteps: WizardStep[] = [];
  private deliveredProgressStepIds = new Set<string>();
  private stepDeferred: Deferred<WizardStep | null> | null = null;
  private pendingTerminalResolution = false;
  private cancellationLocked = false;
  private ownedQrStepIds = new Set<string>();
  private externalQrOwnerStepIds = new Set<string>();
  private settledExternalQrOwnerStepIds = new Set<string>();
  private readonly onQrPresentationOwnerSettled: ((stepId: string) => void) | undefined;
  private settled = false;
  private pendingExternalUrl: string | undefined;
  private answerDeferred = new Map<
    string,
    {
      deferred: Deferred<unknown>;
      text: boolean;
      validate?: (value: string) => string | undefined;
    }
  >();
  private status: WizardSessionStatus = "running";
  private error: string | undefined;
  private configuredAccounts: Array<{ channel: string; accountId: string }> | undefined;
  private preparedModelRef: string | undefined;

  constructor(
    private runner: (
      prompter: WizardPrompter,
      signal: AbortSignal,
      session: WizardSession,
    ) => Promise<void>,
    options?: {
      timeoutMs?: number;
      supportsQrCode?: boolean;
      onQrPresentationOwnerSettled?: (stepId: string) => void;
    },
  ) {
    this.onQrPresentationOwnerSettled = options?.onQrPresentationOwnerSettled;
    const prompter = new WizardSessionPrompter(this, options?.supportsQrCode === true);
    if (options?.timeoutMs !== undefined) {
      this.expiryTimer = setTimeout(() => this.cancel(), options.timeoutMs);
      this.expiryTimer.unref?.();
    }
    this.runnerPromise = this.run(prompter);
  }

  async next(): Promise<WizardNextResult> {
    if (this.currentStep?.type === "qr" && this.externalQrOwnerStepIds.has(this.currentStep.id)) {
      // Give an already-settled owner callback one microtask to retire the QR before this poll
      // snapshots it. Otherwise a poll in the same turn can replay expired credential bytes.
      await Promise.resolve();
    }
    const progressStep = this.progressSteps.shift();
    if (progressStep) {
      this.rememberDeliveredProgressStep(progressStep.id);
      return { done: false, step: progressStep, status: this.status };
    }
    if (this.currentStep) {
      return { done: false, step: this.currentStep, status: this.status };
    }
    if (this.pendingTerminalResolution) {
      this.pendingTerminalResolution = false;
      return this.terminalResult();
    }
    if (this.status !== "running") {
      return this.terminalResult();
    }
    if (!this.stepDeferred) {
      this.stepDeferred = createDeferredCore();
    }
    const step = await this.stepDeferred.promise;
    if (step?.type === "qr" && this.externalQrOwnerStepIds.has(step.id)) {
      // The owner may settle while the first consumer wakes; let its continuation
      // publish the next state before returning a QR that is already unusable.
      await Promise.resolve();
      if (!this.isCurrentStep(step.id)) {
        return await this.next();
      }
    }
    if (step) {
      return { done: false, step, status: this.status };
    }
    return this.terminalResult();
  }

  private isCurrentStep(stepId: string): boolean {
    return this.currentStep?.id === stepId;
  }

  private terminalResult(): WizardNextResult {
    return {
      done: true,
      status: this.status,
      error: this.error,
      ...(this.configuredAccounts
        ? {
            channels: [...new Set(this.configuredAccounts.map((entry) => entry.channel))],
            accounts: this.configuredAccounts.map((entry) => ({ ...entry })),
          }
        : {}),
      ...(this.status === "done" && this.preparedModelRef
        ? { preparedModelRef: this.preparedModelRef }
        : {}),
    };
  }

  /** Record what the channels flow actually configured (channels flow only). */
  setConfiguredAccounts(accounts: ReadonlyArray<{ channel: string; accountId: string }>) {
    this.configuredAccounts = accounts.map((entry) => ({ ...entry }));
  }

  /** Record the exact provider-owned model prepared by a setup flow. */
  setPreparedModelRef(modelRef: string) {
    this.preparedModelRef = modelRef;
  }

  async answer(stepId: string, value: unknown): Promise<string | undefined> {
    if (this.currentStep?.id === stepId && this.currentStep.type === "qr") {
      throw new Error("wizard: QR steps settle through their presentation owner");
    }
    const pending = this.answerDeferred.get(stepId);
    if (!pending) {
      // Gateway-owned progress steps never block the provider run. Older
      // clients still acknowledge every rendered step, so accept that stale
      // acknowledgement while newer clients poll without an answer.
      if (this.deliveredProgressStepIds.delete(stepId)) {
        return undefined;
      }
      throw new Error("wizard: no pending step");
    }
    if (this.currentStep?.id === stepId && this.currentStep.type === "qr") {
      throw new Error("wizard: QR steps settle through their presentation owner");
    }
    const normalizedValue = pending.text ? normalizeTextAnswer(value) : value;
    if (pending.text && normalizedValue === undefined) {
      return "wizard: text answer must be a scalar value";
    }
    const validationError = pending.validate?.(normalizedValue as string) ?? undefined;
    if (validationError) {
      return validationError;
    }
    this.answerDeferred.delete(stepId);
    this.clearCurrentStep();
    pending.deferred.resolve(normalizedValue);
    return undefined;
  }

  /** Settle a passive QR step from its producer without accepting client input. */
  settleQrStep(stepId: string): boolean {
    const pending = this.answerDeferred.get(stepId);
    if (!pending || this.currentStep?.id !== stepId || this.currentStep.type !== "qr") {
      return false;
    }
    this.answerDeferred.delete(stepId);
    this.clearCurrentStep();
    pending.deferred.resolve(undefined);
    return true;
  }

  dismissStep(stepId: string, result: { value: unknown } | { error: unknown }): boolean {
    // The producer is the sole completion authority. Retire its presentation before
    // resuming the hosted runner so no client acknowledgement can race the real result.
    this.settledExternalQrOwnerStepIds.add(stepId);
    if (this.currentStep && this.currentStep.id !== stepId) {
      this.ownedQrStepIds.delete(stepId);
      this.externalQrOwnerStepIds.delete(stepId);
      this.settledExternalQrOwnerStepIds.delete(stepId);
    }
    this.onQrPresentationOwnerSettled?.(stepId);
    const pending = this.answerDeferred.get(stepId);
    if (!pending) {
      return false;
    }
    this.answerDeferred.delete(stepId);
    if (this.currentStep?.id === stepId) {
      this.clearCurrentStep();
    }
    if ("error" in result) {
      pending.deferred.reject(result.error);
    } else {
      pending.deferred.resolve(result.value);
    }
    return true;
  }

  cancel(): boolean {
    if (this.status !== "running" || this.cancellationLocked) {
      return false;
    }
    this.status = "cancelled";
    this.error = "cancelled";
    this.abortController.abort(new WizardCancelledError());
    this.clearCurrentStep();
    for (const [, pending] of this.answerDeferred) {
      // Reject all pending prompt promises so the runner can unwind through its
      // normal cancellation path.
      pending.deferred.reject(new WizardCancelledError());
    }
    this.answerDeferred.clear();
    this.progressSteps = [];
    this.deliveredProgressStepIds.clear();
    this.ownedQrStepIds.clear();
    this.externalQrOwnerStepIds.clear();
    this.settledExternalQrOwnerStepIds.clear();
    this.resolveStep(null);
    return true;
  }

  private clearCurrentStep() {
    if (this.currentStep?.type === "qr") {
      // Delivered results and the host can retain this object after the session drops it.
      // Scrub the credential bytes before releasing the producer or any session owner.
      const qrStep: { qrDataUrl?: string } = this.currentStep;
      delete qrStep.qrDataUrl;
    }
    this.currentStep = null;
  }

  /** The underlying mutation crossed its durable commit point and must finish. */
  lockCancellation() {
    this.cancellationLocked = true;
  }

  get signal(): AbortSignal {
    return this.abortController.signal;
  }

  /** Keep a wizard eviction-protected while its QR-owned operation is still in flight. */
  hasOwnedQrPresentation(): boolean {
    return this.ownedQrStepIds.size > 0 && this.status === "running" && !this.settled;
  }

  /** True while a producer promise owns QR completion. */
  hasExternalQrPresentationOwner(): boolean {
    return this.externalQrOwnerStepIds.size > 0 && this.status === "running" && !this.settled;
  }

  /** Retire an expired credential while its external owner finishes or rejects the operation. */
  expireOwnedQrPresentation(stepId: string): boolean {
    if (!this.externalQrOwnerStepIds.has(stepId) || !this.hasExternalQrPresentationOwner()) {
      return false;
    }
    const pending = this.answerDeferred.get(stepId);
    if (!pending) {
      return false;
    }
    if (this.currentStep?.id === stepId) {
      if (this.currentStep.qrDataUrl) {
        delete this.currentStep.qrDataUrl;
      }
      this.currentStep = null;
    }
    // Presentation expiry is not an owner result. Keep the prompt promise pending until
    // the producer completes or cancellation stops the underlying operation.
    return true;
  }

  pushStep(step: WizardStep) {
    this.currentStep = step;
    this.resolveStep(step);
  }

  pushProgress(message: string) {
    if (this.status !== "running") {
      return;
    }
    const step: WizardStep = {
      id: randomUUID(),
      type: "progress",
      message,
      executor: "gateway",
    };
    if (this.stepDeferred) {
      this.rememberDeliveredProgressStep(step.id);
      this.resolveStep(step);
      return;
    }
    // Keep the oldest unread event and the newest snapshot. This preserves the
    // initial label while bounding bursty pull updates between client polls.
    if (this.progressSteps.length >= 2) {
      this.progressSteps[this.progressSteps.length - 1] = step;
      return;
    }
    this.progressSteps.push(step);
  }

  private rememberDeliveredProgressStep(stepId: string) {
    this.deliveredProgressStepIds.add(stepId);
    if (this.deliveredProgressStepIds.size <= 64) {
      return;
    }
    const oldest = this.deliveredProgressStepIds.values().next().value;
    if (oldest) {
      this.deliveredProgressStepIds.delete(oldest);
    }
  }

  queueExternalUrl(url: string) {
    this.pendingExternalUrl = url;
  }

  consumeExternalUrl(): string | undefined {
    const url = this.pendingExternalUrl;
    this.pendingExternalUrl = undefined;
    return url;
  }

  private async run(prompter: WizardPrompter) {
    try {
      await this.runner(prompter, this.signal, this);
      if (this.status === "running") {
        this.status = "done";
      }
    } catch (err) {
      if (this.status !== "running") {
        return;
      }
      if (err instanceof WizardCancelledError) {
        this.status = "cancelled";
        this.error = err.message;
      } else {
        this.status = "error";
        this.error = String(err);
      }
    } finally {
      this.clearCurrentStep();
      this.settled = true;
      this.ownedQrStepIds.clear();
      this.externalQrOwnerStepIds.clear();
      this.settledExternalQrOwnerStepIds.clear();
      if (this.expiryTimer) {
        clearTimeout(this.expiryTimer);
      }
      this.resolveStep(null);
    }
  }

  async awaitAnswer(
    step: WizardStep,
    validate?: (value: string) => string | undefined,
    qrPresentationHasExternalOwner = false,
  ): Promise<unknown> {
    if (this.status !== "running") {
      throw new Error("wizard: session not running");
    }
    // Once a settled QR owner emits its next step, it can no longer mutate state behind that
    // step. Retire only those owners; unresolved owners stay protected across later prompts.
    for (const stepId of this.settledExternalQrOwnerStepIds) {
      this.ownedQrStepIds.delete(stepId);
      this.externalQrOwnerStepIds.delete(stepId);
    }
    this.settledExternalQrOwnerStepIds.clear();
    if (step.type === "qr") {
      this.ownedQrStepIds.add(step.id);
      if (qrPresentationHasExternalOwner) {
        this.externalQrOwnerStepIds.add(step.id);
      }
    }
    this.pushStep(step);
    const deferred = createDeferredCore<unknown>();
    this.answerDeferred.set(step.id, { deferred, text: step.type === "text", validate });
    return await deferred.promise;
  }

  private resolveStep(step: WizardStep | null) {
    if (!this.stepDeferred) {
      if (step === null) {
        // The runner can finish immediately after an answer before next() has
        // installed a waiter; remember that terminal state for the next poll.
        this.pendingTerminalResolution = true;
      }
      return;
    }
    const deferred = this.stepDeferred;
    this.stepDeferred = null;
    deferred.resolve(step);
  }

  getStatus(): WizardSessionStatus {
    return this.status;
  }

  /** Whether the runner has stopped and can no longer mutate setup state. */
  isSettled(): boolean {
    return this.settled;
  }

  /** Resolves after the runner can no longer mutate setup state. */
  whenSettled(): Promise<void> {
    return this.runnerPromise;
  }

  getError(): string | undefined {
    return this.error;
  }
}
