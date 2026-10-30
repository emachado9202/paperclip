import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ConnectionFailure } from "../connection-config.js";
import { sendChatMessage } from "../chat-flow.js";
import { hireDelegateReuse } from "./hire-delegate-flow.js";
import { hireDelegateNames } from "./hire-delegate-evidence.js";
import { JourneyError, type JourneyContext, type JourneyEvidence, type TargetSession } from "./types.js";

// These tests exercise the real journey observation/ownership path. Browser
// controls are stubs; they do not claim a live user-journey pass.
vi.mock("@playwright/test", () => ({ expect: () => ({ toBeVisible: async () => {} }) }));
vi.mock("../chat-flow.js", () => ({ sendChatMessage: vi.fn(), readChatOutputDocument: vi.fn() }));
type Row = Record<string, any>;
const directories: string[] = [];
afterEach(async () => { vi.mocked(sendChatMessage).mockReset(); await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

async function fixture(options: { readError?: Error; mutate?(agents: Row[], tasks: Row[]): void; ownError?: Error } = {}) {
  const campaignId = "journey-1-deadbeef", names = hireDelegateNames(campaignId), owned: Row[] = [], comments: Row[] = [];
  const binding = { connectionId: "approved" }, lead = { id: "lead", companyId: "company", name: "Lead", permissions: { canCreateAgents: true }, runtimeConfig: { aiConnection: binding } };
  const hire = { id: "hired", companyId: "company", name: names.hire, reportsTo: lead.id, adapterType: "paperclip_runner",
    adapterConfig: { model: "fixed-model" }, runtimeConfig: { aiConnection: binding } };
  const agents: Row[] = [lead, hire], tasks: Row[] = [];
  const chat = { id: "chat", companyId: "company", title: "Chat with Lead", assigneeAgentId: lead.id, conversationAgentId: lead.id,
    conversationUserId: "user", createdByUserId: "user", status: "in_review", conversationState: "waiting" };
  const run = { id: "lead-run", companyId: "company", agentId: lead.id, issueId: chat.id, status: "succeeded", runtimeMode: "native",
    contextSnapshot: { paperclipEnvironment: { id: "environment" } }, runnerProfileJson: { nativeExecutionInput: { provider: { kind: "opencode", model: "fixed-model" } } } };
  options.mutate?.(agents, tasks);
  const audit = (action: string, entityId: string) => ({ companyId: "company", actorType: "agent", actorId: lead.id, agentId: lead.id, runId: run.id, action, entityId });
  const activity = [audit("agent.hire_created", hire.id), ...tasks.map(task => audit("issue.created", task.id))];
  let sent = false, failedRead = false, runReads = 0;
  const stop = new JourneyError("failed", "test_stop_before_delegation");
  vi.mocked(sendChatMessage).mockImplementation(async (_page, text) => {
    if (sent) throw stop;
    sent = true; comments.push({ id: "user-comment", authorUserId: "user", body: text });
  });
  const api = { origin: "https://qa.example.test", async get(route: string) {
    if (route === "/api/instance/settings/experimental") return { enableAgentChat: true };
    if (route === "/api/companies/company") return { requireBoardApprovalForNewAgents: false };
    if (route === "/api/agents/lead") return lead;
    if (route === "/api/companies/company/chats/lead") return sent ? chat : null;
    if (route === "/api/issues/chat/runs") {
      runReads++;
      if (options.readError && !failedRead) { failedRead = true; throw options.readError; }
      return [{ runId: run.id }];
    }
    if (route === "/api/heartbeat-runs/lead-run") return run;
    if (route === "/api/companies/company/agents") return agents;
    if (route === "/api/companies/company/issues") return tasks;
    if (route === "/api/companies/company/activity?agentId=lead&limit=500") return activity;
    if (route === "/api/issues/chat/comments?order=asc") return comments;
    throw new Error(`Unexpected read ${route}`);
  }, async post(route: string) {
    expect(route).toBe("/api/companies/company/projects"); return { id: "project", companyId: "company", name: names.project };
  } };
  const context = { api, page: { async goto() {}, getByTestId() { return {}; } }, user: { id: "user" }, company: { id: "company", issuePrefix: "QA" },
    agent: { id: lead.id, model: "fixed-model", provider: "opencode", runtimeMode: "native" }, environmentId: "environment" } as unknown as JourneyContext;
  const session = { async own(row: Row) { if (row.id === hire.id && options.ownError) throw options.ownError; owned.push(row); } } as unknown as TargetSession;
  const evidence = { checks: [] } as unknown as JourneyEvidence;
  const directory = await mkdtemp(path.join(os.tmpdir(), "hire-observation-")); directories.push(directory);
  return { owned, evidence, stop, runReads: () => runReads,
    run: () => hireDelegateReuse(context, session, campaignId, evidence, { deadlineAt: Date.now() + 10_000, directory, capture: async () => {} }) };
}

it.each(["api_status_503", "api_request_failed"])("recovers a transient %s read without replaying the first user turn", async code => {
  const f = await fixture({ readError: new ConnectionFailure(code) });
  await expect(f.run()).rejects.toBe(f.stop);
  expect(f.runReads()).toBe(2);
  expect(f.evidence.checks).toContainEqual({ id: "one-attributed-native-hire", passed: true });
  expect(vi.mocked(sendChatMessage).mock.calls.filter(([, text]) => text.startsWith("Hire exactly one"))).toHaveLength(1);
});
it.each([new JourneyError("failed", "api_status_503"), new ConnectionFailure("api_status_403"), new ConnectionFailure("api_status_500"), new Error("api_request_failed")])(
  "never retries a candidate, identity, application or unknown error: %s", async readError => {
    const f = await fixture({ readError }); await expect(f.run()).rejects.toBe(readError);
    expect(f.runReads()).toBe(1); expect(sendChatMessage).toHaveBeenCalledTimes(1);
  },
);
it("never retries ownership callbacks, whose mutations may already have committed", async () => {
  const ownError = new ConnectionFailure("api_request_failed"), f = await fixture({ ownError });
  await expect(f.run()).rejects.toBe(ownError); expect(f.runReads()).toBe(1); expect(sendChatMessage).toHaveBeenCalledTimes(1);
});
it.each(["manager", "project", "foreign-company"])("owns proven same-company children before rejecting a %s scope mismatch", async mismatch => {
  const f = await fixture({ mutate(agents, tasks) {
    if (mismatch === "manager") agents[1]!.reportsTo = "other";
    else tasks.push({ id: "unexpected-task", companyId: mismatch === "foreign-company" ? "foreign" : "company",
      title: "Unexpected task", projectId: "other-project" });
  } });
  await expect(f.run()).rejects.toMatchObject({ code: "hire_resource_scope_mismatch" });
  expect(f.owned.some(row => row.id === "hired")).toBe(true);
  expect(f.owned.some(row => row.id === "unexpected-task")).toBe(mismatch === "project");
  expect(sendChatMessage).toHaveBeenCalledTimes(1);
});
