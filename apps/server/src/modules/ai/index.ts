import type { Clock } from '../../shared/runtime.js';
import type { AiCallLogStore } from '../store/types.js';
import { loadAiConfig, type AiConfig } from './config.js';
import { createAiGateway, providerFromConfig, type AiGateway } from './gateway.js';
import { createKeywordMockProvider } from './mock.js';
import { createOpenAiCompatibleProvider } from './openai-compatible.js';

export * from './config.js';
export * from './gateway.js';
export * from './mock.js';
export * from './openai-compatible.js';
export * from './redact.js';
export * from './types.js';

/** 按配置创建网关；配置缺失或不合法时返回「未启用」的网关，基础功能不受影响 */
export function createGatewayFromConfig(config: AiConfig, log: AiCallLogStore, clock: Clock): AiGateway {
  const provider = providerFromConfig(config, {
    createOpenAi: (c) =>
      createOpenAiCompatibleProvider({
        baseUrl: c.baseUrl,
        apiKey: c.apiKey,
        model: c.model,
        timeoutMs: c.timeoutMs,
        maxRetries: c.maxRetries,
        backoffMs: c.backoffMs,
        jsonMode: c.jsonMode,
      }),
    createMock: (model) => createKeywordMockProvider(model),
  });
  return createAiGateway({ config, provider, log, clock });
}

export { loadAiConfig };
