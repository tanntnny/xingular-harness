import { spawn } from 'node:child_process'

export interface LinkOpenCommand {
  command: string
  args: string[]
}

/** Only web links from rendered model content can launch an external application. */
export function clickableMarkdownUrl(value: string | null | undefined): string | null {
  if (!value || value.length > 4096 || /[\x00-\x1f\x7f-\x9f]/u.test(value)) return null
  try {
    const url = new URL(value)
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !url.hostname || url.username || url.password) return null
    return url.href
  } catch {
    return null
  }
}

export function linkOpenCommand(value: string, platform = process.platform): LinkOpenCommand {
  const url = clickableMarkdownUrl(value)
  if (!url) throw new Error('Only valid HTTP and HTTPS links can be opened.')
  if (platform === 'darwin') return { command: 'open', args: [url] }
  if (platform === 'win32') return { command: 'rundll32.exe', args: ['url.dll,FileProtocolHandler', url] }
  if (platform === 'linux' || platform === 'freebsd' || platform === 'openbsd') return { command: 'xdg-open', args: [url] }
  throw new Error(`Opening links is not supported on ${platform}.`)
}

export async function openMarkdownLink(value: string): Promise<void> {
  const { command, args } = linkOpenCommand(value)
  await new Promise<void>((resolve, reject) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(command, args, { detached: process.platform !== 'win32', stdio: 'ignore', windowsHide: true })
    } catch (error) {
      reject(error)
      return
    }
    child.once('error', reject)
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
}
