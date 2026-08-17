import fs from 'fs';
import path from 'path';
import type { FastifyInstance } from 'fastify';
import { embeddingIdentity } from '@kb/llm';

// ---------------------------------------------------------------------------
// Snapshot distribution: the HEAD PC serves its newest pg_dump so colleague
// laptops can bootstrap via `kb fetch` instead of indexing from scratch.
//   /snapshot/info — name/size/mtime + embedding identity (compat check)
//   /snapshot      — stream the dump file
// ---------------------------------------------------------------------------

const SNAP_DIR = path.resolve(__dirname, '../../../../snapshots');

interface Dump { file: string; name: string; size: number; mtime: Date; mtimeMs: number }

function newestDump(): Dump | null {
  let best: Dump | null = null;
  try {
    for (const name of fs.readdirSync(SNAP_DIR)) {
      if (!name.endsWith('.dump')) continue;
      const file = path.join(SNAP_DIR, name);
      const st = fs.statSync(file);
      if (!best || st.mtimeMs > best.mtimeMs) best = { file, name, size: st.size, mtime: st.mtime, mtimeMs: st.mtimeMs };
    }
  } catch {
    return null; // no snapshots/ dir yet
  }
  return best;
}

export async function snapshotRoutes(app: FastifyInstance): Promise<void> {
  app.get('/snapshot/info', async (_req, reply) => {
    const d = newestDump();
    if (!d) return reply.status(404).send({ error: 'No snapshot yet. Run: kb snapshot' });
    const embed = embeddingIdentity();
    return reply.send({
      name: d.name,
      size: d.size,
      mtime: d.mtime.toISOString(),
      embeddingModel: embed.model,
      embeddingDimensions: embed.dimensions,
    });
  });

  app.get('/snapshot', async (_req, reply) => {
    const d = newestDump();
    if (!d) return reply.status(404).send({ error: 'No snapshot yet. Run: kb snapshot' });
    return reply
      .type('application/octet-stream')
      .header('content-length', d.size)
      .header('content-disposition', `attachment; filename="${d.name}"`)
      .send(fs.createReadStream(d.file));
  });
}
