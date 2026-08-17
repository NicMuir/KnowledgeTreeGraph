import type { FastifyInstance } from 'fastify';
import { prisma } from '@kb/db';
import { buildCallGraph } from '@kb/ingestion';

export async function repoRoutes(app: FastifyInstance): Promise<void> {
  app.get('/repos', async (_req, reply) => {
    const repos = await prisma.repository.findMany({
      include: {
        _count: { select: { files: true, chunks: true } },
        indexingRuns: { orderBy: { startedAt: 'desc' }, take: 1 },
      },
      orderBy: { createdAt: 'desc' },
    });

    return reply.send(
      repos.map((r) => ({
        id: r.id,
        name: r.name,
        localPath: r.localPath,
        branch: r.branch,
        currentCommitSha: r.currentCommitSha,
        fileCount: r._count.files,
        chunkCount: r._count.chunks,
        lastRun: r.indexingRuns[0] ?? null,
      })),
    );
  });

  app.get<{ Params: { name: string } }>('/repos/:name/runs', async (req, reply) => {
    const repo = await prisma.repository.findUnique({ where: { name: req.params.name } });
    if (!repo) return reply.status(404).send({ error: 'Repo not found' });

    const runs = await prisma.indexingRun.findMany({
      where: { repoId: repo.id },
      orderBy: { startedAt: 'desc' },
      take: 20,
    });
    return reply.send(runs);
  });

  app.get<{ Params: { name: string } }>('/repos/:name/files', async (req, reply) => {
    const repo = await prisma.repository.findUnique({ where: { name: req.params.name } });
    if (!repo) return reply.status(404).send({ error: 'Repo not found' });

    const files = await prisma.indexedFile.findMany({
      where: { repoId: repo.id },
      select: { id: true, filePath: true, language: true, commitSha: true, indexedAt: true },
      orderBy: { filePath: 'asc' },
    });
    return reply.send(files);
  });

  app.get<{ Params: { name: string; fileId: string } }>('/repos/:name/files/:fileId/chunks', async (req, reply) => {
    const repo = await prisma.repository.findUnique({ where: { name: req.params.name } });
    if (!repo) return reply.status(404).send({ error: 'Repo not found' });

    const chunks = await prisma.chunk.findMany({
      where: { repoId: repo.id, fileId: req.params.fileId },
      orderBy: { startLine: 'asc' },
    });

    return reply.send(
      chunks.map((c) => ({
        chunkId: c.id,
        repoId: c.repoId,
        repoName: repo.name,
        filePath: c.filePath,
        content: c.content,
        startLine: c.startLine,
        endLine: c.endLine,
        chunkType: c.chunkType,
        commitSha: c.commitSha,
        indexedAt: c.indexedAt,
        metadata: c.metadata,
        score: 0,
      })),
    );
  });

  app.get<{ Params: { name: string } }>('/repos/:name/callgraph', async (req, reply) => {
    const repo = await prisma.repository.findUnique({ where: { name: req.params.name } });
    if (!repo) return reply.status(404).send({ error: 'Repo not found' });

    const files = await prisma.indexedFile.findMany({
      where: { repoId: repo.id },
      select: { filePath: true, language: true },
    });

    const graph = buildCallGraph(repo.localPath, files);
    return reply.send(graph);
  });
}
