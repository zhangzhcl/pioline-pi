// ABOUTME: Detects explicit user requests to enter workflow mode without
// changing the behavior of ordinary Pi prompts.

const NEGATED_WORKFLOW_REQUEST =
  /(?:不要|不想|不需要|无需|别|禁止|不能|不可).{0,12}(?:使用|用|开启|启用|创建|生成|构建)?\s*工作流/;
const NEGATED_ENGLISH_WORKFLOW_REQUEST =
  /\b(?:don't|do not|never|without)\s+(?:use|enable|open|switch to|create|build|design|run|start)(?:\s+(?:a\s+|the\s+)?)workflow\b/i;
const WORKFLOW_QUESTION =
  /(?:^(?:.*(?:如何|怎么|为什么|是否|我想知道).{0,24}工作流))|(?:工作流.{0,16}(?:如何|怎么|是什么|吗|呢)[？?]?$)/;
const ENGLISH_WORKFLOW_QUESTION =
  /^(?:how|what|why|when|where)\b|^do\s+(?:i|we)\s+(?:need|have)\b|^(?:can|could|should|would)\s+(?:i|we)\s+(?:use|open|switch to|run)\s+(?:(?:a|the)\s+)?workflow\b/i;
const CHINESE_WORKFLOW_REQUEST =
  /(?:我想(?:要)?|我需要|我希望|需要|请|帮我|我要|让 Pi|让你)?\s*(?:用|使用|开启|启用|进入|切换到)\s*(?:一个|这个)?\s*工作流(?:模式|画布)?/;
const CHINESE_WORKFLOW_ACTION_REQUEST =
  /(?:我想(?:要)?|我需要|我希望|我们需要|我们要|请|帮我|我要)?\s*(?:创建|生成|构建|设计|编排|做|搭建|制作|运行|启动)\s*(?:一个|个|这份|该|一套)?\s*工作流/;
const CHINESE_WORKFLOW_NEED =
  /(?:我想要|我需要|我希望|我们需要|我们想要|给我来一个)\s*(?:一个|个|一套)?\s*工作流/;
const ENGLISH_WORKFLOW_REQUEST =
  /(?:use|enable|open|switch to|create|build|design|run|start)\s+(?:a\s+|the\s+)?workflow(?:\s+mode)?/i;
const ENGLISH_WORKFLOW_NEED = /(?:i need|i want|we need|we want)\s+(?:a\s+|the\s+)?workflow\b/i;

export function explicitlyRequestsWorkflow(text) {
  const message = String(text ?? "").trim();
  if (
    !message ||
    WORKFLOW_QUESTION.test(message) ||
    ENGLISH_WORKFLOW_QUESTION.test(message) ||
    NEGATED_WORKFLOW_REQUEST.test(message) ||
    NEGATED_ENGLISH_WORKFLOW_REQUEST.test(message)
  )
    return false;
  return (
    CHINESE_WORKFLOW_REQUEST.test(message) ||
    CHINESE_WORKFLOW_ACTION_REQUEST.test(message) ||
    CHINESE_WORKFLOW_NEED.test(message) ||
    ENGLISH_WORKFLOW_REQUEST.test(message) ||
    ENGLISH_WORKFLOW_NEED.test(message)
  );
}
