import { WorkflowModelSelection, WorkflowProviderSelection } from "../configuration/config";
import { WorkflowEvent } from "./types";

export interface WorkflowStartRequest {
  task: string;
  onEvent?: (event: WorkflowEvent) => void;
  providers?: WorkflowProviderSelection;
  selection?: WorkflowModelSelection;
  interaction: {
    askQuestion: (phase: "planning" | "implementing" | "reviewing" | "correcting",
      question: string, signal: AbortSignal) => Promise<string | undefined>;
    confirmPlan: (plan: string, details: string, signal: AbortSignal) => Promise<boolean>;
  };
}
