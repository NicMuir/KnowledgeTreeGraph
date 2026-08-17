import type { FastifyInstance } from 'fastify';
import { createEmbeddingProvider } from '@kb/llm';
import { hybridSearch, expandResults } from '@kb/retrieval';

export async function searchRoutes(app: FastifyInstance): Promise<void> {
  app.get<{
    Querystring: { q: string; repo?: string; lang?: string; type?: string; limit?: string; expand?: string };
  }>('/search', async (req, reply) => {
    const { q, repo, lang, type, limit, expand } = req.query;
    if (!q?.trim()) return reply.status(400).send({ error: 'q is required' });

    const embedder = createEmbeddingProvider();
    const embedding = await embedder.embed(q);

    let results = await hybridSearch(embedding, {
      query: q,
      repoNames: repo ? [repo] : [],
      language: lang,
      chunkType: type,
      limit: limit ? parseInt(limit, 10) : 20,
    });
    if (expand === '1' || expand === 'true') {
      results = await expandResults(results);
    }

    return reply.send({ results, total: results.length });
  });
}
