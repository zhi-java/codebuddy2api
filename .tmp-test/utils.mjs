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
async function fetchWithTimeout(env, requestInfo, requestInit = {}) {
  const controller = new AbortController();
  const timeoutMs = parseFloat(env.UPSTREAM_TIMEOUT_SECONDS || "600") * 1e3;
  const connectTimeoutMs = parseFloat(env.UPSTREAM_CONNECT_TIMEOUT_SECONDS || "30") * 1e3;
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs + connectTimeoutMs);
  try {
    const response = await fetch(requestInfo, { ...requestInit, signal: controller.signal });
    clearTimeout(timeoutId);
    return response;
  } catch (err) {
    clearTimeout(timeoutId);
    if (err instanceof DOMException && err.name === "AbortError") {
      throw new Error("Upstream timeout");
    }
    throw err;
  }
}
function jsonResponse(data, env, status = 200) {
  const body = JSON.stringify(data);
  const headers = new Headers({
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": env.CORS_ALLOW_ORIGINS?.trim() || "*"
  });
  return new Response(body, { status, headers });
}
export {
  fetchWithTimeout,
  jsonResponse,
  normalizeModelId,
  rewritePayload
};
