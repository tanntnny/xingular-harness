// What every harness module is given: where the data lives, and what the embedding application
// knows that the harness does not.

/** Names the harness shows but does not own. Every lookup may answer `null`. */
export interface Directory {
  /** An agent's display name. */
  agentName(agentId: string): string | null
  /** The agent a conversation belongs to, when the session id is not the agent's own id. */
  sessionAgent(sessionId: string): string | null
}

/** The name used when an application gives none. */
export const DEFAULT_PRODUCT_NAME = 'Xingular Harness'

export const EMPTY_DIRECTORY: Directory = { agentName: () => null, sessionAgent: () => null }

export interface HarnessEnv {
  /** The data root: `wiki/`, `registry/`, `runs/`, `config/`, `index.sqlite`. */
  root: string
  directory: Directory
  /** How the harness names itself to a model and in the Wiki it creates. */
  productName: string
}

export function createEnv(root: string, options: Partial<Omit<HarnessEnv, 'root'>> = {}): HarnessEnv {
  return { root, directory: options.directory ?? EMPTY_DIRECTORY, productName: options.productName ?? DEFAULT_PRODUCT_NAME }
}
