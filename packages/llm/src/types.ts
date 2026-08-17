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
