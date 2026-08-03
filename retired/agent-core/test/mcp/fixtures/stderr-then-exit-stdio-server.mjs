// Simulates a misconfigured MCP stdio server: writes a banner to stderr, then
// exits before completing the protocol handshake. Used to verify that
// StdioMcpClient captures stderr and surfaces it on connect failure.

const banner = process.env['KIMI_TEST_MCP_STDERR'] ?? 'fatal: missing API token';
process.stderr.write(`${banner}\n`);
process.exit(2);
