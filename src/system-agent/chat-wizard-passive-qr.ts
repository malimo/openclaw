import type { WizardSession } from "../wizard/session.js";

type PassiveQrOwnerStatus = {
  text: string;
  configWritten: false;
};

/** Owns the bounded, ID-only cursor retained while passive QR setup settles. */
export class ChatWizardPassiveQrLifecycle {
  private currentStepId: string | undefined;
  private successorStepId: string | undefined;
  private retentionExpiresAtMs: number | undefined;

  get expiresAtMs(): number | undefined {
    return this.retentionExpiresAtMs;
  }

  hasPending(nowMs = Date.now()): boolean {
    this.prune(nowMs);
    return this.currentStepId !== undefined;
  }

  clear(): void {
    this.currentStepId = undefined;
    this.successorStepId = undefined;
    this.retentionExpiresAtMs = undefined;
  }

  recordPresented(stepId: string): void {
    if (this.currentStepId === undefined) {
      this.currentStepId = stepId;
    } else if (this.currentStepId !== stepId) {
      this.successorStepId = stepId;
    }
    this.retentionExpiresAtMs = undefined;
  }

  recordSuccessor(stepId: string): void {
    if (stepId !== this.currentStepId) {
      // Retain only the successor ID. QR bytes remain owned and scrubbed by WizardSession.
      this.successorStepId = stepId;
    }
  }

  adoptSuccessor(stepId: string): void {
    if (this.successorStepId !== stepId) {
      return;
    }
    // Adoption makes the predecessor stale while preserving retry of the adopted cursor.
    this.currentStepId = stepId;
    this.successorStepId = undefined;
  }

  tracks(stepId: string): boolean {
    return this.currentStepId === stepId || this.successorStepId === stepId;
  }

  isPollable(stepId: string, activeStepId?: string): boolean {
    this.prune();
    return activeStepId === stepId || this.tracks(stepId);
  }

  renderPendingOwner(session: WizardSession, expectedStepId?: string): PassiveQrOwnerStatus | null {
    if (!session.hasExternalQrPresentationOwner(expectedStepId)) {
      return null;
    }
    return {
      text: "Setup is still finishing this QR operation. Say `cancel` to stop it.",
      configWritten: false,
    };
  }

  async retainAfterSettlement(
    session: WizardSession,
    stepId: string,
    retentionMs: number,
  ): Promise<boolean> {
    await session.whenSettled();
    if (!this.tracks(stepId)) {
      return false;
    }
    this.retentionExpiresAtMs = Date.now() + retentionMs;
    return true;
  }

  private prune(nowMs = Date.now()): void {
    if (this.retentionExpiresAtMs !== undefined && this.retentionExpiresAtMs <= nowMs) {
      this.clear();
    }
  }
}
