// The effort levels a model offers, by Pi's rule (`getSupportedThinkingLevels` and
// `clampThinkingLevel` in pi-ai): a model that does not reason offers only `off`; `xhigh` and `max`
// need the model to map them; a map entry of `null` removes a level. The client terminal has no Pi
// session to ask, so it applies the same rule to the model it resolved.
import { EFFORTS } from '../../core/effort'

type Level = (typeof EFFORTS)[number]

/** The part of a model the rule reads. */
export interface LevelModel {
  reasoning?: boolean
  thinkingLevelMap?: Partial<Record<string, string | null>>
}

export function supportedLevels(model: LevelModel | undefined): Level[] {
  if (!model?.reasoning) return ['off']
  return EFFORTS.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level]
    if (mapped === null) return false
    return level === 'xhigh' || level === 'max' ? mapped !== undefined : true
  })
}

/** The level a model runs at when asked for `level`: itself, else the nearest above, else the nearest below. */
export function clampLevel(model: LevelModel | undefined, level: string): Level {
  const available = supportedLevels(model)
  if ((available as string[]).includes(level)) return level as Level
  const requested = (EFFORTS as readonly string[]).indexOf(level)
  if (requested === -1) return available[0] ?? 'off'
  for (let index = requested; index < EFFORTS.length; index++) if (available.includes(EFFORTS[index])) return EFFORTS[index]
  for (let index = requested - 1; index >= 0; index--) if (available.includes(EFFORTS[index])) return EFFORTS[index]
  return available[0] ?? 'off'
}
