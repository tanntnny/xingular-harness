import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

export const PINNED_PI_VERSION = '1.2.0'
const HTTP_DISPATCHER_CHUNK = 'dist/bundle/chunks/chunk-TJXZSVTD.js'

type PiRuntimeModule = {
  VERSION: string
  getPackageDir(): string
}

type PiDispatcherModule = {
  configureHttpDispatcher?: unknown
}

export function assertPiRuntimeVersion(version: string): void {
  if (version !== PINNED_PI_VERSION) throw new Error(`The Harness Pi runtime requires Pi ${PINNED_PI_VERSION}; found ${version}. Install the Harness package's pinned dependencies.`)
}

/** Builds a cached Pi loader so initialization order and compatibility behavior can be verified. */
export function createPiLoader<T extends PiRuntimeModule>(
  importPi: () => Promise<T>,
  importDispatcher: (packageDir: string) => Promise<PiDispatcherModule>
): () => Promise<T> {
  let loading: Promise<T> | undefined

  return () => {
    if (!loading) {
      loading = (async () => {
        const pi = await importPi()
        assertPiRuntimeVersion(pi.VERSION)
        const dispatcher = await importDispatcher(pi.getPackageDir())
        if (typeof dispatcher.configureHttpDispatcher !== 'function') {
          throw new Error(`The Harness requires the pinned Pi ${PINNED_PI_VERSION} HTTP dispatcher hook; install the Harness package's pinned dependencies.`)
        }
        dispatcher.configureHttpDispatcher()
        return pi
      })().catch((error: unknown) => {
        loading = undefined
        throw error
      })
    }
    return loading
  }
}

export const loadPi = createPiLoader(
  () => import('@earendil-works/pi-coding-agent'),
  async (packageDir) => await import(pathToFileURL(join(packageDir, HTTP_DISPATCHER_CHUNK)).href) as PiDispatcherModule
)
