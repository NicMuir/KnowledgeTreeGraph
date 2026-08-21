import type { FastifyInstance, FastifyReply } from 'fastify';
import { createEmbeddingProvider, createChatProvider, LlmUnavailableError } from '@kb/llm';
import { hybridSearch, expandResults } from '@kb/retrieval';
import type { ChatRequest } from '@kb/shared';
import { buildChatPrompt, SYSTEM_PROMPT } from '../prompts/chat';

// Translate a provider failure into a truthful, client-safe error naming the
// unavailable resource, instead of letting raw SDK/network errors (e.g. Node's
// ERR_INVALID_URL) leak through as an opaque 500.
function sendLlmError(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof LlmUnavailableError) {
    return reply.status(502).send({ error: 'llm_unavailable', message: err.message });
  }
  throw err;
}

export async function chatRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: ChatRequest }>(
    '/chat',
    {
      schema: {
        body: {
          type: 'object',
          required: ['question'],
          properties: {
            question: { type: 'string', minLength: 1 },
            repoNames: { type: 'array', items: { type: 'string' } },
            pathFilter: { type: 'string' },
            maxResults: { type: 'number', minimum: 1, maximum: 20 },
          },
        },
      },
    },
    async (req, reply) => {
      const { question, repoNames = [], pathFilter, maxResults = 8 } = req.body;

      const embedder = createEmbeddingProvider();
      const chatter = createChatProvider();

      let embedding: number[];
      try {
        embedding = await embedder.embed(question);
      } catch (err) {
        return sendLlmError(reply, err);
      }

      const hits = await hybridSearch(embedding, {
        query: question,
        repoNames,
        pathFilter,
        limit: maxResults,
      });
      // Pull structurally related code (route, parent class, callees) via the symbol tree
      const sources = await expandResults(hits);

      if (sources.length === 0) {
        return reply.send({
          answer:
            'No relevant context found in the indexed repositories for your question. ' +
            'Try indexing more repositories or broadening your query.',
          sources: [],
          retrievedChunks: 0,
          model: chatter.model,
        });
      }

      const prompt = buildChatPrompt(question, sources);
      let answer: string;
      try {
        answer = await chatter.chat([
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: prompt },
        ]);
      } catch (err) {
        return sendLlmError(reply, err);
      }

      return reply.send({
        answer,
        sources,
        retrievedChunks: sources.length,
        model: chatter.model,
      });
    },
  );
}
