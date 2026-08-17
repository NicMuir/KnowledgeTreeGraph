import { config } from 'dotenv';
import { resolve } from 'path';
config({ path: resolve(__dirname, '../../../.env') });
import { buildApp } from './server';

const PORT = parseInt(process.env.API_PORT ?? '3001', 10);
const HOST = process.env.API_HOST ?? '0.0.0.0';

async function main() {
  const app = await buildApp();
  try {
    await app.listen({ port: PORT, host: HOST });
    app.log.info(`KB API running on http://${HOST}:${PORT}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

void main();
