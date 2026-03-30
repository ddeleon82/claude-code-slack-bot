import { query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { ConversationSession } from './types';
import { Logger } from './logger';
import { McpManager, McpServerConfig } from './mcp-manager';
import { config } from './config';
import * as fs from 'fs';
import * as path from 'path';

function buildConradPrompt(baseDir?: string): string {
  const logger = new Logger('ConradPrompt');
  let soulContent = '';
  let userContent = '';
  let memoryContent = '';

  if (baseDir) {
    // Read SOUL.md
    try {
      const soulPath = path.join(baseDir, 'SOUL.md');
      if (fs.existsSync(soulPath)) {
        soulContent = fs.readFileSync(soulPath, 'utf-8');
        logger.info('Loaded SOUL.md', { path: soulPath });
      }
    } catch (e) { logger.warn('Failed to read SOUL.md', e); }

    // Read USER.md
    try {
      const userPath = path.join(baseDir, 'USER.md');
      if (fs.existsSync(userPath)) {
        userContent = fs.readFileSync(userPath, 'utf-8');
        logger.info('Loaded USER.md', { path: userPath });
      }
    } catch (e) { logger.warn('Failed to read USER.md', e); }

    // Read today's and yesterday's memory files
    try {
      const memoryDir = path.join(baseDir, 'memory');
      if (fs.existsSync(memoryDir)) {
        const today = new Date();
        const yesterday = new Date(today);
        yesterday.setDate(yesterday.getDate() - 1);
        const formatDate = (d: Date) => d.toISOString().split('T')[0];

        for (const date of [formatDate(today), formatDate(yesterday)]) {
          const memFile = path.join(memoryDir, `${date}.md`);
          if (fs.existsSync(memFile)) {
            const content = fs.readFileSync(memFile, 'utf-8');
            memoryContent += `\n### Memory: ${date}\n${content}\n`;
            logger.info('Loaded memory file', { date });
          }
        }
      }
    } catch (e) { logger.warn('Failed to read memory files', e); }
  }

  let prompt = `You are Conrad — AI Chief of Staff & first digital employee at Freedom & Coffee.

IMPORTANT: Do NOT read SOUL.md, USER.md, or memory files — their contents are already loaded below. Just respond directly to the user's message.

## Messaging Rules (Slack)
- You're a participant in this workspace, not a proxy for Dom.
- PRIVACY: Dom's personal information (family details, health, finances, legal matters, Spain move plans, personal history) is NEVER shared with team members (Rachel, Bea, or anyone else). Only discuss business-relevant context with the team.
- Private things stay private — do NOT load MEMORY.md in shared/group contexts.
- Be concise in routine. Go deep when it matters.
- Keep formatting Slack-friendly (no markdown tables, use bullet lists).
- Do NOT use tools or read files unless the user's request specifically requires it.
`;

  if (soulContent) {
    prompt += `\n## SOUL.md (Your Identity)\n${soulContent}\n`;
  }

  if (userContent) {
    prompt += `\n## USER.md (User Context)\n${userContent}\n`;
  }

  if (memoryContent) {
    prompt += `\n## Recent Memory${memoryContent}\n`;
  }

  return prompt;
}

// Build the system prompt once at startup, refresh memory daily
let conradPrompt = buildConradPrompt(config.baseDirectory);
let lastMemoryRefresh = new Date();

function getConradPrompt(): string {
  // Refresh memory content if it's been more than 1 hour
  const now = new Date();
  if (now.getTime() - lastMemoryRefresh.getTime() > 60 * 60 * 1000) {
    conradPrompt = buildConradPrompt(config.baseDirectory);
    lastMemoryRefresh = now;
  }
  return conradPrompt;
}

export class ClaudeHandler {
  private sessions: Map<string, ConversationSession> = new Map();
  private logger = new Logger('ClaudeHandler');
  private mcpManager: McpManager;

  constructor(mcpManager: McpManager) {
    this.mcpManager = mcpManager;
  }

  getSessionKey(userId: string, channelId: string, threadTs?: string): string {
    return `${userId}-${channelId}-${threadTs || 'direct'}`;
  }

  getSession(userId: string, channelId: string, threadTs?: string): ConversationSession | undefined {
    return this.sessions.get(this.getSessionKey(userId, channelId, threadTs));
  }

  createSession(userId: string, channelId: string, threadTs?: string): ConversationSession {
    const session: ConversationSession = {
      userId,
      channelId,
      threadTs,
      isActive: true,
      lastActivity: new Date(),
    };
    this.sessions.set(this.getSessionKey(userId, channelId, threadTs), session);
    return session;
  }

  async *streamQuery(
    prompt: string,
    session?: ConversationSession,
    abortController?: AbortController,
    workingDirectory?: string,
    slackContext?: { channel: string; threadTs?: string; user: string }
  ): AsyncGenerator<SDKMessage, void, unknown> {
    const options: any = {
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      abortController: abortController || new AbortController(),
      agent: 'conrad',
      agents: {
        'conrad': {
          description: 'Conrad — AI Chief of Staff at Freedom & Coffee',
          prompt: getConradPrompt(),
        },
      },
    };

    if (workingDirectory) {
      options.cwd = workingDirectory;
    }

    // Add MCP server configuration if available
    const mcpServers = this.mcpManager.getServerConfiguration();
    if (mcpServers && Object.keys(mcpServers).length > 0) {
      options.mcpServers = mcpServers;
    }
    
    if (options.mcpServers && Object.keys(options.mcpServers).length > 0) {
      const defaultMcpTools = this.mcpManager.getDefaultAllowedTools();
      if (defaultMcpTools.length > 0) {
        options.allowedTools = defaultMcpTools;
      }

      this.logger.debug('Added MCP configuration to options', {
        serverCount: Object.keys(options.mcpServers).length,
        servers: Object.keys(options.mcpServers),
        allowedTools: defaultMcpTools,
      });
    }

    if (session?.sessionId) {
      options.resume = session.sessionId;
      this.logger.debug('Resuming session', { sessionId: session.sessionId });
    } else {
      this.logger.debug('Starting new Claude conversation');
    }

    this.logger.debug('Claude query options', options);

    try {
      for await (const message of query({
        prompt,
        options,
      })) {
        if (message.type === 'system' && message.subtype === 'init') {
          if (session) {
            session.sessionId = message.session_id;
            this.logger.info('Session initialized', { 
              sessionId: message.session_id,
              model: (message as any).model,
              tools: (message as any).tools?.length || 0,
            });
          }
        }
        yield message;
      }
    } catch (error) {
      this.logger.error('Error in Claude query', error);
      throw error;
    }
  }

  cleanupInactiveSessions(maxAge: number = 30 * 60 * 1000) {
    const now = Date.now();
    let cleaned = 0;
    for (const [key, session] of this.sessions.entries()) {
      if (now - session.lastActivity.getTime() > maxAge) {
        this.sessions.delete(key);
        cleaned++;
      }
    }
    if (cleaned > 0) {
      this.logger.info(`Cleaned up ${cleaned} inactive sessions`);
    }
  }
}