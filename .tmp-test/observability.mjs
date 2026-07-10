// src/observability.ts
function redactApiKey(authorization) {
  if (!authorization) return "<none>";
  const match = authorization.match(/^(\S+)\s+(.+)$/);
  if (!match) return "<malformed>";
  const [, scheme, token] = match;
  if (token.length <= 8) return `${scheme} <too-short>`;
  const prefix = token.slice(0, 4);
  const suffix = token.slice(-4);
  return `${scheme} ${prefix}***${suffix}`;
}
function extractUserInput(payload) {
  if (!payload) return "<no payload>";
  const messages = payload["messages"];
  if (!Array.isArray(messages)) return "<no messages>";
  const userMessages = messages.filter(
    (m) => m !== null && typeof m === "object" && !Array.isArray(m) && String(m["role"]) === "user"
  ).map((m) => extractTextContent(m)).filter(Boolean);
  return userMessages.length > 0 ? userMessages.join(" | ") : "<no user messages>";
}
function extractTextContent(msg) {
  const content = msg["content"];
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.filter(
      (p) => p !== null && typeof p === "object" && !Array.isArray(p) && p["type"] === "text"
    ).map((p) => String(p["text"] ?? "")).join("");
  }
  return "";
}
function extractAssistantOutput(responseBody) {
  const choices = responseBody["choices"];
  if (!Array.isArray(choices) || choices.length === 0) return "<no output>";
  const firstChoice = choices[0];
  if (!firstChoice || typeof firstChoice !== "object" || Array.isArray(firstChoice)) {
    return "<no output>";
  }
  const choice = firstChoice;
  const message = choice["message"];
  if (!message || typeof message !== "object" || Array.isArray(message)) return "<no output>";
  const msg = message;
  return typeof msg["content"] === "string" ? msg["content"] : JSON.stringify(msg);
}
function logObservability(authorization, payload, responseBody) {
  const model = (payload && typeof payload["model"] === "string" ? payload["model"] : "") || "unknown";
  const entry = {
    timestamp: (/* @__PURE__ */ new Date()).toISOString(),
    api_key: redactApiKey(authorization),
    model,
    user_input: extractUserInput(payload),
    assistant_output: extractAssistantOutput(responseBody)
  };
  console.log(JSON.stringify({ _observability: entry }));
}
export {
  extractAssistantOutput,
  extractUserInput,
  logObservability,
  redactApiKey
};
