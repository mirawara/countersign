import { ExecutionPermission, WorkflowModelSelection, WorkflowProviderSelection } from "../configuration/config";
import { WorkflowEvent } from "./types";

export interface WorkflowStartRequest {
  task: string;
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
