import { describe, expect, it } from "vitest";
import {
  assistantTextOf,
  splitFinalAssistantBlocks,
  summarizeMessageRoles,
  textFromMessageContent,
  textFromResult,
} from "./chat-history-renderer.js";

describe("chat-history-renderer helpers", () => {
  it("counts message roles accurately", () => {
    expect(
      summarizeMessageRoles([
        { role: "user" },
        { role: "assistant" },
        { role: "assistant" },
        { role: "toolResult" },
      ]),
    ).toEqual({
      user: 1,
      assistant: 2,
      toolResult: 1,
    });
  });

  it("splits final assistant blocks into processBlocks and answerBlocks", () => {
    const blocks = [
      { type: "thinking", thinking: "plan" },
      { type: "text", text: "Checking file" },
      { type: "toolCall", id: "tc-1", name: "read" },
      { type: "text", text: "Final answer line 1" },
      { type: "text", text: "Final answer line 2" },
    ];
    expect(splitFinalAssistantBlocks(blocks)).toEqual({
      processBlocks: blocks.slice(0, 3),
      answerBlocks: blocks.slice(3),
    });
    expect(assistantTextOf(blocks.slice(3))).toBe("Final answer line 1\nFinal answer line 2");
  });

  it("extracts text from tool result and user message content", () => {
    expect(
      textFromResult({
        content: [
          { type: "text", text: "line 1" },
          { type: "image", data: "..." },
          { type: "text", text: "line 2" },
        ],
      }),
    ).toBe("line 1\nline 2");
    expect(textFromMessageContent("  hello pipline  ")).toBe("hello pipline");
    expect(textFromMessageContent([{ type: "text", text: "  structured prompt  " }])).toBe(
      "structured prompt",
    );
  });
});
