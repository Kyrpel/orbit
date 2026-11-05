import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { ConversationDetailDTO, MissionEventDTO, ServerEvent } from '@orbit/shared';
import { keys } from './api';

/**
 * Subscribes to the server's event stream and keeps cached queries fresh.
 * Mission events are appended in place, so the timeline updates live.
 */
export function useLiveUpdates(enabled: boolean): 'connecting' | 'live' | 'offline' {
  const qc = useQueryClient();
  const [state, setState] = useState<'connecting' | 'live' | 'offline'>('connecting');

  useEffect(() => {
    if (!enabled) return;
    const source = new EventSource('/api/stream');
    let missionTimer: ReturnType<typeof setTimeout> | null = null;
    const pending = new Set<string>();
    const flushMissions = () => {
      for (const id of pending) void qc.invalidateQueries({ queryKey: keys.mission(id) });
      pending.clear();
      void qc.invalidateQueries({ queryKey: ['missions'] });
      void qc.invalidateQueries({ queryKey: keys.overview });
      missionTimer = null;
    };
    source.onopen = () => setState('live');
    source.onerror = () => setState(source.readyState === EventSource.CLOSED ? 'offline' : 'connecting');
    source.onmessage = (msg) => {
      let e: ServerEvent;
      try {
        e = JSON.parse(msg.data) as ServerEvent;
      } catch {
        return;
      }
      switch (e.type) {
        case 'mission.event': {
          qc.setQueryData<MissionEventDTO[]>(keys.events(e.missionId), (old) => (old && !old.some((x) => x.id === e.event.id) ? [...old, e.event] : old));
          if (e.event.kind === 'state' || e.event.kind === 'approval' || e.event.kind === 'command' || e.event.kind === 'external') {
            pending.add(e.missionId);
            if (!missionTimer) missionTimer = setTimeout(flushMissions, 250);
          }
          break;
        }
        case 'mission.updated':
          pending.add(e.missionId);
          if (!missionTimer) missionTimer = setTimeout(flushMissions, 150);
          break;
        case 'chat.event':
          // Steps stream into the open conversation without a refetch.
          qc.setQueryData<ConversationDetailDTO>(keys.chat(e.conversationId), (old) =>
            old && !old.events.some((x) => x.id === e.event.id) ? { ...old, events: [...old.events, e.event] } : old,
          );
          break;
        case 'chat.updated':
          void qc.invalidateQueries({ queryKey: keys.chat(e.conversationId) });
          void qc.invalidateQueries({ queryKey: keys.chats });
          break;
        case 'repo.changed':
          void qc.invalidateQueries({ queryKey: keys.changes(e.repoId) });
          break;
        case 'repos.updated':
          void qc.invalidateQueries({ queryKey: keys.repos });
          break;
        case 'integrations.updated':
          void qc.invalidateQueries({ queryKey: keys.integrations });
          void qc.invalidateQueries({ queryKey: keys.projects });
          break;
        case 'settings.updated':
          void qc.invalidateQueries({ queryKey: keys.settings });
          void qc.invalidateQueries({ queryKey: keys.agents });
          void qc.invalidateQueries({ queryKey: keys.team });
          void qc.invalidateQueries({ queryKey: keys.doctor });
          break;
        case 'trigger.received':
          void qc.invalidateQueries({ queryKey: keys.activity });
          break;
        default:
          break;
      }
    };
    return () => {
      source.close();
      if (missionTimer) clearTimeout(missionTimer);
    };
  }, [enabled, qc]);

  return state;
}
