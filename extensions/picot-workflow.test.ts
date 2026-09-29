// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { registerPicotWorkflowTools } from "./picot-workflow.ts";

type WorkflowToolForTest = {
  promptGuidelines?: string[];
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    context: unknown,
  ) => Promise<{ content: Array<{ type: string; text: string }> }>;
};

describe("Pipline workflow tools remain opt-in", () => {
  it("keeps ordinary sessions unchanged until workflow mode is enabled", async () => {
    let activeTools = ["read", "bash"];
    const listeners = new Map<string, () => void>();
    const commands = new Map<string, (rawArguments: string) => Promise<void>>();
    const registeredTools: string[] = [];
    const pi = {
      getActiveTools: vi.fn(() => activeTools),
      setActiveTools: vi.fn((next: string[]) => {
        activeTools = next;
      }),
      on: vi.fn((event: string, listener: () => void) => listeners.set(event, listener)),
      registerCommand: vi.fn(
        (name: string, command: { handler: (rawArguments: string) => Promise<void> }) =>
          commands.set(name, command.handler),
      ),
      registerTool: vi.fn((tool: { name: string }) => registeredTools.push(tool.name)),
    };

    registerPicotWorkflowTools(pi as never);
    expect(registeredTools).toEqual(["pipline_workflow"]);
    expect(activeTools).toEqual(["read", "bash"]);
    expect(pi.setActiveTools).not.toHaveBeenCalled();

    listeners.get("session_start")?.();
    expect(activeTools).toEqual(["read", "bash"]);

    await commands.get("pipline-workflow-mode")?.(" ON ");
    expect(activeTools).toEqual(["read", "bash", "pipline_workflow"]);

    listeners.get("session_start")?.();
    expect(activeTools).toEqual(["read", "bash"]);

    await commands.get("pipline-workflow-mode")?.("off");
    expect(activeTools).toEqual(["read", "bash"]);

    await commands.get("pipline-workflow-mode")?.("unexpected");
    expect(activeTools).toEqual(["read", "bash"]);
  });

  it("clearly distinguishes inert implementation drafts from executable source", () => {
    const registeredTools: unknown[] = [];
    const pi = {
      getActiveTools: () => [],
      setActiveTools: () => {},
      on: () => {},
      registerCommand: () => {},
      registerTool: (tool: unknown) => registeredTools.push(tool),
    };
    registerPicotWorkflowTools(pi as never);
    const workflowTool = registeredTools[0] as WorkflowToolForTest | undefined;
    const guidance = workflowTool?.promptGuidelines?.join("\n") ?? "";

    expect(guidance).toContain("implementationDraft.source is optional inert documentation");
    expect(guidance).toContain("never claim it can be executed");
    expect(guidance).not.toContain("Never propose runnable source code.");
  });

  it("forwards revision-bound proposals to the desktop and returns its approval result", async () => {
    const registeredTools: unknown[] = [];
    const pi = {
      getActiveTools: () => [],
      setActiveTools: () => {},
      on: () => {},
      registerCommand: () => {},
      registerTool: (tool: unknown) => registeredTools.push(tool),
    };
    registerPicotWorkflowTools(pi as never);
    const workflowTool = registeredTools[0] as WorkflowToolForTest | undefined;
    if (!workflowTool) throw new Error("Workflow tool was not registered");

    const desktopRequest = {
      requestId: "desktop-request",
      ok: true,
      applied: true,
      revision: 12,
    };
    let dialogTitle = "";
    let dialogPrompt = "";
    const result = await workflowTool.execute(
      "tool-call",
      {
        operation: "propose",
        baseRevision: 11,
        expectedCatalogRevision: "catalog-r5",
        operations: [
          {
            type: "add_node",
            node: {
              instanceId: "agent-node",
              meta: { id: "pipline.assign", version: "2.0.0" },
              position: { x: 320, y: 120 },
              paramValues: { varName: "answer" },
              portValues: {},
            },
          },
          { type: "clear_input", instanceId: "agent-node", name: "context" },
        ],
      },
      undefined,
      undefined,
      {
        hasUI: true,
        ui: {
          input: async (title: string, prompt: string) => {
            dialogTitle = title;
            dialogPrompt = prompt;
            const request = JSON.parse(prompt.slice("__PIPLINE_WORKFLOW_TOOL_V1__".length));
            expect(request).toMatchObject({
              operation: "propose",
              baseRevision: 11,
              expectedCatalogRevision: "catalog-r5",
              operations: [
                { type: "add_node", node: { instanceId: "agent-node" } },
                { type: "clear_input", instanceId: "agent-node", name: "context" },
              ],
            });
            return JSON.stringify(desktopRequest);
          },
        },
      },
    );

    expect(dialogTitle).toBe("Pipline workflow bridge");
    expect(dialogPrompt).toContain("__PIPLINE_WORKFLOW_TOOL_V1__");
    expect(result.content).toEqual([{ type: "text", text: JSON.stringify(desktopRequest) }]);
  });

  it("forwards the complete localized NodeMeta candidate to desktop approval", async () => {
    const registeredTools: unknown[] = [];
    const pi = {
      getActiveTools: () => [],
      setActiveTools: () => {},
      on: () => {},
      registerCommand: () => {},
      registerTool: (tool: unknown) => registeredTools.push(tool),
    };
    registerPicotWorkflowTools(pi as never);
    const workflowTool = registeredTools[0] as WorkflowToolForTest | undefined;
    if (!workflowTool) throw new Error("Workflow tool was not registered");

    const meta = {
      schemaVersion: 1,
      id: "custom.slugify",
      version: "1.0.0",
      type: "custom",
      label: "Slugify",
      description: "Convert text into a URL slug.",
      inputs: [{ name: "text", label: "Text", type: "string", allowStaticValue: true }],
      outputs: [{ name: "slug", label: "Slug", type: "string" }],
      params: [],
      execution: { kind: "user-code", entrypoint: "slugify" },
      permissions: { filesystem: "none", network: "none", shell: "none" },
      implementationDraft: {
        language: "typescript",
        source: "export function slugify(text: string) { return text.toLowerCase(); }",
        entryFn: "slugify",
      },
      i18n: Object.fromEntries(
        ["en", "zh", "es", "ja"].map((locale) => [
          locale,
          {
            label: `Slugify ${locale}`,
            description: `Convert text ${locale}.`,
            inputs: { text: `Text ${locale}` },
            outputs: { slug: `Slug ${locale}` },
            params: {},
          },
        ]),
      ),
    };
    let dialogPrompt = "";
    const desktopApproval = { ok: true, meta: { id: meta.id, version: meta.version } };

    const result = await workflowTool.execute(
      "candidate-call",
      {
        operation: "propose_node_meta",
        expectedCatalogRevision: "catalog-r7",
        meta,
      },
      undefined,
      undefined,
      {
        hasUI: true,
        ui: {
          input: async (_title: string, prompt: string) => {
            dialogPrompt = prompt;
            const request = JSON.parse(prompt.slice("__PIPLINE_WORKFLOW_TOOL_V1__".length));
            expect(request).toMatchObject({
              operation: "propose_node_meta",
              expectedCatalogRevision: "catalog-r7",
              meta,
            });
            return JSON.stringify(desktopApproval);
          },
        },
      },
    );

    expect(dialogPrompt).toContain("__PIPLINE_WORKFLOW_TOOL_V1__");
    expect(result.content).toEqual([{ type: "text", text: JSON.stringify(desktopApproval) }]);
  });

  it("surfaces desktop rejection without reporting that the proposal was applied", async () => {
    const registeredTools: unknown[] = [];
    const pi = {
      getActiveTools: () => [],
      setActiveTools: () => {},
      on: () => {},
      registerCommand: () => {},
      registerTool: (tool: unknown) => registeredTools.push(tool),
    };
    registerPicotWorkflowTools(pi as never);
    const workflowTool = registeredTools[0] as WorkflowToolForTest | undefined;
    if (!workflowTool) throw new Error("Workflow tool was not registered");

    await expect(
      workflowTool.execute(
        "tool-call",
        { operation: "propose", baseRevision: 3, expectedCatalogRevision: "stale" },
        undefined,
        undefined,
        {
          hasUI: true,
          ui: { input: async () => JSON.stringify({ ok: false, error: "Approval declined" }) },
        },
      ),
    ).rejects.toThrow("Approval declined");
  });
});
