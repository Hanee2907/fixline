import type { LiveEvent, Role } from '../shared/types.js';

interface Listener {
  userId: number;
  role: Role;
  send: (e: LiveEvent) => void;
}

/**
 * In-memory publish/subscribe per workspace, feeding the Server-Sent Events stream.
 * Agents hear everything in their workspace; an employee only hears about their own tickets
 * (and incidents). Events carry ids only, so nothing private travels over the stream:
 * the browser re-fetches what changed through the normal, permission-checked API.
 */
export class Bus {
  private rooms = new Map<number, Set<Listener>>();

  subscribe(workspaceId: number, l: Listener): () => void {
    let room = this.rooms.get(workspaceId);
    if (!room) this.rooms.set(workspaceId, (room = new Set()));
    room.add(l);
    if (l.role !== 'requester') this.publish(workspaceId, { type: 'presence' });
    return () => {
      room!.delete(l);
      if (room!.size === 0) this.rooms.delete(workspaceId);
      if (l.role !== 'requester') this.publish(workspaceId, { type: 'presence' });
    };
  }

  publish(workspaceId: number, e: LiveEvent) {
    for (const l of this.rooms.get(workspaceId) ?? []) {
      const forRequester = e.type === 'incident' || e.type === 'article' || (e.requesterId !== undefined && e.requesterId === l.userId);
      if (l.role !== 'requester' || forRequester) l.send(e);
    }
  }

  agentsOnline(workspaceId: number): number {
    const ids = new Set<number>();
    for (const l of this.rooms.get(workspaceId) ?? []) if (l.role !== 'requester') ids.add(l.userId);
    return ids.size;
  }
}
