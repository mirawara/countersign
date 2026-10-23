import { ExecutionPermission, WorkflowModelSelection, WorkflowProviderSelection } from "../configuration/config";
import { WorkflowEvent } from "./types";

/** CLI-owned profile directories selected before a task starts. No credentials cross this boundary. */
export interface WorkflowAccountSelection {
  claudeConfigDir?: string;
  codexHome?: string;
  claudeLabel: string;
  codexLabel: string;
}

export interface WorkflowStartRequest {
  task: string;
  accounts?: WorkflowAccountSelection;
  onEvent?: (event: WorkflowEvent) => void;
  providers?: WorkflowProviderSelection;
  selection?: WorkflowModelSelection;
  executionPermission?: ExecutionPermission;
  interaction: {
    askQuestion: (phase: "planning" | "implementing" | "reviewing" | "correcting",
      question: string, signal: AbortSignal) => Promise<string | undefined>;
    confirmPlan: (plan: string, details: string, signal: AbortSignal) => Promise<boolean>;
    askPermission?: (tool: string, detail: string, signal: AbortSignal) => Promise<boolean>;
  };
}

/** The Strict plan gate shown in the chat before anything is implemented. */
export interface StrictPlanPromptData {
  planText: string;
  planHash: string;
  /** Shown as information; nothing is blocked on it. */
  expectedFileCount?: number;
  expectedFilesComplete: boolean;
  executionPermission: ExecutionPermission;
}

export interface StrictPlanApprovalAnswer {
  approved: boolean;
  executionPermission: ExecutionPermission;
}

export interface StrictWorkflowStartRequest {
  task: string;
  accounts?: WorkflowAccountSelection;
  selection?: WorkflowModelSelection;
  executionPermission: ExecutionPermission;
  /** The chat turn's cancellation signal, propagated through Strict preflight and provider probes. */
  signal: AbortSignal;
  onEvent?: (event: import("./types").StrictWorkflowEvent) => void;
  interaction: {
    askQuestion: (question: string, signal: AbortSignal) => Promise<string | undefined>;
    approvePlan: (data: StrictPlanPromptData, signal: AbortSignal) => Promise<StrictPlanApprovalAnswer | undefined>;
    onPause: (detail: string, signal: AbortSignal) => Promise<"resume" | "stop">;
    askPermission?: (tool: string, detail: string, signal: AbortSignal) => Promise<boolean>;
  };
}
