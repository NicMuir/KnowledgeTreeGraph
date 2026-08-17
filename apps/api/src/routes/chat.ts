import type { FastifyInstance } from 'fastify';
import { createEmbeddingProvider, createChatProvider } from '@kb/llm';
import { hybridSearch, expandResults } from '@kb/retrieval';
import type { ChatRequest } from '@kb/shared';
import { buildChatPrompt, SYSTEM_PROMPT } from '../prompts/chat';

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

      const embedding = await embedder.embed(question);

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
      const answer = await chatter.chat([
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: prompt },
      ]);

      return reply.send({
        answer,
        sources,
        retrievedChunks: sources.length,
        model: chatter.model,
      });
    },
  );
}
