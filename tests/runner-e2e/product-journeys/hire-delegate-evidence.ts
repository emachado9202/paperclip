import { isDeepStrictEqual } from "node:util";
import { JourneyError } from "./types.js";

type Row = Record<string, any>;
export const HIRE_DELEGATE_JOURNEY = "hire-delegate-reuse" as const;
export function hireDelegateNames(campaignId: string) {
  return { project: `Journey QA hire-delegate-reuse ${campaignId}`, hire: `Morgan Reviewer ${campaignId}`,
    checklist: `Checklist ${campaignId}`, review: `Review ${campaignId}` };
}
export interface HireScope {
  companyId: string; leadId: string; chatId: string; projectId: string; campaignId: string;
  model: string; provider: string; environmentId: string; connectionBinding: unknown;
}
export const hireRunIssueId = (run: Row) => run.issueId ?? run.nativeIssueId ?? run.contextSnapshot?.issueId ?? run.contextSnapshot?.taskId;

/** Exclude unrelated work in a persistent company; require the real native actor's audit. */
export function observedHireResources<A extends Row, T extends Row>(scope: HireScope, state: { agents: A[]; tasks: T[]; activity: Row[]; leadRuns: Row[] }) {
  const names = hireDelegateNames(scope.campaignId);
  const authored = (row: Row, actions: string[]) => state.activity.some(event => event.companyId === scope.companyId
    && event.actorType === "agent" && event.actorId === scope.leadId && event.agentId === scope.leadId
    && event.entityId === row.id && actions.includes(event.action)
    && state.leadRuns.some(run => run.id === event.runId && run.agentId === scope.leadId
      && run.companyId === scope.companyId && hireRunIssueId(run) === scope.chatId));
  const agents = state.agents.filter(agent => authored(agent, ["agent.hire_created", "agent.created"]));
  const tasks = state.tasks.filter(task => authored(task, ["issue.created", "issue.child_created"]));
  if (agents.some(agent => agent.companyId !== scope.companyId || agent.reportsTo !== scope.leadId)
    || tasks.some(task => task.companyId !== scope.companyId || task.projectId !== scope.projectId)) {
    throw new JourneyError("failed", "hire_resource_scope_mismatch");
  }
  // Retain unexpected native-created resources for cleanup. They cannot satisfy the oracle.
  return { agents, tasks, hires: agents.filter(agent => agent.name === names.hire),
    expectedTasks: tasks.filter(task => [names.checklist, names.review].includes(task.title)) };
}
export function assertHireBinding(scope: HireScope, agents: Row[], hiredId?: string) {
  const names = hireDelegateNames(scope.campaignId);
  const hires = agents.filter(agent => agent.name === names.hire);
  if (agents.length !== 1 || hires.length !== 1) throw new JourneyError("failed", "exactly_one_native_hire_required");
  const hired = hires[0]!;
  if (hired.id === scope.leadId || hiredId && hired.id !== hiredId || hired.companyId !== scope.companyId
    || hired.reportsTo !== scope.leadId || hired.adapterType !== "paperclip_runner" || hired.adapterConfig?.model !== scope.model
    || !scope.connectionBinding || !isDeepStrictEqual(hired.runtimeConfig?.aiConnection, scope.connectionBinding)) {
    throw new JourneyError("failed", "hire_native_binding_mismatch");
  }
  return hired;
}
export function assertHireRuns(scope: HireScope, hiredId: string | undefined, tasks: Row[], runs: Row[], count?: number) {
  const bindings = new Map([[scope.chatId, scope.leadId], ...tasks.map(task => [task.id, hiredId] as [string, string | undefined])]);
  if (runs.length > 5 || count !== undefined && runs.length !== count || new Set(runs.map(run => run.id)).size !== runs.length) {
    throw new JourneyError("failed", "hire_run_limit_mismatch");
  }
  for (const run of runs) {
    const issueId = hireRunIssueId(run), provider = run.runnerProfileJson?.nativeExecutionInput?.provider;
    if (!bindings.has(issueId) || !bindings.get(issueId) || run.companyId !== scope.companyId || run.agentId !== bindings.get(issueId)) {
      throw new JourneyError("failed", "hire_run_scope_mismatch");
    }
    if (!["queued", "running", "succeeded"].includes(run.status)) throw new JourneyError("failed", "hire_native_run_failed");
    if (run.status === "succeeded" && (run.runtimeMode !== "native" || provider?.kind !== scope.provider || provider?.model !== scope.model
      || run.contextSnapshot?.paperclipEnvironment?.id !== scope.environmentId)) throw new JourneyError("failed", "hire_run_runtime_mismatch");
  }
}
export function assertHireDocument(scope: HireScope, task: Row, document: Row, revisions: Row[], runs: Row[], marker: string, hiredId: string) {
  const work = runs.filter(run => hireRunIssueId(run) === task.id);
  const revision = revisions.find(row => row.id === document.latestRevisionId);
  if (task.companyId !== scope.companyId || task.assigneeAgentId !== hiredId || task.status !== "done" || task.projectId !== scope.projectId
    || work.length !== 1 || work[0]?.status !== "succeeded" || document.issueId !== task.id || document.companyId !== scope.companyId
    || document.key === "plan" || !document.body?.includes(marker) || !revision || revision.body !== document.body
    || revision.createdByAgentId !== hiredId || revision.createdByRunId !== work[0]?.id) {
    throw new JourneyError("failed", "hired_document_provenance_mismatch");
  }
}
