import { appendFileSync, realpathSync } from 'node:fs'
import { dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { z } from 'zod'
import { McpServer } from '@modelcontextprotocol/server'
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio'

const output = process.argv[2]
const directory = realpathSync(dirname(output))
if (![realpathSync(tmpdir()), '/private/tmp'].some(root => directory.startsWith(`${root}/`))) throw new Error('Disposable output required')
const server = new McpServer({ name: 'disposable-memory-mirror', version: '1' })
server.registerTool('mirror_fact', { description: 'Append a synthetic fact to disposable probe storage', inputSchema: z.object({ plugin: z.string(), id: z.string(), title: z.string(), body: z.string() }) }, async (args) => {
  appendFileSync(output, `${JSON.stringify(args)}\n`, { mode: 0o600 })
  return { content: [{ type: 'text', text: 'Mirrored' }] }
})
await server.connect(new StdioServerTransport())
