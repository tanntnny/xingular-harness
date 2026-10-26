import { describe, expect, it, vi } from 'vitest'

import { createPiLoader, PINNED_PI_VERSION } from './runtime'

describe('Pi runtime initialization', () => {
  it('configures Pi networking before returning the module and shares concurrent initialization', async () => {
    const events: string[] = []
    const pi = { VERSION: PINNED_PI_VERSION, getPackageDir: () => '/pinned/pi' }
    const load = createPiLoader(
      async () => {
        events.push('import Pi')
        return pi
      },
      async (packageDir) => {
        events.push(`load dispatcher from ${packageDir}`)
        return { configureHttpDispatcher: () => events.push('configure dispatcher') }
      }
    )

    const [first, second] = await Promise.all([load(), load()])

    expect(first).toBe(pi)
    expect(second).toBe(pi)
    expect(events).toEqual(['import Pi', 'load dispatcher from /pinned/pi', 'configure dispatcher'])
  })

  it('rejects a Pi version change before loading its private dispatcher', async () => {
    const loadDispatcher = vi.fn(async () => ({ configureHttpDispatcher: vi.fn() }))
    const load = createPiLoader(async () => ({ VERSION: '0.0.1', getPackageDir: () => '/other/pi' }), loadDispatcher)

    await expect(load()).rejects.toThrow(`requires Pi ${PINNED_PI_VERSION}`)
    expect(loadDispatcher).not.toHaveBeenCalled()
  })

  it('reports when Pi no longer exposes its private dispatcher hook', async () => {
    const load = createPiLoader(
      async () => ({ VERSION: PINNED_PI_VERSION, getPackageDir: () => '/pinned/pi' }),
      async () => ({})
    )

    await expect(load()).rejects.toThrow(`pinned Pi ${PINNED_PI_VERSION} HTTP dispatcher hook`)
  })

  it('can retry initialization after a transient dispatcher load failure', async () => {
    const configure = vi.fn()
    let attempts = 0
    const load = createPiLoader(
      async () => ({ VERSION: PINNED_PI_VERSION, getPackageDir: () => '/pinned/pi' }),
      async () => {
        attempts++
        if (attempts === 1) throw new Error('temporary import failure')
        return { configureHttpDispatcher: configure }
      }
    )

    await expect(load()).rejects.toThrow('temporary import failure')
    await expect(load()).resolves.toMatchObject({ VERSION: PINNED_PI_VERSION })
    expect(attempts).toBe(2)
    expect(configure).toHaveBeenCalledOnce()
  })
})
