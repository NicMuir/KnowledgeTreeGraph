import type { FastifyInstance } from 'fastify';
import { prisma } from '@kb/db';

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/health', async (_req, reply) => {
    let dbOk = false;
    try {
      await prisma.$queryRaw`SELECT 1`;
      dbOk = true;
    } catch {
      // db unreachable
    }
    return reply.send({
      status: dbOk ? 'ok' : 'degraded',
      db: dbOk,
      timestamp: new Date().toISOString(),
    });
  });
}
