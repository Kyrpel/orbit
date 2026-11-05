import { startServer } from './index';

/** Development entry: API on :7420, dashboard served by Vite on :5173 with a proxy. */
const server = await startServer({ logger: true, webDist: null });
const webPort = Number(process.env.ORBIT_WEB_PORT) || 5173;
const token = new URL(server.loginUrl).searchParams.get('token') ?? '';
console.log(`\n  Orbit API      ${server.url}`);
console.log(`  Dashboard dev  http://localhost:${webPort}/auth?token=${encodeURIComponent(token)}\n`);

const shutdown = async () => {
  await server.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
