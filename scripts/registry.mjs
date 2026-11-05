// A registry on this computer that hands out one package as registry.npmjs.org would, and sends
// every other request on to registry.npmjs.org. CI installs the package through it because npm
// takes the tree a package's npm-shrinkwrap.json pins only when the registry says the package has
// one (_hasShrinkwrap), never for a tarball installed by its path: so CI installs what people get.
//   node scripts/registry.mjs <package.tgz> <command>...
// runs the command (npm install -g pelican-cc) with npm pointed at that registry.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

import { readTar } from './upstream-report.mjs';

export const UPSTREAM = 'https://registry.npmjs.org';

/**
 * What the registry says of the package in `tgz`, at `base`: its one version, as `latest`.
 * @param {Buffer} tgz
 * @param {string} base
 * @returns {{ name: string, 'dist-tags': { latest: string }, versions: Record<string, Record<string, any>> }}
 */
export function packument(tgz, base) {
  const files = readTar(tgz);
  const json = files.get('package/package.json');
  if (!json) throw new Error('The tarball holds no package/package.json');
  const manifest = JSON.parse(json.toString('utf8'));
  const { name, version } = manifest;
  return {
    name,
    'dist-tags': { latest: version },
    versions: {
      [version]: {
        ...manifest,
        _id: `${name}@${version}`,
        // registry.npmjs.org sets this from the published files; npm reads the shrinkwrap only then.
        _hasShrinkwrap: files.has('package/npm-shrinkwrap.json'),
        dist: {
          tarball: `${base}${name}/-/${name.split('/').pop()}-${version}.tgz`,
          integrity: `sha512-${createHash('sha512').update(tgz).digest('base64')}`,
          shasum: createHash('sha1').update(tgz).digest('hex'),
        },
      },
    },
  };
}

/**
 * Serves the package in `tgz` on 127.0.0.1, any free port; `url` is the registry's address.
 * @param {Buffer} tgz
 */
export async function serve(tgz) {
  const server = http.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const url = `http://127.0.0.1:${server.address().port}/`;
  const document = packument(tgz, url);
  const { tarball } = Object.values(document.versions)[0].dist;
  const body = JSON.stringify(document);
  server.on('request', (request, response) => {
    const { pathname } = new URL(request.url, url);
    const read = request.method === 'GET' || request.method === 'HEAD';
    if (read && decodeURIComponent(pathname) === `/${document.name}`) {
      response.writeHead(200, { 'content-type': 'application/json' }).end(body);
    } else if (read && pathname === new URL(tarball).pathname) {
      response.writeHead(200, { 'content-type': 'application/octet-stream' }).end(tgz);
    } else {
      response.writeHead(307, { location: UPSTREAM + request.url }).end();
    }
  });
  return {
    url,
    close: () => new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections();
    }),
  };
}

/** Run as a command, not imported by the tests (a path through a symlink, such as macOS's /tmp, counts). */
const isMain = () => {
  try {
    return realpathSync(process.argv[1] ?? '') === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
};

if (isMain()) {
  const [file, command, ...args] = process.argv.slice(2);
  if (!file || !command) {
    console.error('usage: node scripts/registry.mjs <package.tgz> <command>...');
    process.exit(2);
  }
  const registry = await serve(await readFile(file));
  const child = spawn(command, args, { stdio: 'inherit', env: { ...process.env, npm_config_registry: registry.url } });
  const code = await new Promise((resolve) => {
    child.on('error', (error) => {
      console.error(`registry: ${error.message}`);
      resolve(1);
    });
    child.on('exit', (status, signal) => resolve(status ?? (signal ? 1 : 0)));
  });
  await registry.close();
  process.exit(code);
}
