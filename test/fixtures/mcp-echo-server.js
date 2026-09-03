/**
 * The smallest MCP server that can be spawned: one tool, over stdio. The
 * probe test spawns it the way the app spawns an agent's servers.
 */
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');

const server = new McpServer({ name: 'echo-fixture', version: '0.0.1' });
server.registerTool('ping', { description: 'Answers pong.' }, async () => ({ content: [{ type: 'text', text: 'pong' }] }));
server.connect(new StdioServerTransport());
