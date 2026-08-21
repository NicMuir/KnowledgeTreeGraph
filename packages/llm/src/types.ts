export interface EmbeddingProvider {
  embed(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
  readonly dimensions: number;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatOptions {
  maxTokens?: number;
  temperature?: number;
}

export interface ChatProvider {
  chat(messages: ChatMessage[], options?: ChatOptions): Promise<string>;
  readonly model: string;
}

export interface LLMConfig {
  apiKey: string;
  embeddingModel?: string;
  chatModel?: string;
  embeddingDimensions?: number;
}

/** Thrown when no configured LLM host/model could serve a request — carries a message safe to return to callers. */
export class LlmUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LlmUnavailableError';
  }
}
