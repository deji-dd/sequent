import {
  Activity,
  AlertCircle,
  ArrowRight,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock,
  Filter,
  History,
  Loader2,
  RefreshCw,
  Skull,
  Zap,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Card, CardContent } from './ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog';
import { ScrollArea } from './ui/scroll-area';
import { Separator } from './ui/separator';
import { ToggleGroup, ToggleGroupItem } from './ui/toggle-group';

export interface PastExecutionRecord {
  id: string;
  workflowDefinitionId: string;
  status: 'RUNNING' | 'COMPLETED' | 'FAILING' | 'COMPENSATING' | 'POISON_PILL_BLOCKED' | 'FAILED';
  currentSequenceId: number;
  activeFencingToken: number;
  inputPayload: any;
  outputPayload?: any;
  contextState?: any;
  nodeStates?: Record<string, any>;
  chaosConfig?: any;
  error?: string | null;
  startedAt: string | Date;
  completedAt?: string | Date | null;
}

interface PastTestsModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelectExecution: (executionId: string) => void;
  currentExecutionId: string | null;
  isHistoricalView: boolean;
}

type FilterType = 'all' | 'completed' | 'failed' | 'chaos';

const PAGE_SIZE = 10;

export function PastTestsModal({
  open,
  onOpenChange,
  onSelectExecution,
  currentExecutionId,
  isHistoricalView,
}: PastTestsModalProps) {
  const [executions, setExecutions] = useState<PastExecutionRecord[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [filter, setFilter] = useState<FilterType>('all');
  const [currentPage, setCurrentPage] = useState<number>(1);

  const fetchExecutions = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/executions?limit=100');
      if (res.ok) {
        const data = await res.json();
        setExecutions(data);
      }
    } catch (err) {
      console.error('Failed to load past executions:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) {
      fetchExecutions();
    }
  }, [open, fetchExecutions]);

  const handleFilterChange = (val: FilterType) => {
    setFilter(val);
    setCurrentPage(1);
  };

  const getChaosBadge = (chaosConfig?: any) => {
    if (!chaosConfig) return null;

    if (chaosConfig.enableZombieWorker || chaosConfig.zombieNodeId) {
      return (
        <Badge variant="purple" className="text-[11px] gap-1">
          <Skull className="size-3" />
          Zombie Worker Chaos
        </Badge>
      );
    }
    if (chaosConfig.enableProcessCrash || chaosConfig.crashNodeId) {
      return (
        <Badge variant="amber" className="text-[11px] gap-1">
          <Zap className="size-3" />
          Crash & Replay
        </Badge>
      );
    }
    if (chaosConfig.enableSimulatedFailure || chaosConfig.failNodeId) {
      return (
        <Badge variant="rose" className="text-[11px] gap-1">
          <Activity className="size-3" />
          Saga Compensation
        </Badge>
      );
    }
    if (chaosConfig.enablePoisonPill || chaosConfig.poisonPillNodeId) {
      return (
        <Badge variant="destructive" className="text-[11px] gap-1">
          <AlertCircle className="size-3" />
          Poison Pill Block
        </Badge>
      );
    }
    return null;
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'COMPLETED':
        return (
          <Badge variant="emerald" className="text-[11px] gap-1">
            <CheckCircle2 className="size-3" />
            Completed
          </Badge>
        );
      case 'FAILING':
      case 'FAILED':
        return (
          <Badge variant="rose" className="text-[11px] gap-1">
            <AlertCircle className="size-3" />
            Failed
          </Badge>
        );
      case 'COMPENSATING':
        return (
          <Badge variant="purple" className="text-[11px] gap-1">
            <Activity className="size-3" />
            Compensating
          </Badge>
        );
      case 'POISON_PILL_BLOCKED':
        return (
          <Badge variant="destructive" className="text-[11px] gap-1">
            <AlertCircle className="size-3" />
            Poison Pill
          </Badge>
        );
      case 'RUNNING':
        return (
          <Badge variant="cyan" className="text-[11px] gap-1">
            <Activity className="size-3 animate-pulse" />
            Running
          </Badge>
        );
      default:
        return (
          <Badge variant="outline" className="text-[11px]">
            {status}
          </Badge>
        );
    }
  };

  const formatDuration = (start: string | Date, end?: string | Date | null) => {
    if (!end) return 'In progress';
    const startTime = new Date(start).getTime();
    const endTime = new Date(end).getTime();
    const diff = Math.max(0, endTime - startTime);
    if (diff < 1000) return `${diff}ms`;
    return `${(diff / 1000).toFixed(2)}s`;
  };

  const formatTimestamp = (dateVal: string | Date) => {
    const d = new Date(dateVal);
    const now = Date.now();
    const diffSec = Math.floor((now - d.getTime()) / 1000);

    if (diffSec < 60) return 'Just now';
    if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
    if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
    return d.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const filteredExecutions = executions.filter((ex) => {
    if (filter === 'completed') return ex.status === 'COMPLETED';
    if (filter === 'failed')
      return (
        ex.status === 'FAILED' ||
        ex.status === 'COMPENSATING' ||
        ex.status === 'POISON_PILL_BLOCKED'
      );
    if (filter === 'chaos') {
      return (
        ex.chaosConfig &&
        (ex.chaosConfig.enableZombieWorker ||
          ex.chaosConfig.enableProcessCrash ||
          ex.chaosConfig.enableSimulatedFailure ||
          ex.chaosConfig.enablePoisonPill)
      );
    }
    return true;
  });

  const totalPages = Math.max(1, Math.ceil(filteredExecutions.length / PAGE_SIZE));
  const safeCurrentPage = Math.min(currentPage, totalPages);
  const startIndex = (safeCurrentPage - 1) * PAGE_SIZE;
  const endIndex = startIndex + PAGE_SIZE;
  const paginatedExecutions = filteredExecutions.slice(startIndex, endIndex);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl sm:max-w-4xl h-[85vh] max-h-[85vh] flex flex-col min-h-0 p-6 gap-3 overflow-hidden">
        <DialogHeader className="space-y-1 pb-1 text-left shrink-0">
          <DialogTitle className="text-xl font-semibold">Past Executions & Test Runs</DialogTitle>
          <DialogDescription className="text-xs text-muted-foreground">
            Browse persistent database records of previous workflow tests, audit chaos fault
            injections, and replay full event states.
          </DialogDescription>
        </DialogHeader>

        {/* Filter Toggle Group */}
        <div className="flex flex-wrap items-center justify-between gap-2 shrink-0">
          <div className="flex items-center gap-2">
            <Filter className="size-3.5 text-muted-foreground mr-0.5" />
            <ToggleGroup
              type="single"
              value={filter}
              onValueChange={(val) => {
                if (val) handleFilterChange(val as FilterType);
              }}
              variant="default"
              size="xs"
              className="bg-muted/40 p-0.5 rounded-lg border border-border"
            >
              <ToggleGroupItem value="all" className="text-xs px-2.5 h-7">
                All ({executions.length})
              </ToggleGroupItem>
              <ToggleGroupItem value="completed" className="text-xs px-2.5 h-7">
                Completed ({executions.filter((e) => e.status === 'COMPLETED').length})
              </ToggleGroupItem>
              <ToggleGroupItem value="failed" className="text-xs px-2.5 h-7">
                Failed / Sagas (
                {
                  executions.filter((e) =>
                    ['FAILED', 'COMPENSATING', 'POISON_PILL_BLOCKED'].includes(e.status)
                  ).length
                }
                )
              </ToggleGroupItem>
              <ToggleGroupItem value="chaos" className="text-xs px-2.5 h-7">
                Chaos Injected (
                {
                  executions.filter(
                    (e) =>
                      e.chaosConfig &&
                      (e.chaosConfig.enableZombieWorker ||
                        e.chaosConfig.enableProcessCrash ||
                        e.chaosConfig.enableSimulatedFailure ||
                        e.chaosConfig.enablePoisonPill)
                  ).length
                }
                )
              </ToggleGroupItem>
            </ToggleGroup>
          </div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground font-mono">
            {loading && (
              <span className="flex items-center gap-1 text-primary animate-pulse">
                <Loader2 className="size-3 animate-spin" />
                Updating...
              </span>
            )}
            <span>
              {filteredExecutions.length} {filteredExecutions.length === 1 ? 'record' : 'records'}
            </span>
          </div>
        </div>

        <Separator className="shrink-0" />

        {/* Executions Scroll List */}
        <div className="relative flex-1 min-h-0 flex flex-col overflow-hidden">
          {loading && executions.length === 0 ? (
            <div className="flex flex-col items-center justify-center flex-1 py-16 text-center text-muted-foreground gap-3">
              <Loader2 className="size-8 text-primary animate-spin" />
              <p className="text-sm font-medium">Fetching past test executions...</p>
              <p className="text-xs text-muted-foreground/70">
                Retrieving state logs and chaos configurations from the repository.
              </p>
            </div>
          ) : (
            <ScrollArea className="h-full w-full pr-3">
              {filteredExecutions.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-16 text-center text-muted-foreground">
                  <History className="size-10 stroke-[1.25] text-muted-foreground/40 mb-3" />
                  <p className="text-sm font-medium">No test executions found</p>
                  <p className="text-xs mt-1 text-muted-foreground/70">
                    {filter !== 'all'
                      ? 'Try switching the filter to "All" to view previous runs.'
                      : 'Trigger a test or DAG run to record the first execution in the database.'}
                  </p>
                </div>
              ) : (
                <div className="flex flex-col gap-2.5 py-1">
                  {paginatedExecutions.map((exec) => {
                    const isSelected = currentExecutionId === exec.id;
                    const chaosBadge = getChaosBadge(exec.chaosConfig);

                    return (
                      <Card
                        key={exec.id}
                        className={`transition-all duration-150 hover:border-primary/50 ${
                          isSelected
                            ? 'border-primary/60 bg-primary/[0.03] ring-1 ring-primary/30'
                            : 'bg-card/60'
                        }`}
                      >
                        <CardContent className="p-3.5 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
                          {/* Left: Execution Info */}
                          <div className="flex flex-col gap-1.5 min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="font-mono text-xs font-semibold text-foreground tracking-tight">
                                {exec.id}
                              </span>
                              {getStatusBadge(exec.status)}
                              {chaosBadge}
                              {isSelected && (
                                <Badge
                                  variant="outline"
                                  className="text-[10px] text-primary border-primary/40 bg-primary/5"
                                >
                                  {isHistoricalView ? 'Loaded in Canvas' : 'Current Active'}
                                </Badge>
                              )}
                            </div>

                            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                              <span className="font-medium text-foreground/80">
                                DAG: <span className="font-mono">{exec.workflowDefinitionId}</span>
                              </span>
                              <span className="flex items-center gap-1">
                                <Clock className="size-3" />
                                {formatTimestamp(exec.startedAt)}
                              </span>
                              <span>
                                Duration:{' '}
                                <span className="font-mono text-foreground/80">
                                  {formatDuration(exec.startedAt, exec.completedAt)}
                                </span>
                              </span>
                              <span>
                                Events:{' '}
                                <span className="font-mono text-foreground/80">
                                  {exec.currentSequenceId}
                                </span>
                              </span>
                              {exec.activeFencingToken > 0 && (
                                <span>
                                  Token:{' '}
                                  <span className="font-mono text-purple-600 dark:text-purple-400 font-semibold">
                                    T#{exec.activeFencingToken}
                                  </span>
                                </span>
                              )}
                            </div>

                            {exec.error && (
                              <div className="text-xs text-rose-600 dark:text-rose-400 font-mono line-clamp-1 mt-0.5">
                                Error: {exec.error}
                              </div>
                            )}
                          </div>

                          {/* Right: Actions */}
                          <div className="flex items-center gap-2 shrink-0 self-end sm:self-center">
                            <Button
                              size="sm"
                              variant={isSelected ? 'secondary' : 'default'}
                              onClick={() => {
                                onSelectExecution(exec.id);
                                onOpenChange(false);
                              }}
                              className="text-xs h-8 gap-1 font-medium"
                            >
                              {isSelected ? (
                                <>
                                  <span>Viewing</span>
                                  <CheckCircle2 className="size-3.5" data-icon="inline-end" />
                                </>
                              ) : (
                                <>
                                  <span>Load & Replay</span>
                                  <ArrowRight className="size-3.5" data-icon="inline-end" />
                                </>
                              )}
                            </Button>
                          </div>
                        </CardContent>
                      </Card>
                    );
                  })}
                </div>
              )}
            </ScrollArea>
          )}

          {/* Async loading overlay for background refreshes */}
          {loading && executions.length > 0 && (
            <div className="absolute inset-0 bg-background/30 backdrop-blur-[1px] flex items-center justify-center pointer-events-none rounded-lg z-10 transition-opacity">
              <div className="flex items-center gap-2 bg-card/90 border border-border px-3.5 py-1.5 rounded-full shadow-md text-xs font-medium text-foreground">
                <Loader2 className="size-3.5 text-primary animate-spin" />
                Refreshing executions...
              </div>
            </div>
          )}
        </div>

        <Separator className="shrink-0" />

        {/* Dialog Footer with Pagination & Controls */}
        <DialogFooter className="flex flex-col sm:flex-row items-center justify-between sm:justify-between w-full gap-2 pt-1 shrink-0">
          <div className="flex items-center gap-2 text-xs text-muted-foreground font-mono">
            <span>
              Total: {executions.length} {executions.length === 1 ? 'run' : 'runs'}
            </span>
            {filteredExecutions.length > 0 && (
              <>
                <span>•</span>
                <span>
                  Showing {startIndex + 1}–{Math.min(endIndex, filteredExecutions.length)} of{' '}
                  {filteredExecutions.length}
                </span>
              </>
            )}
          </div>

          <div className="flex items-center gap-2">
            {/* Pagination Controls */}
            {totalPages > 1 && (
              <div className="flex items-center gap-1.5 mr-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                  disabled={safeCurrentPage <= 1 || loading}
                  className="h-8 w-8 p-0"
                  aria-label="Previous page"
                >
                  <ChevronLeft className="size-4" />
                </Button>
                <span className="text-xs font-mono text-muted-foreground px-1.5">
                  Page {safeCurrentPage} / {totalPages}
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                  disabled={safeCurrentPage >= totalPages || loading}
                  className="h-8 w-8 p-0"
                  aria-label="Next page"
                >
                  <ChevronRight className="size-4" />
                </Button>
              </div>
            )}

            <Button
              size="sm"
              variant="outline"
              onClick={fetchExecutions}
              disabled={loading}
              className="text-xs h-8 gap-1.5"
            >
              <RefreshCw
                className={`size-3.5 ${loading ? 'animate-spin' : ''}`}
                data-icon="inline-start"
              />
              Refresh
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
