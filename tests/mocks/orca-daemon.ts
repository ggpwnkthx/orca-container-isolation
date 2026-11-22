/**
 * Mock Orca daemon.
 *
 * Serves the two calls orca-box-configure-orca makes over Orca's private
 * local socket: settings.getAgentLaunch and settings.mutateAgentLaunch.
 *
 * Usage: orca-daemon.ts <user-data-dir> <socket-path>
 *
 * It writes <user-data-dir>/orca-runtime.json, the file the real Orca app
 * writes, so the client finds it the same way it would find the real thing.
 */

import { createServer } from "node:net";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const AGENTS = ["claude", "codex", "pi"];

// The commands the agents had before orca-box took over. "codex" starts
// with something of its own, so a test can tell a real change from a no-op.
const state: Record<string, string> = {
  claude: "",
  codex: "codex --yolo",
  pi: "",
};

const [userData, socketPath] = process.argv.slice(2);
if (!userData || !socketPath) {
  process.stderr.write("usage: orca-daemon.ts <user-data-dir> <socket-path>\n");
  process.exit(2);
}

mkdirSync(userData, { recursive: true });
writeFileSync(
  join(userData, "orca-runtime.json"),
  JSON.stringify({
    pid: process.pid,
    authToken: "test-token",
    transport: "unix",
    transports: [{ kind: "unix", endpoint: socketPath }],
  }),
);

const server = createServer((socket) => {
  let buffer = "";
  socket.on("data", (chunk) => {
    buffer += chunk.toString();
    let index: number;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (!line.trim()) continue;

      const message = JSON.parse(line);
      let reply: Record<string, unknown>;
      switch (message.method) {
        case "settings.getAgentLaunch":
          reply = {
            id: message.id,
            ok: true,
            result: { settings: { agentCmdOverrides: { ...state } } },
          };
          break;
        case "settings.mutateAgentLaunch": {
          const params = (message.params ?? {}) as { agent?: string; value?: string };
          if (params.agent) state[params.agent] = params.value ?? "";
          reply = { id: message.id, ok: true, result: {} };
          break;
        }
        default:
          reply = {
            id: message.id,
            ok: false,
            error: { message: "no such method" },
          };
      }
      socket.write(`${JSON.stringify(reply)}\n`);
    }
  });
});

server.listen(socketPath, () => {
  process.stdout.write("ready\n");
});
