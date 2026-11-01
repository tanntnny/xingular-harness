/**
 * A tool or message id as a person reads it: `todo_write` becomes `TodoWrite`,
 * `computer-screenshot` becomes `ComputerScreenshot`. Only the first letter of each part is
 * raised, so a name that already carries capitals keeps them.
 */
export function toolDisplayName(name: string): string {
  return name
    .split(/[^A-Za-z0-9]+/u)
    .filter(part => part !== '')
    .map(part => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join('')
}
