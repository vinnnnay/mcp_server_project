/**
 * Distinct code per rejection reason. Tests assert on these, the audit log
 * records them, and the agent gets a message it can act on.
 */
export const GateErrorCode = {
  NOT_FOUND: "E_NOT_FOUND",
  NOT_APPROVED: "E_NOT_APPROVED",
  ALREADY_EXECUTED: "E_ALREADY_EXECUTED",
  EXPIRED: "E_EXPIRED",
  PAYLOAD_TAMPERED: "E_PAYLOAD_TAMPERED",
  STATE_DRIFT: "E_STATE_DRIFT",
  SELF_APPROVAL: "E_SELF_APPROVAL",
  POLICY_DENIED: "E_POLICY_DENIED",
  UNKNOWN_TABLE: "E_UNKNOWN_TABLE",
  UNKNOWN_COLUMN: "E_UNKNOWN_COLUMN",
  ROW_CAP_EXCEEDED: "E_ROW_CAP_EXCEEDED",
  CANCELLED: "E_CANCELLED",
} as const;

export type GateErrorCode = (typeof GateErrorCode)[keyof typeof GateErrorCode];

export class GateError extends Error {
  constructor(
    readonly code: GateErrorCode,
    message: string,
    readonly detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "GateError";
  }
}
