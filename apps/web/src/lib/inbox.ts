'use client';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type {
  ContactDTO,
  ConversationDTO,
  ConversationFilter,
  MessageDTO,
  ReplyPermission,
} from '@multizap/shared';
import { api } from './api';
import { toQueryString } from './contacts';

export function useConversations(q: {
  accountId?: string;
  filter: ConversationFilter;
  q?: string;
}) {
  return useQuery({
    queryKey: ['conversations', q],
    queryFn: () =>
      api<{ items: ConversationDTO[]; total: number }>(
        `/conversations?${toQueryString({ ...q, pageSize: 60 })}`,
      ),
    placeholderData: keepPreviousData,
    refetchInterval: 5000,
  });
}

export function useConversation(id: string | null) {
  return useQuery({
    queryKey: ['conversation', id],
    queryFn: () =>
      api<{ conversation: ConversationDTO; contact: ContactDTO | null; reply: ReplyPermission }>(
        `/conversations/${id}`,
      ),
    enabled: !!id,
    refetchInterval: 10_000,
  });
}

export function useMessages(id: string | null) {
  return useQuery({
    queryKey: ['conversation', id, 'messages'],
    queryFn: () =>
      api<{ items: MessageDTO[]; hasMore: boolean }>(`/conversations/${id}/messages?limit=60`),
    enabled: !!id,
    refetchInterval: 3000,
  });
}

export function useUnreadConversations() {
  return useQuery({
    queryKey: ['conversations', 'unread'],
    queryFn: () =>
      api<{ conversations: number }>('/conversations/unread').then((r) => r.conversations),
    refetchInterval: 15_000,
  });
}
