import type { PoisonPillItem } from '@core/types';
import {
  AlertCircle,
  Archive,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  Copy,
  Inbox,
  Loader2,
  RefreshCw,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { cn, formatTime } from '../lib/utils';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Card } from './ui/card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from './ui/collapsible';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog';
import { ToggleGroup, ToggleGroupItem } from './ui/toggle-group';

interface PoisonPillModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function PoisonPillModal({ open, onOpenChange }: PoisonPillModalProps) {
  const [items, setItems] = useState<PoisonPillItem[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [resolvingId, setResolvingId] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [filter, setFilter] = useState<'ALL' | 'PENDING' | 'RESOLVED'>('ALL');
  const [expandedPayloads, setExpandedPayloads] = useState<Record<string, boolean>>({});
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const fetchItems = async () => {
    setIsLoading(true);
    try {
      const res = await fetch('/api/poison-pill');
      if (res.ok) {
        const data = await res.json();
        setItems(data);
      }
    } catch (err) {
      console.error('Error fetching poison pill queue:', err);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (open) {
      fetchItems();
      setActionMessage(null);
    }
  }, [open]);

  const handleResolve = async (id: string, action: 'RESOLVED' | 'SKIPPED') => {
    setResolvingId(id);
    try {
      const res = await fetch(`/api/poison-pill/${id}/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      if (res.ok) {
        setActionMessage(`Poison pill item marked as ${action}.`);
        await fetchItems();
      }
    } catch (err) {
      console.error('Failed to resolve poison pill:', err);
    } finally {
      setResolvingId(null);
    }
  };

  const togglePayload = (id: string) => {
    setExpandedPayloads((prev) => ({
      ...prev,
      [id]: !prev[id],
    }));
  };

  const copyToClipboard = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 1800);
  };

  const pendingCount = useMemo(() => items.filter((i) => i.status === 'PENDING').length, [items]);
  const resolvedCount = useMemo(() => items.filter((i) => i.status !== 'PENDING').length, [items]);

  const filteredItems = useMemo(() => {
    if (filter === 'PENDING') return items.filter((i) => i.status === 'PENDING');
    if (filter === 'RESOLVED') return items.filter((i) => i.status !== 'PENDING');
    return items;
  }, [items, filter]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[88vh] flex flex-col p-6 overflow-hidden sm:max-w-2xl">
        {/* Header - with right padding pr-12 to prevent overlap with the close button */}
        <DialogHeader className="pr-12 shrink-0 flex flex-col gap-1">
          <DialogTitle className="text-base font-semibold text-foreground flex items-center gap-2">
            Poison Pill Recovery Queue
            {pendingCount > 0 && (
              <Badge
                variant="destructive"
                className="text-[10px] font-mono px-1.5 py-0.5 font-medium"
              >
                {pendingCount} quarantined
              </Badge>
            )}
          </DialogTitle>
          <DialogDescription className="text-xs text-muted-foreground">
            Quarantined workflows where downstream compensation exceeded maximum retries.
          </DialogDescription>
        </DialogHeader>

        {/* Filter bar & stats */}
        <div className="flex items-center justify-between gap-2 pt-1 border-b border-border/60 pb-3 shrink-0">
          <ToggleGroup
            type="single"
            value={filter}
            onValueChange={(val) => {
              if (val) setFilter(val as 'ALL' | 'PENDING' | 'RESOLVED');
            }}
            size="xs"
          >
            <ToggleGroupItem value="ALL">All ({items.length})</ToggleGroupItem>
            <ToggleGroupItem value="PENDING" className="gap-1.5">
              <span>Quarantined</span>
              {pendingCount > 0 && (
                <span className="size-2 rounded-full bg-rose-500 animate-pulse" />
              )}
              <span className="font-mono text-[11px]">({pendingCount})</span>
            </ToggleGroupItem>
            <ToggleGroupItem value="RESOLVED">Resolved ({resolvedCount})</ToggleGroupItem>
          </ToggleGroup>

          <span className="text-[11px] text-muted-foreground hidden sm:inline-block font-mono">
            {filteredItems.length} {filteredItems.length === 1 ? 'item' : 'items'}
          </span>
        </div>

        {/* Action message banner */}
        {actionMessage && (
          <div className="flex items-center justify-between p-2.5 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-xs text-emerald-700 dark:text-emerald-400 shrink-0">
            <div className="flex items-center gap-2">
              <CheckCircle2 className="size-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
              <span>{actionMessage}</span>
            </div>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setActionMessage(null)}
              className="size-6 text-emerald-700/70 hover:text-emerald-700 dark:text-emerald-400/70 dark:hover:text-emerald-300 hover:bg-emerald-500/20"
              title="Dismiss notification"
            >
              <X className="size-3.5" />
            </Button>
          </div>
        )}

        {/* Items List Area */}
        <div className="overflow-y-auto pr-1.5 flex flex-col gap-3 flex-1 min-h-0">
          {filteredItems.length === 0 ? (
            <div className="py-12 px-4 text-center">
              <div className="size-12 rounded-full bg-muted/80 border border-border flex items-center justify-center mx-auto mb-3">
                {filter === 'ALL' || filter === 'PENDING' ? (
                  <CheckCircle2 className="size-6 text-emerald-500" />
                ) : (
                  <Inbox className="size-6 text-muted-foreground/60" />
                )}
              </div>
              <h4 className="text-sm font-semibold text-foreground mb-1">
                {filter === 'PENDING'
                  ? 'No Quarantined Workflows'
                  : filter === 'RESOLVED'
                    ? 'No Resolved Items'
                    : 'Recovery Queue is Empty'}
              </h4>
              <p className="text-xs text-muted-foreground max-w-sm mx-auto mb-4">
                {filter === 'PENDING'
                  ? 'All compensation retries succeeded or no workflows are currently blocked in poison-pill state.'
                  : 'No poison pill failure items match the selected filter.'}
              </p>
              <Button size="sm" variant="outline" onClick={fetchItems} disabled={isLoading}>
                <RefreshCw className={cn('size-3', isLoading && 'animate-spin')} />
                <span>Refresh Status</span>
              </Button>
            </div>
          ) : (
            filteredItems.map((item) => {
              const isPending = item.status === 'PENDING';
              const isExpanded = Boolean(expandedPayloads[item.id]);
              const isResolving = resolvingId === item.id;

              return (
                <Card
                  key={item.id}
                  className={cn(
                    'p-4 flex flex-col gap-3 transition-all duration-150 shadow-xs',
                    isPending
                      ? 'border-rose-500/20 bg-card hover:border-rose-500/40'
                      : 'border-border/70 bg-card/60 opacity-80 hover:opacity-100'
                  )}
                >
                  {/* Card Top Row: Status, Node, Time */}
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <div className="flex items-center gap-2 flex-wrap">
                      <Badge
                        variant={
                          isPending
                            ? 'destructive'
                            : item.status === 'RESOLVED'
                              ? 'emerald'
                              : 'secondary'
                        }
                        className="font-mono text-[10px] px-2 py-0.5 font-medium uppercase gap-1"
                      >
                        {isPending && (
                          <span className="size-1.5 rounded-full bg-rose-500 dark:bg-rose-400 animate-pulse" />
                        )}
                        {item.status}
                      </Badge>
                      <div className="flex items-center gap-1 font-mono text-xs font-semibold text-foreground bg-muted/60 px-2 py-0.5 rounded-md border border-border/60">
                        <span className="text-muted-foreground font-normal text-[11px]">Node:</span>
                        <span>{item.nodeId}</span>
                      </div>
                      {item.compensationType && (
                        <span className="text-[11px] font-mono text-muted-foreground bg-muted/30 px-1.5 py-0.5 rounded border border-border/40">
                          comp: {item.compensationType}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-1 text-[11px] text-muted-foreground font-mono">
                      <Clock className="size-3" />
                      <span>{formatTime(item.blockedAt)}</span>
                    </div>
                  </div>

                  {/* Error Box */}
                  <div className="rounded-lg bg-rose-500/10 dark:bg-rose-950/20 border border-rose-500/20 dark:border-rose-500/30 p-3 text-xs font-mono flex flex-col gap-1.5">
                    <div className="flex items-center gap-1.5 text-rose-700 dark:text-rose-400 font-semibold">
                      <AlertCircle className="size-3.5 shrink-0" />
                      <span>Exhausted {item.attempts} Compensation Retries</span>
                    </div>
                    <div className="text-rose-600 dark:text-rose-300/95 leading-relaxed break-words bg-rose-500/5 dark:bg-rose-900/20 p-2 rounded border border-rose-500/10 text-[11px]">
                      {item.lastError}
                    </div>
                  </div>

                  {/* Expandable Payload Context */}
                  {item.payload && (
                    <Collapsible
                      open={isExpanded}
                      onOpenChange={() => togglePayload(item.id)}
                      className="border border-border/50 rounded-lg overflow-hidden bg-muted/30"
                    >
                      <CollapsibleTrigger asChild>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="w-full justify-between h-auto py-1.5 px-3 text-[11px] font-medium text-muted-foreground hover:text-foreground rounded-none"
                        >
                          <span className="flex items-center gap-1.5">
                            {isExpanded ? (
                              <ChevronDown className="size-3.5" />
                            ) : (
                              <ChevronRight className="size-3.5" />
                            )}
                            <span>Payload Context (Input / Output)</span>
                          </span>
                          <span className="font-mono text-[10px] text-muted-foreground/80">
                            {isExpanded ? 'Hide' : 'Show details'}
                          </span>
                        </Button>
                      </CollapsibleTrigger>

                      <CollapsibleContent className="p-2.5 border-t border-border/50 bg-muted/50 text-xs font-mono">
                        <pre className="p-2 rounded bg-background/80 border border-border/60 overflow-x-auto text-[11px] leading-relaxed text-foreground max-h-40">
                          {JSON.stringify(item.payload, null, 2)}
                        </pre>
                      </CollapsibleContent>
                    </Collapsible>
                  )}

                  {/* Card Footer: Exec ID & Action Buttons */}
                  <div className="flex items-center justify-between gap-3 pt-1 border-t border-border/50 flex-wrap">
                    <div className="flex items-center gap-1.5 text-xs font-mono text-muted-foreground">
                      <span className="text-[11px] text-muted-foreground/70">Exec:</span>
                      <code className="text-[11px] text-foreground font-medium bg-muted/50 px-1.5 py-0.5 rounded border border-border/40">
                        {item.workflowExecutionId}
                      </code>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() =>
                          copyToClipboard(item.workflowExecutionId, item.workflowExecutionId)
                        }
                        className="size-6 text-muted-foreground hover:text-foreground"
                        title="Copy Execution ID"
                      >
                        {copiedId === item.workflowExecutionId ? (
                          <Check className="size-3 text-emerald-500" />
                        ) : (
                          <Copy className="size-3" />
                        )}
                      </Button>
                    </div>

                    {isPending ? (
                      <div className="flex items-center gap-2">
                        <Button
                          size="xs"
                          variant="success"
                          onClick={() => handleResolve(item.id, 'RESOLVED')}
                          disabled={isResolving}
                        >
                          {isResolving ? (
                            <Loader2 className="size-3 animate-spin" />
                          ) : (
                            <CheckCircle2 className="size-3" />
                          )}
                          <span>Mark Resolved</span>
                        </Button>
                        <Button
                          size="xs"
                          variant="outline"
                          onClick={() => handleResolve(item.id, 'SKIPPED')}
                          disabled={isResolving}
                        >
                          <Archive className="size-3" />
                          <span>Skip & Archive</span>
                        </Button>
                      </div>
                    ) : (
                      <div className="text-[11px] font-mono text-muted-foreground flex items-center gap-1">
                        {item.status === 'RESOLVED' ? (
                          <span className="flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
                            <CheckCircle2 className="size-3" /> Resolved by Operator
                          </span>
                        ) : (
                          <span className="flex items-center gap-1 text-muted-foreground">
                            <Archive className="size-3" /> Skipped & Archived
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                </Card>
              );
            })
          )}
        </div>

        {/* Footer with Reload Button */}
        <DialogFooter className="pt-3 border-t border-border/60 flex items-center justify-between gap-3 sm:justify-between shrink-0">
          <div className="text-xs text-muted-foreground font-mono">
            {pendingCount > 0 ? (
              <span className="text-rose-500 font-medium">
                {pendingCount} quarantined workflow{pendingCount > 1 ? 's' : ''}
              </span>
            ) : (
              <span className="text-emerald-500 font-medium">All workflows healthy</span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={fetchItems}
              disabled={isLoading}
              title="Reload recovery queue"
            >
              <RefreshCw className={cn('size-3.5', isLoading && 'animate-spin text-primary')} />
              <span>Reload</span>
            </Button>
            <Button size="sm" variant="secondary" onClick={() => onOpenChange(false)}>
              Close
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
