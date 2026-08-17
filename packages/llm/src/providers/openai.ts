import OpenAI from 'openai';
import type { EmbeddingProvider, ChatProvider, ChatMessage, ChatOptions, LLMConfig } from '../types';

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  private client: OpenAI;
  readonly dimensions: number;
  private model: string;

  constructor(config: LLMConfig) {
    this.client = new OpenAI({ apiKey: config.apiKey });
    this.model = config.embeddingModel ?? 'text-embedding-3-small';
    this.dimensions = config.embeddingDimensions ?? 1536;
  }

  async embed(text: string): Promise<number[]> {
    const res = await this.client.embeddings.create({
      model: this.model,
      input: text.slice(0, 8000),
      dimensions: this.dimensions,
    });
    return res.data[0].embedding;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const res = await this.client.embeddings.create({
      model: this.model,
      input: texts.map((t) => t.slice(0, 8000)),
      dimensions: this.dimensions,
    });
    // sort by index to guarantee order
    return res.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
  }
}

export class OpenAIChatProvider implements ChatProvider {
  private client: OpenAI;
  readonly model: string;

  constructor(config: LLMConfig) {
    this.client = new OpenAI({ apiKey: config.apiKey });
    this.model = config.chatModel ?? 'gpt-4o-mini';
  }

  async chat(messages: ChatMessage[], options: ChatOptions = {}): Promise<string> {
    const res = await this.client.chat.completions.create({
      model: this.model,
      messages,
      max_tokens: options.maxTokens ?? 2048,
      temperature: options.temperature ?? 0.1,
    });
    return res.choices[0].message.content ?? '';
  }
}
