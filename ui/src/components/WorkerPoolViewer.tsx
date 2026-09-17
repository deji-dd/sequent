import type { WorkerLease } from '@core/types';
import { useEffect, useState } from 'react';
import { Badge } from './ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card';

interface WorkerPoolViewerProps {
  activeLeases: WorkerLease[];
  activeFencingToken: number;
  zombieWritesBlocked: number;
}

export function WorkerPoolViewer({
  activeLeases,
  activeFencingToken,
  zombieWritesBlocked,
}: WorkerPoolViewerProps) {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, []);

  return (
    <Card className="border-border shadow-xs">
      <CardHeader className="pb-3.5">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-semibold text-foreground">
            Distributed Worker Leases
          </CardTitle>
        </div>
        <CardDescription className="text-xs text-muted-foreground">
          Strictly monotonic tokens preventing split-brain writes during worker GC pauses.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3.5">
        {/* Token summary header */}
        <div className="grid grid-cols-2 gap-3 text-xs">
          <div className="p-3 rounded-lg bg-muted/40 border border-border">
            <div className="text-xs text-muted-foreground">Active Fence Token</div>
            <div className="text-base font-semibold font-mono text-foreground mt-0.5">
              #{activeFencingToken || 0}
            </div>
          </div>
          <div className="p-3 rounded-lg bg-muted/40 border border-border">
            <div className="text-xs text-muted-foreground">Zombie Writes Blocked</div>
            <div className="text-base font-semibold font-mono text-foreground mt-0.5">
              {zombieWritesBlocked}
            </div>
          </div>
        </div>

        {/* Leases list */}
        <div className="space-y-2.5">
          <div className="text-xs font-medium text-muted-foreground">
            Active Leases ({activeLeases.length})
          </div>

          {activeLeases.length === 0 ? (
            <div className="p-5 rounded-lg border border-dashed border-border text-center text-xs text-muted-foreground">
              No active worker leases right now.
            </div>
          ) : (
            activeLeases.map((lease) => {
              const remainingMs = Math.max(0, lease.expiresAt - now);
              const ttlPercent = Math.min(100, Math.max(0, (remainingMs / lease.ttlMs) * 100));

              return (
                <div
                  key={`${lease.workflowExecutionId}:${lease.nodeId}`}
                  className="p-3.5 rounded-lg bg-card border border-border space-y-2.5 shadow-xs"
                >
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-mono font-medium text-foreground">{lease.workerId}</span>
                    <Badge variant="secondary" className="font-mono text-[11px]">
                      Fence #{lease.fencingToken}
                    </Badge>
                  </div>

                  <div className="text-xs text-muted-foreground font-mono">
                    Target Node: <span className="text-foreground">{lease.nodeId}</span>
                  </div>

                  {/* Lease TTL progress */}
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between text-[11px] font-mono text-muted-foreground">
                      <span>Heartbeat TTL</span>
                      <span>{(remainingMs / 1000).toFixed(1)}s</span>
                    </div>
                    <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
                      <div
                        className="h-full bg-primary transition-all duration-200"
                        style={{ width: `${ttlPercent}%` }}
                      />
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </CardContent>
    </Card>
  );
}
