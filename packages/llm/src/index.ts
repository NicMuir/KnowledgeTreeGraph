export * from './types';
export * from './providers/openai';
export * from './providers/ollama';

import { OpenAIEmbeddingProvider, OpenAIChatProvider } from './providers/openai';
import { OllamaEmbeddingProvider, OllamaChatProvider } from './providers/ollama';
import type { EmbeddingProvider, ChatProvider } from './types';

const provider = (process.env.LLM_PROVIDER ?? 'openai').toLowerCase();

export function createEmbeddingProvider(): EmbeddingProvider {
  if (provider === 'ollama') {
    const baseUrl = process.env.OLLAMA_BASE_URL;
    if (!baseUrl) throw new Error('OLLAMA_BASE_URL is required when LLM_PROVIDER=ollama');
    return new OllamaEmbeddingProvider({
      baseUrl,
      embeddingModel: process.env.OLLAMA_EMBEDDING_MODEL ?? 'nomic-embed-text',
      chatModel: process.env.OLLAMA_CHAT_MODEL ?? 'qwen2.5-coder:7b',
      dimensions: parseInt(process.env.EMBEDDING_DIMENSIONS ?? '768', 10),
    });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY is required when LLM_PROVIDER=openai');
  return new OpenAIEmbeddingProvider({
    apiKey,
    embeddingModel: process.env.OPENAI_EMBEDDING_MODEL ?? 'text-embedding-3-small',
    embeddingDimensions: parseInt(process.env.EMBEDDING_DIMENSIONS ?? '1536', 10),
  });
}

export function createChatProvider(): ChatProvider {
  if (provider === 'ollama') {
    const baseUrl = process.env.OLLAMA_BASE_URL;
    if (!baseUrl) throw new Error('OLLAMA_BASE_URL is required when LLM_PROVIDER=ollama');
    return new OllamaChatProvider({
      baseUrl,
      embeddingModel: process.env.OLLAMA_EMBEDDING_MODEL ?? 'nomic-embed-text',
      chatModel: process.env.OLLAMA_CHAT_MODEL ?? 'qwen2.5-coder:7b',
      dimensions: parseInt(process.env.EMBEDDING_DIMENSIONS ?? '768', 10),
    });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY is required when LLM_PROVIDER=openai');
  return new OpenAIChatProvider({
    apiKey,
    chatModel: process.env.OPENAI_CHAT_MODEL ?? 'gpt-4o-mini',
  });
}

/** Model+dims the current env embeds with — lets `kb fetch` verify snapshot compatibility. */
export function embeddingIdentity(): { model: string; dimensions: number } {
  if (provider === 'ollama') {
    return {
      model: process.env.OLLAMA_EMBEDDING_MODEL ?? 'nomic-embed-text',
      dimensions: parseInt(process.env.EMBEDDING_DIMENSIONS ?? '768', 10),
    };
  }
  return {
    model: process.env.OPENAI_EMBEDDING_MODEL ?? 'text-embedding-3-small',
    dimensions: parseInt(process.env.EMBEDDING_DIMENSIONS ?? '1536', 10),
  };
}
