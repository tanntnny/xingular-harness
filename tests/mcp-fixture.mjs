import { McpServer } from '@modelcontextprotocol/server'
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio'

const server = new McpServer({ name: 'fixture', version: '1' })
server.registerTool('read_record', { description: 'Read fixture record' }, async () => ({ content: [{ type: 'text', text: process.env.MCP_FIXTURE_VALUE ?? 'fixture' }] }))
server.registerTool('change_record', { description: 'Change fixture record' }, async () => ({ content: [{ type: 'text', text: 'changed' }] }))
await server.connect(new StdioServerTransport())
