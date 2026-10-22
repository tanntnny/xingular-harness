export const WORKING_VERBS = [
  'Accomplishing',
  'Actioning',
  'Actualizing',
  'Architecting',
  'Baking',
  'Beaming',
  'Beboppin\'',
  'Befuddling',
  'Billowing',
  'Blanching',
  'Bloviating',
  'Boogieing',
  'Boondoggling',
  'Booping',
  'Bootstrapping',
  'Brewing',
  'Bunning',
  'Burrowing',
  'Calculating',
  'Canoodling',
  'Caramelizing',
  'Cascading',
  'Catapulting',
  'Cerebrating',
  'Channeling',
  'Choreographing',
  'Churning',
  'Clauding',
  'Coalescing',
  'Cogitating',
  'Combobulating',
  'Composing',
  'Computing',
  'Concocting',
  'Considering',
  'Contemplating',
  'Cooking',
  'Crafting',
  'Creating',
  'Crunching',
  'Crystallizing',
  'Cultivating',
  'Deciphering',
  'Deliberating',
  'Determining',
  'Dilly-dallying',
  'Discombobulating',
  'Doing',
  'Doodling',
  'Drizzling',
  'Ebbing',
  'Effecting',
  'Elucidating',
  'Embellishing',
  'Enchanting',
  'Envisioning',
  'Fermenting',
  'Fiddle-faddling',
  'Finagling',
  'Flambéing',
  'Flibbertigibbeting',
  'Flowing',
  'Flummoxing',
  'Fluttering',
  'Forging',
  'Forming',
  'Frolicking',
  'Frosting',
  'Gallivanting',
  'Galloping',
  'Garnishing',
  'Generating',
  'Gesticulating',
  'Germinating',
  'Gitifying',
  'Grooving',
  'Gusting',
  'Harmonizing',
  'Hashing',
  'Hatching',
  'Herding',
  'Honking',
  'Hullaballooing',
  'Hyperspacing',
  'Ideating',
  'Imagining',
  'Improvising',
  'Incubating',
  'Inferring',
  'Infusing',
  'Ionizing',
  'Jitterbugging',
  'Julienning',
  'Kerfuffling',
  'Kneading',
  'Leavening',
  'Levitating',
  'Lollygagging',
  'Manifesting',
  'Marinating',
  'Meandering',
  'Metamorphosing',
  'Misting',
  'Moonwalking',
  'Moseying',
  'Mulling',
  'Mustering',
  'Nebulizing',
  'Nesting',
  'Newspapering',
  'Noodling',
  'Nucleating',
  'Onioning',
  'Orbiting',
  'Orchestrating',
  'Osmosing',
  'Perambulating',
  'Percolating',
  'Perusing',
  'Philosophizing',
  'Photosynthesizing',
  'Polishing',
  'Pollinating',
  'Pondering',
  'Pontificating',
  'Pouncing',
  'Precipitating',
  'Prestidigitating',
  'Processing',
  'Proofing',
  'Propagating',
  'Puttering',
  'Puzzling',
  'Quantumizing',
  'Razzle-dazzling',
  'Razzmatazzing',
  'Recombobulating',
  'Reticulating',
  'Roosting',
  'Ruminating',
  'Sautéing',
  'Scampering',
  'Schlepping',
  'Scurrying',
  'Seasoning',
  'Shenaniganing',
  'Shimmying',
  'Simmering',
  'Skedaddling',
  'Sketching',
  'Slithering',
  'Smooshing',
  'Sock-hopping',
  'Spelunking',
  'Spinning',
  'Sprouting',
  'Stewing',
  'Sublimating',
  'Swirling',
  'Swooping',
  'Symbioting',
  'Synthesizing',
  'Tempering',
  'Thinking',
  'Thundering',
  'Tinkering',
  'Tomfoolering',
  'Topsy-turvying',
  'Transfiguring',
  'Transmogrifying',
  'Transmuting',
  'Twisting',
  'Undulating',
  'Unfurling',
  'Unraveling',
  'Vibing',
  'Waddling',
  'Wandering',
  'Warping',
  'Whatchamacalliting',
  'Whirlpooling',
  'Whirring',
  'Whisking',
  'Wibbling',
  'Working',
  'Wrangling',
  'Zesting',
  'Zigzagging'
] as const

export const COMPLETION_VERBS = ['Baked', 'Brewed', 'Churned', 'Cogitated', 'Cooked', 'Crunched', 'Sautéed', 'Worked'] as const

export const SPINNER_INTERVAL_MS = 80

const spinnerSequence = ['·', '✢', '✳', '✶', '✻', '✽'] as const
const ghosttySpinnerSequence = ['·', '✢', '✳', '✶', '✻', '✻'] as const

const spinnerFrames = [...spinnerSequence, ...spinnerSequence.slice().reverse()]
const ghosttySpinnerFrames = [...ghosttySpinnerSequence, ...ghosttySpinnerSequence.slice().reverse()]

export function getWorkingSpinnerFrames(term?: string): readonly string[] {
  return term === 'xterm-ghostty' ? ghosttySpinnerFrames : spinnerFrames
}

export function spinnerFrameAt(elapsedMs: number, frames: readonly string[], intervalMs = SPINNER_INTERVAL_MS): string {
  if (frames.length === 0) return ''
  const elapsed = Number.isFinite(elapsedMs) ? Math.max(0, elapsedMs) : 0
  const interval = Number.isFinite(intervalMs) ? Math.max(1, intervalMs) : SPINNER_INTERVAL_MS
  return frames[Math.floor(elapsed / interval) % frames.length] ?? ''
}

export function chooseWorkingVerb(random: () => number = Math.random): string {
  const sample = random()
  const index = Number.isFinite(sample)
    ? Math.min(WORKING_VERBS.length - 1, Math.max(0, Math.floor(sample * WORKING_VERBS.length)))
    : 0
  return WORKING_VERBS[index] ?? 'Working'
}

export function chooseCompletionVerb(turnId: string): string {
  let hash = 0
  for (let index = 0; index < turnId.length; index += 1) {
    hash = (hash << 5) - hash + turnId.charCodeAt(index) | 0
  }
  return COMPLETION_VERBS[(hash >>> 0) % COMPLETION_VERBS.length] ?? 'Worked'
}

export function formatWorkingDuration(durationMs: number): string {
  const seconds = Math.floor((Number.isFinite(durationMs) ? Math.max(0, durationMs) : 0) / 1000)
  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = seconds % 60
  return minutes > 0 ? `${minutes}m${remainingSeconds ? ` ${remainingSeconds}s` : ''}` : `${seconds}s`
}

export function createCompletionStatus(turnId: string, durationMs: number): string {
  return `✻ ${chooseCompletionVerb(turnId)} for ${formatWorkingDuration(durationMs)}`
}
