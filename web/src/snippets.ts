// Ready-to-paste settings that connect an AI assistant to Master Tasker, with this Mac's real paths.
// Every app runs the same small MCP server (mcp/server.ts) with Node; only the file format differs.
// They name the file that holds the connection's token (MASTER_TASKER_TOKEN_FILE), never the token itself,
// so it stays out of the app's settings file and your Terminal history.
// The JSON ones are just the master-tasker entry, without braces around it, so pasting it among the servers
// an app already has can't leave a stray brace. Codex and Claude Code get a command instead of a file to edit.
// The file paths and formats come from each app's own docs (see docs/MCP.md).

export interface AgentPaths {
  /** The Node that runs Master Tasker. */
  node: string;
  /** mcp/server.ts in this copy of Master Tasker. */
  mcpServer: string;
  /** Where Master Tasker is listening. */
  url: string;
}

/** Every app with its own settings, in the order Settings lists the assistants. */
export const AGENT_LABEL = {
  'claude-code': 'Claude Code',
  codex: 'Codex (ChatGPT)',
  vscode: 'GitHub Copilot (VS Code)',
  cursor: 'Cursor',
  gemini: 'Gemini CLI',
  windsurf: 'Windsurf (Devin Desktop)',
  other: 'Other app',
} as const;
export type AssistantAppId = keyof typeof AGENT_LABEL;
export const AGENT_IDS = Object.keys(AGENT_LABEL) as AssistantAppId[];

export interface AgentSnippet {
  id: AssistantAppId;
  /** Tab label. */
  label: string;
  /** Where to paste it, in plain words. */
  where: string;
  /** The connection kind it gets. */
  kind: 'claude' | 'other';
  text: string;
}

/** Quotes for zsh only when needed, so a plain path stays readable. */
export const shellArg = (s: string) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

const env = (tokenFile: string, p: AgentPaths) => ({ MASTER_TASKER_TOKEN_FILE: tokenFile, MASTER_TASKER_URL: p.url });
const server = (tokenFile: string, p: AgentPaths) => ({ command: p.node, args: [p.mcpServer], env: env(tokenFile, p) });
/** One named entry without the braces around it: `"name": { ... }`, ready to paste among other entries. */
const entry = (name: string, v: unknown) =>
  JSON.stringify({ [name]: v }, null, 2)
    .split('\n')
    .slice(1, -1)
    .map((l) => l.slice(2))
    .join('\n');
/** A command split over lines, one option per line, for pasting into Terminal. */
const command = (first: string, options: string[], run: string) => [first, ...options.map((o) => `  ${o}`), `  -- ${run}`].join(' \\\n');
const AMONG = 'after any servers already there, with a comma after the one before it';

/** `tokenFile` is the file the app saved the connection's token in. */
export function agentSnippets(tokenFile: string, p: AgentPaths): AgentSnippet[] {
  const e = Object.entries(env(tokenFile, p)).map(([k, v]) => shellArg(`${k}=${v}`));
  const run = `${shellArg(p.node)} ${shellArg(p.mcpServer)}`;
  return [
    {
      id: 'claude-code',
      label: AGENT_LABEL['claude-code'],
      where: 'Paste this into Terminal and press Return. It gives every Claude Code thread the Master Tasker tools.',
      kind: 'claude',
      text: command(
        'claude mcp add master-tasker --scope user',
        e.map((x) => `-e ${x}`),
        run,
      ),
    },
    {
      id: 'codex',
      label: AGENT_LABEL.codex,
      where:
        "Paste this into Terminal and press Return. It adds Master Tasker to Codex's settings, ~/.codex/config.toml. To edit that file yourself instead, see docs/MCP.md, and add its lines only once: a second copy stops Codex from starting.",
      kind: 'other',
      text: command(
        'codex mcp add master-tasker',
        e.map((x) => `--env ${x}`),
        run,
      ),
    },
    {
      id: 'vscode',
      label: AGENT_LABEL.vscode,
      where: `GitHub Copilot reads its tools from VS Code's own settings. In VS Code, run MCP: Open User Configuration from the Command Palette (Command-Shift-P). Paste this inside the servers braces, ${AMONG}. If the file is empty, start it with {"servers": {}}.`,
      kind: 'other',
      text: entry('master-tasker', { type: 'stdio', ...server(tokenFile, p) }),
    },
    {
      id: 'cursor',
      label: AGENT_LABEL.cursor,
      where: `Paste this inside the mcpServers braces in ~/.cursor/mcp.json, ${AMONG}. If that file is new, start it with {"mcpServers": {}}. Cursor then lists master-tasker under Customize in its sidebar.`,
      kind: 'other',
      text: entry('master-tasker', { type: 'stdio', ...server(tokenFile, p) }),
    },
    {
      id: 'gemini',
      label: AGENT_LABEL.gemini,
      where: `Paste this inside the mcpServers braces in ~/.gemini/settings.json, ${AMONG}. If that file is new, start it with {"mcpServers": {}}. If it has other settings but no mcpServers, add "mcpServers": {}, on the line after its first {. Then run /mcp in Gemini CLI to check that master-tasker is connected.`,
      kind: 'other',
      text: entry('master-tasker', server(tokenFile, p)),
    },
    {
      id: 'windsurf',
      label: AGENT_LABEL.windsurf,
      where: `Windsurf is now called Devin Desktop. Paste this inside the mcpServers braces in ~/.config/devin/mcp_config.json, ${AMONG}. If that file is new, start it with {"mcpServers": {}}.`,
      kind: 'other',
      text: entry('master-tasker', server(tokenFile, p)),
    },
    {
      id: 'other',
      label: AGENT_LABEL.other,
      where: `For any other app on your Mac that can add local tools. Paste this where its settings list them, usually inside the mcpServers braces, ${AMONG}.`,
      kind: 'other',
      text: entry('master-tasker', server(tokenFile, p)),
    },
  ];
}
