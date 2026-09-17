import type { EventRecord } from '@core/types';
import { ChevronRight, Search } from 'lucide-react';
import { useState } from 'react';
import { formatTime } from '../lib/utils';
import { Badge } from './ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog';

interface EventLogViewerProps {
  events: EventRecord[];
}

export function EventLogViewer({ events }: EventLogViewerProps) {
  const [selectedEvent, setSelectedEvent] = useState<EventRecord | null>(null);
  const [filterType, setFilterType] = useState<string>('ALL');
  const [searchQuery, setSearchQuery] = useState<string>('');

  const filteredEvents = events.filter((e) => {
    if (filterType !== 'ALL' && e.eventType !== filterType) return false;
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      return (
        e.eventType.toLowerCase().includes(q) ||
        e.nodeId?.toLowerCase().includes(q) ||
        e.sequenceId.toString().includes(q)
      );
    }
    return true;
  });

  const getEventBadge = (type: string) => {
    switch (type) {
      case 'WorkflowExecutionStarted':
      case 'WorkflowCompleted':
        return <Badge variant="emerald">{type}</Badge>;
      case 'ActivityCompleted':
        return <Badge variant="cyan">{type}</Badge>;
      case 'ActivityFailed':
      case 'WorkflowFailed':
        return <Badge variant="rose">{type}</Badge>;
      case 'ActivityCancelled':
        return <Badge variant="amber">{type}</Badge>;
      case 'WorkflowCompensating':
      case 'CompensationStarted':
      case 'CompensationCompleted':
        return <Badge variant="purple">{type}</Badge>;
      case 'WorkflowPoisonPillBlocked':
        return <Badge variant="destructive">{type}</Badge>;
      case 'WorkerFencingRejected':
        return <Badge variant="rose">Fencing Rejected</Badge>;
      case 'WorkflowRecoveredFromCrash':
        return <Badge variant="emerald">Crash Recovered</Badge>;
      default:
        return <Badge variant="glass">{type}</Badge>;
    }
  };

  return (
    <Card className="border-border shadow-xs">
      <CardHeader className="pb-3.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-sm font-semibold text-foreground">
            Append-Only Event Store
          </CardTitle>
          <Badge variant="outline" className="text-xs font-mono font-normal">
            {events.length} events
          </Badge>
        </div>
        <CardDescription className="text-xs text-muted-foreground">
          Immutable event log enabling zero-loss crash replay and deterministic time travel.
        </CardDescription>

        {/* Filter Bar */}
        <div className="flex flex-wrap items-center gap-2 pt-2">
          <div className="relative flex-1 min-w-[180px]">
            <Search className="size-3.5 absolute left-2.5 top-2.5 text-muted-foreground" />
            <input
              type="text"
              placeholder="Filter by event type, node, or sequence..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full h-8 bg-background border border-border rounded-md pl-8 pr-3 text-xs text-foreground placeholder:text-muted-foreground outline-none focus:border-primary transition-colors"
            />
          </div>

          <select
            value={filterType}
            onChange={(e) => setFilterType(e.target.value)}
            className="h-8 bg-background border border-border rounded-md px-2.5 text-xs text-foreground outline-none cursor-pointer focus:border-primary transition-colors"
          >
            <option value="ALL">All Event Types</option>
            <option value="ActivityCompleted">ActivityCompleted</option>
            <option value="ActivityFailed">ActivityFailed</option>
            <option value="WorkerFencingRejected">WorkerFencingRejected</option>
            <option value="WorkflowCompensating">WorkflowCompensating</option>
            <option value="CompensationCompleted">CompensationCompleted</option>
            <option value="WorkflowRecoveredFromCrash">WorkflowRecoveredFromCrash</option>
            <option value="WorkflowPoisonPillBlocked">WorkflowPoisonPillBlocked</option>
          </select>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        <div className="max-h-[380px] overflow-y-auto divide-y divide-border border-t border-border">
          {filteredEvents.length === 0 ? (
            <div className="p-8 text-center text-xs text-muted-foreground">
              No events recorded matching criteria.
            </div>
          ) : (
            filteredEvents.map((evt) => (
              <button
                type="button"
                key={evt.id}
                onClick={() => setSelectedEvent(evt)}
                className="w-full text-left p-3 hover:bg-muted/40 cursor-pointer transition-colors flex items-center justify-between gap-3 text-xs border-0 bg-transparent"
              >
                <div className="flex items-center gap-2.5 min-w-0">
                  <div className="px-1.5 py-0.5 rounded bg-muted border border-border font-mono font-medium text-[11px] text-muted-foreground shrink-0">
                    #{evt.sequenceId}
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 mb-0.5">
                      {getEventBadge(evt.eventType)}
                      {evt.nodeId && (
                        <span className="font-mono text-foreground font-medium text-xs truncate">
                          {evt.nodeId}
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-muted-foreground font-mono">
                      {formatTime(evt.metadata?.timestamp || evt.createdAt)}
                      {evt.metadata?.workerId ? ` • worker: ${evt.metadata.workerId}` : ''}
                      {evt.metadata?.fencingToken ? ` • fence: #${evt.metadata.fencingToken}` : ''}
                    </div>
                  </div>
                </div>

                <ChevronRight className="size-4 text-muted-foreground shrink-0" />
              </button>
            ))
          )}
        </div>
      </CardContent>

      {/* JSON Payload Modal */}
      <Dialog
        open={Boolean(selectedEvent)}
        onOpenChange={(open) => !open && setSelectedEvent(null)}
      >
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle className="text-base font-semibold text-foreground">
              Event #{selectedEvent?.sequenceId}: {selectedEvent?.eventType}
            </DialogTitle>
            <DialogDescription className="font-mono text-xs text-muted-foreground">
              ID: {selectedEvent?.id} &bull; Execution: {selectedEvent?.workflowExecutionId}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3.5 pt-2">
            <div>
              <div className="text-xs font-semibold text-muted-foreground mb-1.5">Payload:</div>
              <pre className="p-3 rounded-lg bg-muted/60 border border-border text-xs font-mono overflow-x-auto text-foreground max-h-56 leading-relaxed">
                {JSON.stringify(selectedEvent?.payload, null, 2)}
              </pre>
            </div>

            <div>
              <div className="text-xs font-semibold text-muted-foreground mb-1.5">Metadata:</div>
              <pre className="p-3 rounded-lg bg-muted/60 border border-border text-xs font-mono overflow-x-auto text-foreground max-h-40 leading-relaxed">
                {JSON.stringify(selectedEvent?.metadata, null, 2)}
              </pre>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
