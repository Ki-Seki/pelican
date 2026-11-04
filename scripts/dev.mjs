// Runs the API server (restarting on change) and the Vite dev server together.
import { spawn } from 'node:child_process';

const children = [
  spawn('npx', ['tsx', 'watch', 'src/server/index.ts'], { stdio: 'inherit', env: { ...process.env, PELICAN_DEV: '1' } }),
  spawn('npx', ['vite', '--host', '127.0.0.1'], { stdio: 'inherit' }),
];
const stop = () => {
  for (const child of children) child.kill('SIGTERM');
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
for (const child of children) child.on('exit', stop);
