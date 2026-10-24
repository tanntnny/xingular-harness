import type { SecretStore } from '../accounts/secrets'
import type { WorldPart } from '../world/world'
import type { ToolSession, ToolSpec } from '../tools/types'
import type { WebRequest } from './safeRequest'
import { KEYLESS_SEARCH, WEB_PLUGIN, webTools } from './tools'

export function webPart(options: { secrets: SecretStore; request?: WebRequest; keyless: () => boolean }): WorldPart {
  const provider = webTools({ secrets: options.secrets, request: options.request, keyless: options.keyless })
  return { plugin: WEB_PLUGIN, tools: () => provider({} as ToolSession) as ToolSpec[] }
}

export { KEYLESS_SEARCH }
