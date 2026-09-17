import type { NodeRuntimeState, WorkflowNode } from '@core/types';
import { Handle, Position } from '@xyflow/react';
import { AlertCircle, AlertTriangle, CheckCircle2, Loader2, RotateCcw } from 'lucide-react';
import { Badge } from './ui/badge';
import { Button } from './ui/button';

export function CustomDagNode({ data }: { data: any }) {
  const node: WorkflowNode = data.node;
  const state: NodeRuntimeState = data.state || { status: 'IDLE', attempts: 0 };
  const onZombieClick = data.onZombieClick;

  // Status-dependent styles
  const getStatusStyle = () => {
    switch (state.status) {
      case 'RUNNING':
        return 'border-sky-500 bg-sky-500/[0.04] ring-1 ring-sky-500/30';
      case 'SCHEDULED':
        return 'border-sky-500/40 bg-sky-500/[0.02]';
      case 'COMPLETED':
        return 'border-emerald-500/40 bg-emerald-500/[0.02]';
      case 'FAILED':
        return 'border-rose-500/60 bg-rose-500/[0.04]';
      case 'CANCELLED':
        return 'border-border bg-muted/30 opacity-75';
      case 'COMPENSATING':
        return 'border-purple-500/60 bg-purple-500/[0.04]';
      case 'COMPENSATED':
        return 'border-purple-500/30 bg-muted/30';
      case 'POISON_PILL_BLOCKED':
        return 'border-rose-600 bg-rose-500/10 ring-1 ring-rose-500/30';
      default:
        return 'border-border bg-card hover:border-border/80';
    }
  };

  const getStatusBadge = () => {
    switch (state.status) {
      case 'RUNNING':
        return (
          <Badge variant="cyan" className="text-[11px] font-sans font-medium">
            <Loader2 className="size-3 animate-spin text-sky-500" />
            Running
          </Badge>
        );
      case 'COMPLETED':
        return (
          <Badge variant="emerald" className="text-[11px] font-sans font-medium">
            <CheckCircle2 className="size-3 text-emerald-500" />
            Done
          </Badge>
        );
      case 'FAILED':
        return (
          <Badge variant="rose" className="text-[11px] font-sans font-medium">
            <AlertCircle className="size-3 text-rose-500" />
            Failed
          </Badge>
        );
      case 'CANCELLED':
        return (
          <Badge variant="glass" className="text-[11px] font-sans">
            Cancelled
          </Badge>
        );
      case 'COMPENSATING':
        return (
          <Badge variant="purple" className="text-[11px] font-sans font-medium">
            <RotateCcw className="size-3 text-purple-500 animate-spin" />
            Rollback
          </Badge>
        );
      case 'COMPENSATED':
        return (
          <Badge variant="purple" className="text-[11px] font-sans">
            Compensated
          </Badge>
        );
      case 'POISON_PILL_BLOCKED':
        return (
          <Badge variant="destructive" className="text-[11px] font-sans font-medium">
            Poison Pill
          </Badge>
        );
      default:
        return (
          <Badge variant="glass" className="text-[11px] font-sans text-muted-foreground">
            Idle
          </Badge>
        );
    }
  };

  return (
    <div
      className={`relative min-w-[260px] max-w-[290px] rounded-xl border p-4 transition-all duration-200 shadow-xs ${getStatusStyle()}`}
    >
      <Handle
        type="target"
        position={Position.Left}
        className="!size-2.5 !border-2 !border-background !bg-muted-foreground hover:!bg-primary transition-colors"
      />

      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-foreground tracking-tight truncate">
            {node.name}
          </div>
          <div className="text-xs text-muted-foreground font-mono mt-0.5">{node.activityType}</div>
        </div>
        {getStatusBadge()}
      </div>

      {node.metadata?.description && (
        <p className="text-xs text-muted-foreground/90 leading-relaxed line-clamp-2 mt-2">
          {node.metadata.description}
        </p>
      )}

      {/* Fencing Token & Worker Lease Info */}
      <div className="mt-3 pt-2.5 border-t border-border flex items-center justify-between text-xs font-mono">
        <div className="text-muted-foreground">
          {state.workerId ? (
            <span className="text-foreground font-medium">Worker: {state.workerId}</span>
          ) : (
            <span className="text-muted-foreground/70">Unassigned</span>
          )}
        </div>
        {state.fencingToken ? (
          <span className="px-1.5 py-0.5 rounded bg-muted border border-border text-foreground font-medium text-[11px]">
            Fence #{state.fencingToken}
          </span>
        ) : null}
      </div>

      {/* Compensation Action Tag */}
      {node.compensationType && (
        <div className="mt-2 flex items-center gap-1.5 text-xs text-purple-600 dark:text-purple-400 font-mono">
          <RotateCcw className="size-3 shrink-0" />
          <span className="truncate">Rollback: {node.compensationType}</span>
        </div>
      )}

      {/* Error display */}
      {state.error && (
        <div className="mt-2.5 p-2 rounded-md bg-rose-500/10 border border-rose-500/20 text-xs text-rose-700 dark:text-rose-400 font-mono leading-tight">
          {state.error}
        </div>
      )}

      {/* Interactive Trigger Button for Worker Delay */}
      {state.status === 'RUNNING' && onZombieClick && (
        <div className="mt-3">
          <Button
            size="xs"
            variant="destructive-subtle"
            className="w-full text-xs py-1"
            onClick={(e) => {
              e.stopPropagation();
              onZombieClick(node.id);
            }}
          >
            <AlertTriangle className="size-3 mr-1" />
            Inject Worker GC Pause
          </Button>
        </div>
      )}

      <Handle
        type="source"
        position={Position.Right}
        className="!size-2.5 !border-2 !border-background !bg-muted-foreground hover:!bg-primary transition-colors"
      />
    </div>
  );
}
