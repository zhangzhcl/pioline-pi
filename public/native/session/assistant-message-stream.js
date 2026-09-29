function createEmptyAssistantMessage() {
  return { role: "assistant", content: [] };
}

const MAX_TOOL_CALL_ARGUMENT_BYTES = 1024 * 1024;

function cloneMessage(message) {
  if (message?.role !== "assistant") return createEmptyAssistantMessage();
  return {
    ...message,
    content: Array.isArray(message.content)
      ? structuredClone(message.content)
      : message.content || [],
  };
}

function ensureBlock(content, index, type) {
  const existing = content[index];
  if (existing?.type === type) return existing;

  const block =
    type === "thinking"
      ? { type: "thinking", thinking: "" }
      : type === "toolCall"
        ? { type: "toolCall", id: "", name: "", arguments: {} }
        : { type: "text", text: "" };
  content[index] = block;
  return block;
}

function applyDelta(message, event, toolCallArgumentBuffers) {
  const delta = event?.assistantMessageEvent;
  if (!delta || !Number.isInteger(delta.contentIndex) || delta.contentIndex < 0) return message;

  const content = message.content;
  switch (delta.type) {
    case "text_start":
      ensureBlock(content, delta.contentIndex, "text");
      break;
    case "text_delta": {
      const block = ensureBlock(content, delta.contentIndex, "text");
      block.text += delta.delta ?? "";
      break;
    }
    case "text_end": {
      const block = ensureBlock(content, delta.contentIndex, "text");
      if (typeof delta.content === "string") block.text = delta.content;
      break;
    }
    case "thinking_start":
      ensureBlock(content, delta.contentIndex, "thinking");
      break;
    case "thinking_delta": {
      const block = ensureBlock(content, delta.contentIndex, "thinking");
      block.thinking += delta.delta ?? "";
      break;
    }
    case "thinking_end": {
      const block = ensureBlock(content, delta.contentIndex, "thinking");
      if (typeof delta.content === "string") block.thinking = delta.content;
      break;
    }
    case "toolcall_start": {
      const block = ensureBlock(content, delta.contentIndex, "toolCall");
      if (typeof delta.id === "string") block.id = delta.id;
      if (typeof delta.toolName === "string") block.name = delta.toolName;
      toolCallArgumentBuffers.set(delta.contentIndex, "");
      break;
    }
    case "toolcall_delta": {
      const block = ensureBlock(content, delta.contentIndex, "toolCall");
      if (typeof delta.delta !== "string" || toolCallArgumentBuffers.get(delta.contentIndex) === null)
        break;
      const partial = `${toolCallArgumentBuffers.get(delta.contentIndex) ?? ""}${delta.delta}`;
      if (new TextEncoder().encode(partial).byteLength > MAX_TOOL_CALL_ARGUMENT_BYTES) {
        toolCallArgumentBuffers.set(delta.contentIndex, null);
        break;
      }
      toolCallArgumentBuffers.set(delta.contentIndex, partial);
      try {
        const args = JSON.parse(partial);
        if (args && typeof args === "object" && !Array.isArray(args)) block.arguments = args;
      } catch {
        // Provider chunks can end in the middle of a JSON token. Keep the last
        // complete object until another chunk makes the buffer parseable.
      }
      break;
    }
    case "toolcall_end":
      if (delta.toolCall) content[delta.contentIndex] = structuredClone(delta.toolCall);
      toolCallArgumentBuffers.delete(delta.contentIndex);
      break;
  }
  if (event.usage) message.usage = structuredClone(event.usage);
  return message;
}

/** Assemble Pi's delta-only message_update protocol into a live assistant message. */
export function createAssistantMessageStream() {
  let message = null;
  const toolCallArgumentBuffers = new Map();

  return {
    start(initialMessage) {
      toolCallArgumentBuffers.clear();
      message = cloneMessage(initialMessage);
      return structuredClone(message);
    },
    update(event) {
      message = applyDelta(
        message ?? createEmptyAssistantMessage(),
        event,
        toolCallArgumentBuffers,
      );
      return structuredClone(message);
    },
    finish(finalMessage) {
      const completed = cloneMessage(finalMessage ?? message);
      message = null;
      toolCallArgumentBuffers.clear();
      return completed;
    },
    reset() {
      message = null;
      toolCallArgumentBuffers.clear();
    },
    current() {
      return message ? structuredClone(message) : null;
    },
  };
}
