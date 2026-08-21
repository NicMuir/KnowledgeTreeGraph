/**
 * Ollama provider — uses Ollama's OpenAI-compatible API.
 * Set LLM_PROVIDER=ollama in your .env to activate.
 *
 * Chat:      POST /v1/chat/completions  (OpenAI compat)
 * Embeddings: POST /api/embed           (native, supports batches)
 */
import OpenAI from 'openai';
import type { EmbeddingProvider, ChatProvider, ChatMessage, ChatOptions } from '../types';
import { LlmUnavailableError } from '../types';

interface OllamaConfig {
  baseUrl: string;       // e.g. http://10.30.0.60:11434
  embeddingModel: string;
  chatModel: string;
  dimensions: number;
}

export class OllamaEmbeddingProvider implements EmbeddingProvider {
  readonly dimensions: number;
  private model: string;
  // One or more hosts, tried in order — set OLLAMA_BASE_URL to a comma-separated list
  // (e.g. remote,http://localhost:11434) to fall back to a local Ollama when the remote is down.
  private hosts: string[];

  constructor(config: OllamaConfig) {
    this.hosts = config.baseUrl.split(',').map((h) => h.trim().replace(/\/$/, '')).filter(Boolean);
    this.model = config.embeddingModel;
    this.dimensions = config.dimensions;
  }

  async embed(text: string): Promise<number[]> {
    const [result] = await this._embedBatch([text]);
    return result;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    return this._embedBatch(texts);
  }

  // Use Ollama's native /api/embed — supports arrays and is more reliable than /v1/embeddings.
  // Each attempt tries every host in order (remote first, then local fallback) before backing off.
  private async _embedBatch(texts: string[]): Promise<number[][]> {
    for (let attempt = 1; ; attempt++) {
      let lastErr: unknown;
      for (const host of this.hosts) {
        try {
          const res = await fetch(`${host}/api/embed`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: this.model, input: texts }),
            signal: AbortSignal.timeout(120_000),
          });
          if (!res.ok) {
            const body = await res.text();
            throw new Error(`Ollama embed error ${res.status}: ${body}`);
          }
          const json = await res.json() as { embeddings: number[][] };
          return json.embeddings;
        } catch (err) {
          lastErr = err; // try the next host before giving up on this attempt
        }
      }
      if (attempt >= 3) {
        const reason = lastErr instanceof Error ? lastErr.message : String(lastErr);
        throw new LlmUnavailableError(
          `Embedding model "${this.model}" is unavailable on ${this.hosts.length > 1 ? 'any configured Ollama host' : 'the configured Ollama host'} (${this.hosts.join(', ')}): ${reason}`,
        );
      }
      await new Promise((r) => setTimeout(r, attempt * 5_000)); // ponytail: fixed 3-try backoff, tune if the box stays flaky
    }
  }
}

export class OllamaChatProvider implements ChatProvider {
  private hosts: string[];
  // One OpenAI client per host, tried in order — mirrors OllamaEmbeddingProvider's
  // comma-separated OLLAMA_BASE_URL fallback (see .env.example). The OpenAI SDK's
  // `new URL(baseURL)` call rejects a raw comma-separated string outright
  // (ERR_INVALID_URL), so each host needs its own client built from a single URL.
  private clients: OpenAI[];
  readonly model: string;

  constructor(config: OllamaConfig) {
    this.hosts = config.baseUrl.split(',').map((h) => h.trim().replace(/\/$/, '')).filter(Boolean);
    // Ollama's OpenAI-compat chat endpoint
    this.clients = this.hosts.map(
      (host) => new OpenAI({ baseURL: `${host}/v1`, apiKey: 'ollama' /* required by SDK, ignored by Ollama */ }),
    );
    this.model = config.chatModel;
  }

  async chat(messages: ChatMessage[], options: ChatOptions = {}): Promise<string> {
    let lastErr: unknown;
    for (const client of this.clients) {
      try {
        const res = await client.chat.completions.create({
          model: this.model,
          messages,
          max_tokens: options.maxTokens ?? 2048,
          temperature: options.temperature ?? 0.1,
        });
        return res.choices[0].message.content ?? '';
      } catch (err) {
        lastErr = err; // try the next host before giving up
      }
    }
    const reason = lastErr instanceof Error ? lastErr.message : String(lastErr);
    throw new LlmUnavailableError(
      `Chat model "${this.model}" is unavailable on ${this.hosts.length > 1 ? 'any configured Ollama host' : 'the configured Ollama host'} (${this.hosts.join(', ')}): ${reason}`,
    );
  }
}
