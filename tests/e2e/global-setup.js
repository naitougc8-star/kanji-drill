import { startServer } from '../../scripts/serve.mjs';

export default async function globalSetup() {
  const port = Number(process.env.E2E_PORT || 4173);
  const server = await startServer({ port, host: '127.0.0.1' });
  return async () => {
    await new Promise((resolve) => server.close(resolve));
  };
}
