import { invalid } from '../core/errors'

export type Params = Record<string, any>

export const text = (params: Params, name: string): string => {
  const value = params[name]
  if (typeof value !== 'string' || !value) throw invalid(`${name} is required.`)
  return value
}

export const optional = (params: Params, name: string): string | null => (typeof params[name] === 'string' && params[name] ? params[name] as string : null)

export function pick<T extends string>(params: Params, keys: readonly T[]): Record<T, unknown> {
  return Object.fromEntries(keys.filter(key => key in params).map(key => [key, params[key]])) as Record<T, unknown>
}
