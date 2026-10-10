import { isAbsolute, join } from 'node:path'
import { buildApp } from './app.js'
import { providers } from './providers/index.js'
import { shippedPaths } from './paths.js'
import { DEFAULT_BACKGROUND } from './backgrounds/seed.js'

// A checkout's own folders, or the app bundle's when the helper sets `FREMKIT_ROOT`: see paths.ts.
let shipped: ReturnType<typeof shippedPaths>
try {
  shipped = shippedPaths()
} catch (error) {
  console.error(`fremkit: ${(error as Error).message}`)
  process.exit(1)
}
// A second checkout (a worktree, a test bench) can run beside the live server on another port.
// The helper passes its own configured port here; 4242 is what everything assumes otherwise.
const port = Number(process.env.FREMKIT_PORT) || 4242

/**
 * Where the config, the backgrounds and the caches live. `<checkout>/data` unless told otherwise;
 * the app always tells, because its bundle is replaced by every update.
 *
 * `FREMKIT_DATA_DIR` is what makes a from-scratch run possible on the live checkout without
 * moving anything: the dashboard, the connections list and the background library all come from
 * here, so pointing it elsewhere gives a brand-new install. The keychain is keyed by connection
 * id, so a fresh config never names the real items and they are left untouched.
 *
 * Absolute only: a relative path would be read against whatever directory the process happened
 * to start in, which for the helper's child is the checkout and for a shell is anywhere.
 */
const configured = process.env.FREMKIT_DATA_DIR
if (configured && !isAbsolute(configured)) {
  console.error(`fremkit: FREMKIT_DATA_DIR must be an absolute path, got ${configured}`)
  process.exit(1)
}
const dataDir = configured || `${shipped.root}/data`

/**
 * A registry served from somewhere else, for development only.
 *
 * The production registry is a constant: one host, https, private addresses refused. That is
 * right, and it makes the install path untestable until something is actually published — so
 * `FREMKIT_REGISTRY_URL` can point at a locally built one, and is honoured **only** under
 * `FREMKIT_DEV=1`. Outside that it is ignored, loudly: an environment variable that silently
 * redirected where a Fremkit installs widgets from would be the worst kind of quiet.
 */
const dev = process.env.FREMKIT_DEV === '1'
const requestedRegistry = process.env.FREMKIT_REGISTRY_URL
let registryUrl: string | undefined
if (requestedRegistry && !dev) {
  console.error('fremkit: FREMKIT_REGISTRY_URL is ignored without FREMKIT_DEV=1; using the published registry')
} else if (requestedRegistry) {
  registryUrl = requestedRegistry
  console.error(`fremkit: FREMKIT_DEV=1, installing widgets from ${requestedRegistry}`)
}

// Not a top-level await: the app's bundled server is CommonJS (see scripts/bundle-server.mjs),
// which has none. A failure still ends the process with a non-zero status, as it did.
async function main(): Promise<void> {
  const app = await buildApp({
    dataDir,
    widgetsDir: shipped.widgetsDir,
    ...(registryUrl ? { registryUrl, registryDev: true } : {}),
    themesDir: shipped.themesDir,
    uiDist: shipped.uiDist,
    bridgePath: shipped.bridgePath,
    wallpaperPath: join(shipped.wallpaperDir, DEFAULT_BACKGROUND),
    providers,
    logger: true,
    port,
  })
  await app.listen({ port, host: '127.0.0.1' })
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
