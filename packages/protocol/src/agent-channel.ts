import { z } from 'zod';

export const CHANNEL_LIMITS = { messageBytes: 2048, pageSize: 20, participants: 50, messagesPerTask: 1000 } as const;
export const ChannelMessageInput = z.object({
  recipientTaskId: z.string().uuid().nullable().default(null),
  content: z.string().trim().min(1).max(CHANNEL_LIMITS.messageBytes).refine(value => new TextEncoder().encode(value).length <= CHANNEL_LIMITS.messageBytes, 'Message exceeds the UTF-8 byte limit.')
}).strict();
export const ChannelTools = {
  list_project_agents: z.object({ afterTaskId: z.string().uuid().optional() }).strict(),
  send_agent_message: ChannelMessageInput,
  read_agent_messages: z.object({ after: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0) }).strict()
} as const;
export interface ChannelParticipant { taskId: string; title: string; role: string; status: string; available: boolean }
export interface AgentMessage { sequence: number; senderTaskId: string; senderTitle: string; actor: 'agent' | 'user'; recipientTaskId: string | null; content: string; createdAt: string }
export interface ChannelPage { messages: AgentMessage[]; nextCursor: number | null }
export interface ChannelView extends ChannelPage { participants: ChannelParticipant[]; participantsCursor: string | null }
export const ChannelRpc = {
  'channel.get': z.object({ taskId: z.string().uuid(), before: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(), afterTaskId: z.string().uuid().optional() }).strict(),
  'channel.send': z.object({ taskId: z.string().uuid(), requestId: z.string().uuid(), ...ChannelMessageInput.shape }).strict()
} as const;
