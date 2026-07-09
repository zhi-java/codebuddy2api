// src/utils.ts
var PROMPT_ROLES = /* @__PURE__ */ new Set(["system", "developer"]);
var SYSTEM_TEXT_REPLACEMENTS = [
  [
    /You\s+are\s+Claude\s+Code,\s*Anthropic['’]s\s+official\s+CLI\s+for\s+Claude\.?/gi,
    "You are CodeBuddy, Tencent's official CLI."
  ],
  [
    /main\s+branch\s+\(you\s+will\s+usually\s+use\s+this\s+for\s+prs\)/gi,
    "main branch (you will usually use this for pr)"
  ]
];
var MODEL_SUFFIX_PATTERN = /^(.+)\[[^\]]+\]$/;
function replaceSystemText(text) {
  let result = text;
  for (const [pattern, replacement] of SYSTEM_TEXT_REPLACEMENTS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}
function normalizeModelId(modelId) {
  const trimmed = modelId.trim();
  const match = trimmed.match(MODEL_SUFFIX_PATTERN);
  return match ? match[1].trim() : trimmed;
}
function rewritePayload(payload) {
  if (typeof payload["model"] === "string") {
    payload["model"] = normalizeModelId(payload["model"]);
  }
  const messages = payload["messages"];
  if (!Array.isArray(messages)) return payload;
  for (const message of messages) {
    if (!message || typeof message !== "object" || !PROMPT_ROLES.has(String(message["role"]))) continue;
    const content = message["content"];
    if (typeof content === "string") {
      message["content"] = replaceSystemText(content);
      continue;
    }
    if (Array.isArray(content)) {
      for (const part of content) {
        if (part && typeof part === "object" && part["type"] === "text" && typeof part["text"] === "string") {
          part["text"] = replaceSystemText(part["text"]);
        }
      }
    }
  }
  return payload;
}
var DEBUG_TRUE_VALUES = /* @__PURE__ */ new Set(["1", "true", "yes", "on"]);
function parseDebugValue(val) {
  if (!val) return false;
  return DEBUG_TRUE_VALUES.has(val.toLowerCase());
}
function isDebugEnabled(env) {
  return parseDebugValue(env.DEBUG);
}
var SENSITIVE_HEADERS = /* @__PURE__ */ new Set(["authorization", "cookie", "proxy-authorization", "set-cookie"]);
function jsonResponse(data, env, status = 200) {
  const body = JSON.stringify(data, null, 2);
  const headers = new Headers({
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": env.CORS_ALLOW_ORIGINS?.trim() || "*"
  });
  return new Response(body, { status, headers });
}
function redactHeaders(headers) {
  const result = {};
  for (const [name, value] of headers) {
    result[name] = SENSITIVE_HEADERS.has(name.toLowerCase()) ? "<redacted>" : value;
  }
  return result;
}
export {
  isDebugEnabled,
  jsonResponse,
  normalizeModelId,
  parseDebugValue,
  redactHeaders,
  rewritePayload
};
