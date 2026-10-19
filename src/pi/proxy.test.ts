import { execFile } from 'node:child_process'
import { createServer } from 'node:http'
import { promisify } from 'node:util'
import { afterEach, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)
const servers: ReturnType<typeof createServer>[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
})

it('routes Pi HTTP requests through the process proxy environment', async () => {
  const requests: Array<{ url: string | undefined; host: string | undefined; tunnel: boolean }> = []
  const proxy = createServer((request, response) => {
    requests.push({ url: request.url, host: request.headers.host, tunnel: false })
    response.writeHead(200, { 'content-type': 'text/plain' })
    response.end('served by local proxy')
  })
  proxy.on('connect', (request, socket, head) => {
    requests.push({ url: request.url, host: request.headers.host, tunnel: true })
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
    let received = head.toString('utf8')
    const respond = (): void => {
      if (!received.includes('\r\n\r\n')) return
      const body = 'served by local proxy'
      socket.end(`HTTP/1.1 200 OK\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`)
    }
    socket.on('data', chunk => {
      received += chunk.toString('utf8')
      respond()
    })
    respond()
  })
  servers.push(proxy)
  await new Promise<void>((resolve, reject) => {
    proxy.once('error', reject)
    proxy.listen(0, '127.0.0.1', resolve)
  })

  const address = proxy.address()
  if (!address || typeof address === 'string') throw new Error('The local proxy did not bind to a TCP port.')
  const proxyUrl = `http://127.0.0.1:${address.port}`
  const script = `
    import { join } from 'node:path'
    import { pathToFileURL } from 'node:url'

    const pi = await import('@earendil-works/pi-coding-agent')
    const dispatcherUrl = pathToFileURL(join(pi.getPackageDir(), 'dist/bundle/chunks/chunk-TJXZSVTD.js')).href
    const { configureHttpDispatcher } = await import(dispatcherUrl)
    configureHttpDispatcher()
    const response = await fetch('http://127.0.0.2/dispatcher-check')
    if (response.status !== 200 || await response.text() !== 'served by local proxy') throw new Error('Pi did not receive the local proxy response')
  `
  const env: NodeJS.ProcessEnv = {
    ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
    HTTP_PROXY: proxyUrl,
    HTTPS_PROXY: proxyUrl,
    NO_PROXY: 'localhost,127.0.0.1'
  }

  await execFileAsync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: process.cwd(),
    env,
    timeout: 10_000
  })

  expect(requests).toEqual([{ url: '127.0.0.2:80', host: '127.0.0.2', tunnel: true }])
})
