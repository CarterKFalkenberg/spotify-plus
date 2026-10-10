import { createServer } from 'node:http';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync, chmodSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SCOPES = [
  'user-library-read', 'playlist-read-private', 'playlist-modify-private',
  'playlist-modify-public', 'user-library-modify'
];
export const CALLBACK = 'http://127.0.0.1:3000/auth/spotify/callback';

export function sameState(actual, expected) {
  if (typeof actual !== 'string') return false;
  const a = Buffer.from(actual), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function bindAccount(profile, expectedId) {
  if (profile.id !== expectedId) throw new Error('Wrong Spotify account. Sign in with the account whose profile ID is in config.json.');
  if (typeof profile.account_id !== 'string' || !profile.account_id) {
    throw new Error('Spotify did not return account_id. Live account binding needs investigation; no grant was saved.');
  }
  return profile.account_id;
}

async function run() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const local = resolve(root, '.local');
  const config = JSON.parse(readFileSync(resolve(local, 'config.json'), 'utf8'));
  if (!config.spotifyClientId || !config.spotifyExpectedUserId ||
      [config.spotifyClientId, config.spotifyExpectedUserId].some(x => x.includes('REPLACE'))) {
    throw new Error('Set spotifyClientId and spotifyExpectedUserId in .local/config.json first.');
  }
  const state = randomBytes(32).toString('base64url');
  const verifier = randomBytes(64).toString('base64url');
  const auth = new URL('https://accounts.spotify.com/authorize');
  auth.search = new URLSearchParams({
    client_id: config.spotifyClientId, response_type: 'code', redirect_uri: CALLBACK,
    state, code_challenge_method: 'S256',
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    scope: SCOPES.join(' '), show_dialog: 'true'
  }).toString();

  await new Promise((done, fail) => {
    let handling = false;
    const server = createServer(async (req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1:3000');
      if (url.pathname !== '/auth/spotify/callback') { res.writeHead(404).end(); return; }
      if (!sameState(url.searchParams.get('state'), state)) { res.writeHead(400).end('Invalid OAuth state.'); return; }
      if (handling) { res.writeHead(409).end('Authorization is already being processed.'); return; }
      handling = true;
      try {
        if (url.searchParams.get('error')) throw new Error('Spotify consent was denied. Run this helper again and approve the requested permissions.');
        const code = url.searchParams.get('code');
        if (!code) throw new Error('Spotify did not return an authorization code.');
        const tokenResponse = await fetch('https://accounts.spotify.com/api/token', {
          method: 'POST', signal: AbortSignal.timeout(20000),
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ grant_type: 'authorization_code', client_id: config.spotifyClientId,
            code, redirect_uri: CALLBACK, code_verifier: verifier })
        });
        if (!tokenResponse.ok) throw new Error(`Spotify token exchange failed (HTTP ${tokenResponse.status}). Check Client ID and the exact registered callback URI.`);
        const tokens = await tokenResponse.json();
        if (!tokens.access_token || !tokens.refresh_token) throw new Error('Spotify returned an incomplete grant; no credentials were saved.');
        const profileResponse = await fetch('https://api.spotify.com/v1/me', {
          signal: AbortSignal.timeout(20000), headers: { Authorization: `Bearer ${tokens.access_token}` }
        });
        if (!profileResponse.ok) throw new Error(`Spotify refused the profile request (HTTP ${profileResponse.status}). For 403, check Users Management allowlist, owner Premium, and granted scopes. The status alone does not prove the cause.`);
        const accountId = bindAccount(await profileResponse.json(), config.spotifyExpectedUserId);
        const granted = new Set(String(tokens.scope ?? '').split(' '));
        if (SCOPES.some(scope => !granted.has(scope))) throw new Error('Spotify did not grant all required setup scopes. No credentials were saved.');
        mkdirSync(local, { recursive: true, mode: 0o700 });
        chmodSync(local, 0o700);
        const destination = resolve(local, 'spotify-bootstrap.json');
        const temporary = `${destination}.tmp`;
        writeFileSync(temporary, JSON.stringify({ clientId: config.spotifyClientId,
          userId: config.spotifyExpectedUserId, accountId, authorizedAt: new Date().toISOString(),
          accessToken: tokens.access_token, refreshToken: tokens.refresh_token,
          accessExpiresAt: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
          scopes: [...granted] }, null, 2) + '\n', { mode: 0o600 });
        chmodSync(temporary, 0o600);
        renameSync(temporary, destination);
        console.log('Connected the expected account. Grant saved in ignored .local/spotify-bootstrap.json (mode 600).');
        res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
        res.end('Spotify connected. You can close this tab and continue the setup checklist.');
        shutdown(); done();
      } catch (error) {
        res.writeHead(400, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
        res.end(error.message);
        shutdown(); fail(error);
      }
    });
    const timeout = setTimeout(() => { shutdown(); fail(new Error('Spotify setup timed out after 10 minutes. Run the helper again.')); }, 10 * 60 * 1000);
    function shutdown() { clearTimeout(timeout); server.close(); server.closeIdleConnections(); }
    server.on('error', error => { clearTimeout(timeout); fail(error); });
    server.listen(3000, '127.0.0.1', () => {
      console.log('Open this Spotify authorization URL in your browser:');
      console.log(auth.toString());
      console.log('This helper reads only account identity and saves credentials. It does not read songs or write Spotify playlists.');
    });
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run().catch(error => { console.error(error.message); process.exitCode = 1; });
}
