import { mkdir, writeFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import path from "node:path";
import { expect } from "@playwright/test";
import { sendChatMessage, readChatOutputDocument, type ChatIssue, type ChatRun } from "../chat-flow.js";
import { assertChatHire, mutableIssueSnapshot } from "../chat-hardening.js";
import { assertHireAuditCoverage, assertHireBinding, assertHireDocument, assertHireRuns, hireDelegateNames, hireRunIssueId, observedHireResources, type HireScope } from "./hire-delegate-evidence.js";
import { JourneyError, type JourneyContext, type JourneyEvidence, type TargetSession } from "./types.js";

type Row = Record<string, any>;
type Agent = Parameters<typeof assertChatHire>[0]["agents"][number] & Row;
type Task = ChatIssue & Row;
type Run = ChatRun & Row;
interface Options { deadlineAt: number; directory: string; capture(id: string, label: string, file: string): Promise<void> }

/** The same native hiring/document oracles used by classic Agent Chat, on an attached deployment. */
export async function hireDelegateReuse(context: JourneyContext, session: TargetSession, campaignId: string, evidence: JourneyEvidence, options: Options) {
  const { api, page } = context, agent = context.agent;
  if (!agent || agent.runtimeMode !== "native" || !context.environmentId) throw new JourneyError("unsupported", "native_agent_and_environment_required");
  const features = await api.get<Row>("/api/instance/settings/experimental");
  if (features.enableAgentChat !== true) throw new JourneyError("unsupported", "agent_chat_required");
  const company = await api.get<Row>(`/api/companies/${context.company.id}`);
  if (company.requireBoardApprovalForNewAgents !== false) throw new JourneyError("unsupported", "automatic_hiring_policy_required");
  const lead = await api.get<Row>(`/api/agents/${agent.id}`), names = hireDelegateNames(campaignId);
  if (lead.companyId !== context.company.id || lead.permissions?.canCreateAgents !== true || !lead.runtimeConfig?.aiConnection) {
    throw new JourneyError("unsupported", "owned_hiring_agent_required");
  }
  const check = (id: string, passed = true) => { evidence.checks.push({ id, passed }); if (!passed) throw new JourneyError("failed", id.replaceAll("-", "_")); };
  await mkdir(options.directory, { recursive: true, mode: 0o700 });
  const retain = (name: string, value: unknown) => writeFile(path.join(options.directory, name), JSON.stringify(value, null, 2), { mode: 0o600 });
  await session.own({ kind: "project", name: names.project, journeyId: "hire-delegate-reuse" });
  const project = await api.post<Row>(`/api/companies/${context.company.id}/projects`, { name: names.project, description: "Disposable native hiring and delegation verification." });
  if (project.companyId !== context.company.id || !project.id || project.name !== names.project) throw new JourneyError("failed", "hire_project_binding_mismatch");
  await session.own({ kind: "project", name: names.project, id: project.id, journeyId: "hire-delegate-reuse" });
  const chatPath = `/api/companies/${context.company.id}/chats/${agent.id}`;
  if (await api.get(chatPath)) throw new JourneyError("unsupported", "fresh_lead_chat_required");
  const chatUrl = `${api.origin}/${context.company.issuePrefix}/chats/${agent.id}`;
  await page.goto(chatUrl, { waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("task-chat-composer-input")).toBeVisible();
  let scope: HireScope | undefined, hiredId: string | undefined;
  const known = new Set<string>();
  const taskNames = [names.checklist, names.review];
  const readRuns = async (issueId: string) => {
    const summaries = await api.get<Row[]>(`/api/issues/${issueId}/runs`);
    if (!Array.isArray(summaries) || summaries.length > 5) throw new JourneyError("failed", "hire_run_limit_mismatch");
    return Promise.all(summaries.map(row => api.get<Run>(`/api/heartbeat-runs/${row.runId}`)));
  };
  const observe = async () => {
    const chat = await api.get<Row | null>(chatPath);
    if (!chat) return undefined;
    if (chat.companyId !== context.company.id || chat.assigneeAgentId !== agent.id
      || chat.conversationAgentId !== agent.id || chat.conversationUserId !== context.user.id || chat.createdByUserId !== context.user.id) throw new JourneyError("failed", "hire_chat_scope_mismatch");
    scope ??= { companyId: context.company.id, leadId: agent.id, chatId: chat.id, projectId: project.id, campaignId,
      model: agent.model, provider: agent.provider, environmentId: context.environmentId!, connectionBinding: lead.runtimeConfig.aiConnection };
    if (chat.id !== scope.chatId) throw new JourneyError("failed", "hire_chat_replaced");
    if (!known.has(chat.id)) { await session.own({ kind: "issue", name: chat.title, id: chat.id, journeyId: "hire-delegate-reuse" }); known.add(chat.id); }
    const [leadRuns, agents, tasks, activity] = await Promise.all([readRuns(chat.id),
      api.get<Agent[]>(`/api/companies/${context.company.id}/agents`), api.get<Task[]>(`/api/companies/${context.company.id}/issues`),
      api.get<Row[]>(`/api/companies/${context.company.id}/activity?agentId=${agent.id}&limit=500`)]);
    assertHireAuditCoverage(activity, leadRuns);
    const owned = observedHireResources(scope, { agents, tasks, activity, leadRuns });
    for (const row of [...owned.agents.map(agent => ({ id: agent.id, kind: "agent" as const, resourceName: agent.name })),
      ...owned.tasks.map(task => ({ id: task.id, kind: "issue" as const, resourceName: task.title }))]) {
      // Register even unexpected campaign-owned children so failure cleanup can retire them.
      if (!known.has(row.id)) {
        await session.own({ kind: row.kind, name: row.resourceName, id: row.id, journeyId: "hire-delegate-reuse" }); known.add(row.id);
      }
    }
    if (owned.agents.length) hiredId = assertHireBinding(scope, owned.agents, hiredId).id;
    const runs = [...leadRuns, ...(await Promise.all(owned.tasks.map(task => readRuns(task.id)))).flat()];
    assertHireRuns(scope, hiredId, owned.tasks, runs);
    await retain("hire-delegate-observation.json", { scope: { ...scope, connectionBinding: undefined }, chat, project,
      agents: owned.agents.map(row => ({ id: row.id, name: row.name, reportsTo: row.reportsTo })), tasks: owned.tasks,
      runs: runs.map(run => ({ id: run.id, issueId: hireRunIssueId(run), agentId: run.agentId, status: run.status })) });
    return { chat, ...owned, runs, allAgents: agents, activity };
  };
  const waitForIdle = async (count: number) => {
    while (Date.now() < options.deadlineAt) {
      const state = await observe();
      if (state && state.runs.length === count && state.runs.every(run => run.status === "succeeded")
        && state.chat.status === "in_review" && state.chat.conversationState === "waiting") return state;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    throw new JourneyError("failed", "hire_chat_not_completed");
  };
  const turn = async (text: string, count: number) => {
    await page.goto(chatUrl, { waitUntil: "domcontentloaded" });
    const before = await api.get<Row | null>(chatPath);
    const prior = before ? await api.get<Row[]>(`/api/issues/${before.id}/comments?order=asc`) : [];
    await sendChatMessage(page, text);
    const state = await waitForIdle(count);
    const comments = await api.get<Row[]>(`/api/issues/${state.chat.id}/comments?order=asc`);
    const added = comments.filter(row => row.authorUserId === context.user.id && !prior.some(old => old.id === row.id));
    check("hire-user-messages-stored-once", added.length === 1 && added[0].body === text);
    return state;
  };
  // Hire first. The private adapter prepares this exact owned teammate's budget before delegation.
  await session.own({ kind: "agent", name: names.hire, journeyId: "hire-delegate-reuse" });
  let state = await turn(`Hire exactly one teammate named ${names.hire}, reporting to you, using your native runner, model, and available AI connection. Do not create or start any tasks yet. Tell me when this teammate is ready.`, 1);
  const hired = assertHireBinding(scope!, state.agents);
  check("one-attributed-native-hire", state.tasks.length === 0);
  const marker = `HIRE${campaignId.replace(/[^a-z0-9]/gi, "")}`;
  await session.own({ kind: "issue", name: names.checklist, journeyId: "hire-delegate-reuse" });
  state = await turn(`Have the existing ${names.hire} write a concise launch checklist as a saved Paperclip document with the line "Reference: ${marker}". Create exactly one task titled ${names.checklist} in ${names.project}, assigned to that teammate. Link the result here and let the teammate complete it. Do not hire another agent.`, 3);
  const first = state.tasks.find(task => task.title === names.checklist);
  check("first-delegated-task-complete", typeof first?.identifier === "string" && state.tasks.length === 1);
  const readOutput = async (task: Row, token: string, runs: Row[]) => {
    const document = await readChatOutputDocument(api, task.id, token);
    const revisions = await api.get<Row[]>(`/api/issues/${task.id}/documents/${encodeURIComponent(document.key)}/revisions`);
    assertHireDocument(scope!, task, document, revisions, runs, token, hired.id);
    return document;
  };
  const firstOutput = await readOutput(first!, marker, state.runs);
  const originalTask = mutableIssueSnapshot(await api.get<Task>(`/api/issues/${first!.id}`));
  check("checklist-authored-by-hired-run");
  await session.own({ kind: "issue", name: names.review, journeyId: "hire-delegate-reuse" });
  state = await turn(`Have the existing ${names.hire} review the checklist on ${first!.identifier} and write a separate saved review document with the line "Reference: REVIEW${marker}". Create exactly one task titled ${names.review} in ${names.project}, assigned to that same teammate. Include the actual checklist in the handoff. Preserve the original checklist and task. Link the completed review here. Do not hire another agent.`, 5);
  const second = state.tasks.find(task => task.title === names.review);
  check("same-teammate-reused", typeof second?.identifier === "string" && state.tasks.length === 2 && state.tasks.every(task => taskNames.includes(task.title)));
  const reviewOutput = await readOutput(second!, `REVIEW${marker}`, state.runs);
  check("review-authored-by-same-hired-run");
  check("original-checklist-preserved", isDeepStrictEqual(await api.get(`/api/issues/${first!.id}/documents/${encodeURIComponent(firstOutput.key)}`), firstOutput)
    && isDeepStrictEqual(mutableIssueSnapshot(await api.get<Task>(`/api/issues/${first!.id}`)), originalTask));
  const binding = lead.runtimeConfig.aiConnection;
  assertChatHire({ agents: state.allAgents, leadId: agent.id, hireName: names.hire, hiredId: hired.id,
    connectionId: binding.connectionId, binding, taskIds: [first!.id, second!.id], tasks: state.tasks, runs: state.runs });
  assertHireRuns(scope!, hired.id, state.tasks, state.runs, 5);
  await page.goto(chatUrl, { waitUntil: "domcontentloaded" }); await page.reload();
  const comments = await api.get<Row[]>(`/api/issues/${state.chat.id}/comments?order=asc`);
  let resultLink: string | undefined;
  for (const comment of comments.filter(row => row.authorAgentId === agent.id)) {
    const reply = page.locator(`[id=${JSON.stringify(`comment-${comment.id}`)}]`);
    if (!await reply.isVisible()) continue;
    const links = await reply.locator("a[href]").evaluateAll(elements => elements.map(element => element.getAttribute("href")!));
    resultLink ??= links.find(href => {
      const url = new URL(href, api.origin), parts = url.pathname.split("/");
      return url.origin === api.origin && parts.length === 4 && parts[1] === context.company.issuePrefix
        && parts[2] === "issues" && [second!.id, second!.identifier].includes(parts[3]);
    });
    if (resultLink) {
      await reply.locator(`a[href=${JSON.stringify(resultLink)}]`).first().click();
      await page.reload();
      await expect(page).toHaveURL(url => url.origin === api.origin
        && [second!.id, second!.identifier].some(id => url.pathname === `/${context.company.issuePrefix}/issues/${id}`));
      await expect(page.getByTestId("issue-detail-header").getByRole("heading", { name: second!.title, exact: true })).toBeVisible();
      break;
    }
  }
  check("delegated-result-visible-after-reload", Boolean(resultLink));
  check("configured-model-and-environment");
  await retain("hire-delegate-completed.json", { hiredId: hired.id, firstTaskId: first!.id, secondTaskId: second!.id,
    firstDocument: firstOutput, reviewDocument: reviewOutput, runIds: state.runs.map(run => run.id) });
  // The saved chat link opened this exact owned child task.
  await options.capture("hire-delegate-reuse", "Hired teammate completed and reused", "hire-delegate-reuse.png");
}
