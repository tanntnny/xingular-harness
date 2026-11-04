import manifest from '../../package.json' with { type: 'json' }

/** The version of this package, as `xagent --version` prints it and the long-lived harness records it. */
export const PACKAGE_VERSION: string = manifest.version
