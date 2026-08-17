import Fastify from 'fastify';
import cors from '@fastify/cors';
import { healthRoutes } from './routes/health';
import { repoRoutes } from './routes/repos';
import { indexingRoutes } from './routes/indexing';
import { searchRoutes } from './routes/search';
import { chatRoutes } from './routes/chat';
import { graphRoutes } from './routes/graph';
import { snapshotRoutes } from './routes/snapshot';

export async function buildApp() {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
    },
  });

  await app.register(cors, {
    origin: process.env.CORS_ORIGIN ?? '*',
  });

  // Routes
  await app.register(healthRoutes);
  await app.register(repoRoutes);
  await app.register(indexingRoutes);
  await app.register(searchRoutes);
  await app.register(chatRoutes);
  await app.register(graphRoutes);
  await app.register(snapshotRoutes);

  return app;
}
