import { describe, expect, it } from "vitest";
import {
  allowedWorkflowTransitions, assertWorkflowTransition, isTerminalState, isTerminalStateFor, isWorkflowStateInMode,
} from "../src/orchestrator/stateMachine";
import {
  BALANCED_WORKFLOW_STATES, BalancedWorkflowState, STRICT_WORKFLOW_STATES, StrictWorkflowState, WorkflowMode, WorkflowState,
} from "../src/shared/types";

const ALL_STATES: WorkflowState[] = [...new Set<WorkflowState>([...BALANCED_WORKFLOW_STATES, ...STRICT_WORKFLOW_STATES])];
const STRICT_ONLY = STRICT_WORKFLOW_STATES.filter((state) => !isWorkflowStateInMode("balanced", state));
const BALANCED_ONLY = BALANCED_WORKFLOW_STATES.filter((state) => !isWorkflowStateInMode("strict", state));

function reachableFrom(mode: WorkflowMode, start: WorkflowState): Set<WorkflowState> {
  const seen = new Set<WorkflowState>([start]);
  const queue: WorkflowState[] = [start];
  while (queue.length > 0) {
    for (const next of allowedWorkflowTransitions(mode, queue.shift() as WorkflowState)) {
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  return seen;
}

function sourcesOf(mode: WorkflowMode, target: WorkflowState): WorkflowState[] {
  return ALL_STATES.filter((state) => allowedWorkflowTransitions(mode, state).has(target)).sort();
}

describe("workflow state machine", () => {
  it("enumerates every workflow state in both modes", () => {
    for (const state of ALL_STATES) {
      expect(() => allowedWorkflowTransitions("balanced", state), state).not.toThrow();
      expect(() => allowedWorkflowTransitions("strict", state), state).not.toThrow();
    }
    expect(STRICT_ONLY).toEqual([
      "planning", "awaiting_consensus", "awaiting_human_approval", "awaiting_final_consensus", "paused", "consensus_not_reached",
    ]);
    expect(BALANCED_ONLY).toEqual(["awaiting_confirmation", "completed_with_findings"]);
  });

  it("keeps the Balanced graph unchanged", () => {
    expect(() => assertWorkflowTransition("balanced", "idle", "preflight")).not.toThrow();
    expect(() => assertWorkflowTransition("balanced", "preflight", "awaiting_confirmation")).not.toThrow();
    expect(() => assertWorkflowTransition("balanced", "awaiting_confirmation", "implementing")).not.toThrow();
    expect(() => assertWorkflowTransition("balanced", "implementing", "running_checks")).not.toThrow();
    expect(() => assertWorkflowTransition("balanced", "running_checks", "completed_clean")).not.toThrow();
    expect(() => assertWorkflowTransition("balanced", "running_checks", "completed_with_findings")).not.toThrow();
    expect(() => assertWorkflowTransition("balanced", "reviewing", "correcting")).not.toThrow();
    expect(() => assertWorkflowTransition("balanced", "correcting", "running_checks")).not.toThrow();
    expect(() => assertWorkflowTransition("balanced", "preflight", "implementing"))
      .toThrow("Invalid balanced workflow transition: preflight -> implementing.");
    expect(() => assertWorkflowTransition("balanced", "implementing", "reviewing")).toThrow();
    expect(() => assertWorkflowTransition("balanced", "completed_clean", "reviewing")).toThrow();
  });

  it("never links Balanced to a Strict-only state", () => {
    for (const state of ALL_STATES) {
      for (const target of allowedWorkflowTransitions("balanced", state)) {
        expect(isWorkflowStateInMode("balanced", target), `${state} -> ${target}`).toBe(true);
      }
      for (const target of allowedWorkflowTransitions("strict", state)) {
        expect(isWorkflowStateInMode("strict", target), `${state} -> ${target}`).toBe(true);
      }
    }
    for (const state of STRICT_ONLY) {
      expect(allowedWorkflowTransitions("balanced", state).size, state).toBe(0);
      expect(sourcesOf("balanced", state), state).toEqual([]);
    }
    for (const state of BALANCED_ONLY) {
      expect(allowedWorkflowTransitions("strict", state).size, state).toBe(0);
      expect(sourcesOf("strict", state), state).toEqual([]);
    }
  });

  it("walks the Strict happy path through both phases", () => {
    const path: StrictWorkflowState[] = [
      "idle", "preflight", "planning", "awaiting_consensus", "awaiting_human_approval",
      "implementing", "running_checks", "reviewing", "awaiting_final_consensus", "completed_clean",
    ];
    for (let index = 0; index + 1 < path.length; index++) {
      expect(() => assertWorkflowTransition("strict", path[index], path[index + 1]), `${path[index]} -> ${path[index + 1]}`).not.toThrow();
    }
  });

  it("rejects Strict shortcuts around consensus and the human gate", () => {
    expect(() => assertWorkflowTransition("strict", "awaiting_consensus", "implementing"))
      .toThrow("Invalid strict workflow transition: awaiting_consensus -> implementing.");
    expect(() => assertWorkflowTransition("strict", "planning", "awaiting_human_approval")).toThrow();
    expect(() => assertWorkflowTransition("strict", "running_checks", "completed_clean")).toThrow();
    expect(() => assertWorkflowTransition("strict", "reviewing", "completed_clean")).toThrow();
    expect(() => assertWorkflowTransition("strict", "correcting", "completed_clean")).toThrow();
    expect(() => assertWorkflowTransition("strict", "preflight", "implementing")).toThrow();
    expect(sourcesOf("strict", "completed_clean")).toEqual(["awaiting_final_consensus"]);
    expect(sourcesOf("strict", "implementing")).toEqual(["awaiting_human_approval", "awaiting_input", "paused"]);
  });

  it("reopens phase A when a plan is revised or a human edits it", () => {
    expect(() => assertWorkflowTransition("strict", "awaiting_consensus", "planning")).not.toThrow();
    expect(() => assertWorkflowTransition("strict", "awaiting_human_approval", "planning")).not.toThrow();
    expect(() => assertWorkflowTransition("strict", "awaiting_human_approval", "cancelled")).not.toThrow();
  });

  it("restarts review work after a failed check and after a new digest", () => {
    expect(() => assertWorkflowTransition("strict", "running_checks", "correcting")).not.toThrow();
    expect(() => assertWorkflowTransition("strict", "correcting", "running_checks")).not.toThrow();
    expect(() => assertWorkflowTransition("strict", "awaiting_final_consensus", "reviewing")).not.toThrow();
    expect(() => assertWorkflowTransition("strict", "awaiting_final_consensus", "correcting")).not.toThrow();
  });

  it("pauses from every Strict active state and resumes into it", () => {
    const active: StrictWorkflowState[] = [
      "planning", "awaiting_consensus", "implementing", "running_checks", "reviewing", "correcting", "awaiting_final_consensus",
    ];
    for (const state of active) {
      expect(() => assertWorkflowTransition("strict", state, "paused"), state).not.toThrow();
      expect(() => assertWorkflowTransition("strict", "paused", state), state).not.toThrow();
    }
    expect(() => assertWorkflowTransition("strict", "paused", "consensus_not_reached")).not.toThrow();
    expect(() => assertWorkflowTransition("strict", "paused", "completed_clean")).toThrow();
    expect(() => assertWorkflowTransition("balanced", "implementing", "paused")).toThrow();
  });

  it("classifies terminal states per mode", () => {
    const balancedTerminal: BalancedWorkflowState[] = [
      "completed_clean", "completed_with_findings", "no_changes", "validation_failed",
      "blocked_untrusted_workspace", "blocked_provider", "blocked_permissions", "blocked_auth_or_quota",
      "review_failed", "cancelled", "timed_out", "failed",
    ];
    const strictTerminal: StrictWorkflowState[] = [
      "completed_clean", "no_changes", "consensus_not_reached", "validation_failed", "review_failed",
      "blocked_untrusted_workspace", "blocked_provider", "blocked_permissions", "blocked_auth_or_quota",
      "cancelled", "timed_out", "failed",
    ];
    for (const state of balancedTerminal) {
      expect(isTerminalState(state), state).toBe(true);
      expect(isTerminalStateFor("balanced", state), state).toBe(true);
    }
    for (const state of strictTerminal) {
      expect(isTerminalStateFor("strict", state), state).toBe(true);
    }
    expect(isTerminalStateFor("strict", "completed_with_findings")).toBe(false);
    expect(isTerminalStateFor("balanced", "consensus_not_reached")).toBe(false);
    expect(isTerminalState("paused")).toBe(false);
    expect(isTerminalState("awaiting_human_approval")).toBe(false);
    for (const state of ALL_STATES) {
      if (!isTerminalState(state)) continue;
      expect(allowedWorkflowTransitions("balanced", state).size, state).toBe(0);
      expect(allowedWorkflowTransitions("strict", state).size, state).toBe(0);
    }
  });

  it("leaves no state of a mode unreachable from idle", () => {
    const balancedReachable = reachableFrom("balanced", "idle");
    for (const state of BALANCED_WORKFLOW_STATES) expect(balancedReachable.has(state), state).toBe(true);
    const strictReachable = reachableFrom("strict", "idle");
    for (const state of STRICT_WORKFLOW_STATES) expect(strictReachable.has(state), state).toBe(true);
    for (const state of STRICT_ONLY) expect(balancedReachable.has(state), state).toBe(false);
    for (const state of BALANCED_ONLY) expect(strictReachable.has(state), state).toBe(false);
  });
});
