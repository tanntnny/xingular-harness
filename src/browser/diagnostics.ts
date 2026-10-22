import { accessSync, constants } from 'node:fs'
import type { BrowserConfig } from './config'
import type { DoctorCheck } from '../doctor/types'

const outputText = (result: string | { text: string }) => typeof result === 'string' ? result : result.text

/** Exercises the production tool path against a synthetic page in a throwaway profile. */
export function browserDiagnostic(configure: () => BrowserConfig): DoctorCheck {
  return {
    id: 'browser', category: 'browser', title: 'Isolated browser',
    tools: ['browser_navigate', 'browser_read', 'browser_snapshot', 'browser_click'],
    local: async () => {
      const config = configure()
      if (config.executablePath) accessSync(config.executablePath, constants.X_OK)
      return { status: 'pass', evidence: `Browser tools are installed. ${config.cdpUrl ? 'A CDP endpoint is configured; diagnostics will not attach to it.' : 'A dedicated browser will be launched only after live-check confirmation.'} Browser launch is unverified.` }
    },
    live: {
      notice: 'Launch a dedicated headless browser with a disposable profile, open an offline synthetic page, read its marker, and click its test button. No existing browser or profile is used.',
      run: async probe => {
        if (configure().cdpUrl) return { status: 'blocked', evidence: 'This backend is configured to attach to a browser. Isolated diagnostics will not attach to it.', remedy: 'Use a dedicated launch configuration to test browser interaction.' }
        const needed = ['browser_navigate', 'browser_read', 'browser_snapshot', 'browser_click']
        if (needed.some(name => !probe.context.tools.includes(name))) return { status: 'blocked', evidence: 'The browser interaction test requires navigate, read, snapshot, and click capabilities.' }
        const html = '<!doctype html><title>Harness Doctor</title><p>doctor-ready</p><button onclick="document.querySelector(\'p\').textContent=\'doctor-clicked\'">Diagnostic test</button>'
        await probe.call('browser_navigate', { url: `data:text/html,${encodeURIComponent(html)}` })
        const before = outputText(await probe.call('browser_read', {}))
        if (!before.includes('doctor-ready')) return { status: 'fail', evidence: 'The diagnostic page marker could not be read.' }
        const snapshot = outputText(await probe.call('browser_snapshot', {}))
        const line = snapshot.split('\n').find(line => line.includes('button') && line.includes('Diagnostic test'))
        const ref = line && /\b(e\d+)\b/.exec(line)?.[1]
        if (!ref) return { status: 'fail', evidence: 'The test button was absent from the browser snapshot.' }
        await probe.call('browser_click', { ref })
        const after = outputText(await probe.call('browser_read', {}))
        return after.includes('doctor-clicked') ? { status: 'pass', evidence: 'Navigation, reading, element discovery, and clicking succeeded in the disposable diagnostic browser.' } : { status: 'fail', evidence: 'Clicking did not change the expected page marker.' }
      }
    }
  }
}
