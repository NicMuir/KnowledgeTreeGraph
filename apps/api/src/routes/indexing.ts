import type { FastifyInstance } from 'fastify';
import { createIndexingRun, runIndexing } from '@kb/ingestion';
import type { IndexRequest } from '@kb/shared';

export async function indexingRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: IndexRequest }>(
    '/index',
    {
      schema: {
        body: {
          type: 'object',
          required: ['repoPath', 'repoName'],
          properties: {
            repoPath: { type: 'string' },
            repoName: { type: 'string' },
            branch: { type: 'string' },
          },
        },
      },
    },
    async (req, reply) => {
      const { repoPath, repoName, branch } = req.body;

      // Create DB records synchronously so we can return runId immediately
      const { runId, repoId } = await createIndexingRun({ repoPath, repoName, branch });

      // Fire-and-forget — client polls GET /repos for status
      setImmediate(() => {
        void runIndexing(runId, {
          repoPath,
          repoName,
          branch,
          onProgress: (indexed, total) => {
            app.log.info({ runId, indexed, total }, 'indexing progress');
          },
        }).catch((err: unknown) => {
          app.log.error({ err, runId }, 'indexing failed');
        });
      });

      return reply.status(202).send({ runId, repoId, status: 'started' });
    },
  );
}
