import { get_encoding } from 'tiktoken';

// ponytail: singleton encoder — cl100k_base matches GPT-4 and text-embedding-3-*
// Do NOT call enc.free() since we hold it for the process lifetime.
const enc = get_encoding('cl100k_base');

export function countTokens(text: string): number {
  return enc.encode(text).length;
}

/** Split text into chunks of at most maxTokens, decoded back to strings. */
export function splitByTokens(text: string, maxTokens: number): string[] {
  const tokens = enc.encode(text);
  const chunks: string[] = [];
  for (let i = 0; i < tokens.length; i += maxTokens) {
    chunks.push(Buffer.from(enc.decode(tokens.slice(i, i + maxTokens))).toString('utf-8'));
  }
  return chunks;
}
