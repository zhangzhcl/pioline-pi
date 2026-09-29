import { describe, expect, it } from "vitest";
import { explicitlyRequestsWorkflow } from "./workflow-intent.js";

describe("explicit workflow intent detection", () => {
  it.each([
    ["我需要用工作流分析这批数据", true],
    ["请帮我创建一个工作流来处理日报", true],
    ["Use a workflow to process these files", true],
    ["I need a workflow for this task", true],
    ["帮我修复 TypeScript 编译错误", false],
    ["工作流是什么？", false],
    ["能不能用工作流处理这批数据？", false],
    ["工作流能否处理这批数据？", false],
    ["请用工作流处理这批数据", true],
    ["How do workflows work?", false],
    ["Can we use a workflow for this?", false],
    ["Could I use the workflow mode here?", false],
    ["Please use the workflow for this task", true],
    ["不要使用工作流，直接修复这个函数", false],
    ["Please don't use a workflow for this change", false],
  ])("classifies %j as workflow intent: %s", (message, expected) => {
    expect(explicitlyRequestsWorkflow(message)).toBe(expected);
  });
});
