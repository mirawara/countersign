import { CavemanStyle, ExecutionPermission, WorkflowModelSelection, WorkflowProviderSelection } from "../configuration/config";
import { WorkflowEvent } from "./types";
import { StrictConsensus, StrictHumanApproval, StrictPlan } from "./strict";

/** An interrupted approved phase B may reuse approval only after reconstructing its exact baseline. */
export interface StrictApprovedContinuation {
  plan: StrictPlan;
  planHash: string;
  baselineDigest: string;
  baselineHead?: string;
  consensus: StrictConsensus;
  humanApproval: StrictHumanApproval;
  /** Git entries already present when the approved baseline was captured. */
  preExistingEntries?: string[];
}

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
  /** The sidebar's per-turn override of countersign.cavemanStyle. */
  cavemanStyle?: CavemanStyle;
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
  /** An earlier draft to evaluate afresh; it never carries approvals or permission. */
  continuedPlan?: StrictPlan;
  approvedContinuation?: StrictApprovedContinuation;
  accounts?: WorkflowAccountSelection;
  selection?: WorkflowModelSelection;
  executionPermission: ExecutionPermission;
  /** The sidebar's per-turn override of countersign.cavemanStyle. */
  cavemanStyle?: CavemanStyle;
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
