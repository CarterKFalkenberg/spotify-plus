import { existsSync, readFileSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const local = resolve(root, '.local');

function run() {
  const config = JSON.parse(readFileSync(resolve(local, 'config.json'), 'utf8'));
  if (config.authorization?.deployToThisRailwayProject !== true) throw new Error('Set deployToThisRailwayProject to true only after approving deployment to this project.');
  for (const key of ['railwayProjectId', 'railwayEnvironmentId', 'railwayWebServiceId']) {
    if (!config[key] || config[key].includes('REPLACE')) throw new Error(`Set ${key} before reserving the domain.`);
  }
  if (existsSync(resolve(local, 'spotify-bootstrap-consumed.json')) || existsSync(resolve(local, 'build/state.json'))) {
    throw new Error('Build work has already started. Do not replace the application with the setup stub. Use the existing service domain.');
  }
  const directory = resolve(local, 'domain-stub');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(resolve(directory, 'Dockerfile'), 'FROM node:24-alpine\nWORKDIR /app\nCOPY server.mjs .\nENV PORT=3000\nCMD ["node", "server.mjs"]\n');
  writeFileSync(resolve(directory, 'server.mjs'),
    "import {createServer} from 'node:http'; createServer((req,res)=>{res.writeHead(200,{'Content-Type':'text/plain','Cache-Control':'no-store'});res.end('Spotify Song Tagger setup. Application build has not started.');}).listen(Number(process.env.PORT||3000),'0.0.0.0');\n");
  if (readdirSync(directory).some(name => !['Dockerfile', 'server.mjs'].includes(name))) {
    throw new Error('The setup-stub directory contains unexpected files. Inspect it before any upload.');
  }
  const env = { ...process.env };
  if (existsSync(resolve(local, 'railway-token'))) {
    env.RAILWAY_TOKEN = readFileSync(resolve(local, 'railway-token'), 'utf8').trim(); delete env.RAILWAY_API_TOKEN;
  }
  function railway(args) {
    const result = spawnSync('railway', args, { cwd: directory, env, stdio: 'inherit', timeout: 10 * 60 * 1000 });
    if (result.error || result.status !== 0) throw new Error('Railway setup command failed. No application or Spotify grant has been created.');
  }
  console.log('Deploying the two-file setup stub to the configured web service only.');
  railway(['up', '--project', config.railwayProjectId, '--environment', config.railwayEnvironmentId,
    '--service', config.railwayWebServiceId, '--ci', '--no-gitignore']);
  railway(['domain', '--project', config.railwayProjectId, '--environment', config.railwayEnvironmentId,
    '--service', config.railwayWebServiceId, '--port', '3000']);
  console.log('Put the HTTPS URL printed above in .local/config.json as appUrl and register its Spotify callback.');
}

try { run(); } catch (error) { console.error(error.message); process.exitCode = 1; }
