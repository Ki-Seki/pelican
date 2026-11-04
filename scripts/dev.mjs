// Runs the API server (restarting on change) and the Vite dev server together.
// Local development signs no one in (PELICAN_AUTH=none, on 127.0.0.1 only); set PELICAN_AUTH=token to try the sign-in.
import { spawn } from 'node:child_process';

const children = [
  spawn('npx', ['tsx', 'watch', 'src/server/cli.ts'], { stdio: 'inherit', env: { ...process.env, PELICAN_DEV: '1', PELICAN_AUTH: process.env.PELICAN_AUTH ?? 'none' } }),
  spawn('npx', ['vite', '--host', '127.0.0.1'], { stdio: 'inherit' }),
];
const stop = () => {
  for (const child of children) child.kill('SIGTERM');
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
for (const child of children) child.on('exit', stop);
