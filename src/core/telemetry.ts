import type { EventRecord, TelemetryFrame, WorkflowStatus } from './types';

export class TelemetryBroadcaster {
  private sockets = new Set<any>();

  addSocket(ws: any) {
    this.sockets.add(ws);
  }

  removeSocket(ws: any) {
    this.sockets.delete(ws);
  }

  getSocketCount(): number {
    return this.sockets.size;
  }

  broadcast(frame: TelemetryFrame) {
    const payload = JSON.stringify({
      type: 'TELEMETRY_FRAME',
      data: frame,
    });

    for (const ws of this.sockets) {
      try {
        ws.send(payload);
      } catch {
        this.sockets.delete(ws);
      }
    }
  }

  broadcastEvent(event: EventRecord) {
    const payload = JSON.stringify({
      type: 'EVENT_RECORD',
      data: event,
    });

    for (const ws of this.sockets) {
      try {
        ws.send(payload);
      } catch {
        this.sockets.delete(ws);
      }
    }
  }

  broadcastStatusChange(executionId: string, status: WorkflowStatus) {
    const payload = JSON.stringify({
      type: 'WORKFLOW_STATUS_CHANGED',
      data: { executionId, status },
    });

    for (const ws of this.sockets) {
      try {
        ws.send(payload);
      } catch {
        this.sockets.delete(ws);
      }
    }
  }
}

export const telemetryBroadcaster = new TelemetryBroadcaster();
