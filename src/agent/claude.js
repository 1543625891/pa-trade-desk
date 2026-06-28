// Claude API 客户端：在 Tauri WebView 里直连 api.anthropic.com。
// 依赖 Anthropic 官方的 CORS 支持（anthropic-dangerous-direct-browser-access header），无需 Rust 侧代理。

export const DEFAULT_MODEL = "claude-sonnet-4-6";

const API_URL = "https://api.anthropic.com/v1/messages";

export class ClaudeError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

/**
 * 调用 Claude Messages API。
 * @param {object} cfg { apiKey, model }
 * @param {object} req { system, messages, maxTokens }
 * @returns {Promise<string>} 模型输出的文本
 */
export async function callClaude(cfg, { system, messages, maxTokens = 8000 }) {
  const apiKey = (cfg?.apiKey || "").trim();
  if (!apiKey) throw new ClaudeError("还没有配置 Claude API Key，请到「AI Agent」页填写。", 0);

  const body = {
    model: (cfg?.model || "").trim() || DEFAULT_MODEL,
    max_tokens: maxTokens,
    messages,
  };
  if (system) body.system = system;

  let res;
  try {
    res = await fetch(API_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify(body),
    });
  } catch (error) {
    throw new ClaudeError(`网络请求失败：${error.message}（检查网络或代理）`, 0);
  }

  if (!res.ok) {
    let detail = "";
    try {
      const data = await res.json();
      detail = data?.error?.message || JSON.stringify(data);
    } catch {
      detail = await res.text().catch(() => "");
    }
    if (res.status === 401) throw new ClaudeError("API Key 无效（401）。请检查 AI Agent 页里的 Key。", 401);
    if (res.status === 429) throw new ClaudeError("请求被限流（429），稍等几十秒再试。", 429);
    throw new ClaudeError(`Claude API 错误 ${res.status}：${detail.slice(0, 300)}`, res.status);
  }

  const data = await res.json();
  return (data.content || [])
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

/** 构造图片内容块（base64） */
export function imageBlock(base64, mediaType = "image/png") {
  return { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } };
}

export function textBlock(text) {
  return { type: "text", text };
}

/** 测试连接：发一个最小请求 */
export async function testConnection(cfg) {
  const reply = await callClaude(cfg, {
    messages: [{ role: "user", content: "回复「连接成功」四个字，不要别的。" }],
    maxTokens: 32,
  });
  return reply;
}
