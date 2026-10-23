/** 把文本里可能出现的密钥替换掉：已知密钥原文、常见的 sk-… 令牌与 Bearer 令牌 */
export function redactSecrets(text: string, secrets: readonly string[] = []): string {
  let out = text;
  for (const s of secrets) {
    if (s.length >= 4) out = out.split(s).join('***');
  }
  return out
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{6,}/gi, 'Bearer ***')
    .replace(/\bsk-[A-Za-z0-9_-]{6,}/g, 'sk-***');
}

/** 截断并脱敏，用于把供应商的错误响应放进错误信息（限长，避免日志被灌入大段内容） */
export function safeSnippet(text: string, secrets: readonly string[] = [], max = 200): string {
  const t = redactSecrets(text, secrets).replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}
