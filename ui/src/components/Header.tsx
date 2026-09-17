import type { WorkflowDefinition, WorkflowStatus } from '@core/types';
import { AlertCircle, History, Loader2, Moon, Play, Sliders, Sun } from 'lucide-react';
import { Badge } from './ui/badge';
import { Button } from './ui/button';

interface HeaderProps {
  workflows: WorkflowDefinition[];
  selectedWorkflow: WorkflowDefinition | null;
  onSelectWorkflow: (def: WorkflowDefinition) => void;
  workflowStatus: WorkflowStatus;
  activeExecutionId: string | null;
  isDark: boolean;
  onToggleTheme: () => void;
  onTriggerExecution: () => void;
  onOpenPoisonPillModal: () => void;
  onOpenTestConfigModal?: () => void;
  onOpenHistoryModal: () => void;
  isHistoricalView?: boolean;
}

export function Header({
  onSelectWorkflow: _onSelectWorkflow,
  workflowStatus,
  activeExecutionId,
  isDark,
  onToggleTheme,
  onTriggerExecution,
  onOpenPoisonPillModal,
  onOpenTestConfigModal,
  onOpenHistoryModal,
  isHistoricalView = false,
}: HeaderProps) {
  const getStatusBadge = () => {
    switch (workflowStatus) {
      case 'RUNNING':
        return (
          <Badge variant="cyan" className="font-sans font-medium">
            <Loader2 className="size-3 animate-spin text-sky-500" />
            Running
          </Badge>
        );
      case 'COMPLETED':
        return <Badge variant="emerald">Completed</Badge>;
      case 'FAILING':
        return <Badge variant="rose">Failing</Badge>;
      case 'COMPENSATING':
        return <Badge variant="purple">Compensating (Saga)</Badge>;
      case 'POISON_PILL_BLOCKED':
        return (
          <Badge variant="destructive" className="font-medium">
            <AlertCircle className="size-3 text-rose-500" />
            Poison Pill Blocked
          </Badge>
        );
      case 'FAILED':
        return <Badge variant="rose">Failed</Badge>;
      default:
        return <Badge variant="glass">Idle</Badge>;
    }
  };

  return (
    <header className="w-full border-b border-border bg-card/80 backdrop-blur-md px-4 sm:px-6 py-2.5 flex items-center justify-between gap-3 sticky top-0 z-40">
      {/* Brand & Status */}
      <div className="flex items-center gap-3 shrink-0">
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-base tracking-tight text-foreground">Sequent</span>
          </div>
        </div>

        {/* Workflow Status Pill */}
        <div className="hidden sm:flex items-center gap-2 pl-3 border-l border-border">
          {getStatusBadge()}
          {isHistoricalView && (
            <Badge variant="purple" className="text-[11px] font-mono">
              Historical Run
            </Badge>
          )}
          {activeExecutionId && (
            <span className="text-xs font-mono text-muted-foreground hidden md:inline">
              {activeExecutionId.slice(0, 14)}
            </span>
          )}
        </div>
      </div>

      {/* Right Controls */}
      <div className="flex items-center gap-2 shrink-0">
        {/* Past Executions & Test Runs History Button */}
        <Button
          size="sm"
          variant={isHistoricalView ? 'secondary' : 'outline'}
          onClick={onOpenHistoryModal}
          className="text-xs h-8 gap-1.5"
          title="Past Executions & Test History"
        >
          <History className="size-3.5 text-primary" data-icon="inline-start" />
          <span>History</span>
        </Button>

        {/* Quarantine Queue Button */}
        <Button
          size="sm"
          variant="outline"
          onClick={onOpenPoisonPillModal}
          className="text-xs h-8 gap-1.5"
        >
          <AlertCircle className="size-3.5 text-rose-500" />
          <span>Recovery Queue</span>
        </Button>

        {/* Configure Test Button */}
        <Button
          size="sm"
          variant="outline"
          onClick={onOpenTestConfigModal}
          className="text-xs h-8 gap-1.5 border-primary/40 text-foreground hover:border-primary bg-primary/5 hover:bg-primary/10 transition-colors"
          title="Configure Test & Chaos Fault Injections"
        >
          <Sliders className="size-3.5 text-primary" />
          <span>Configure Test</span>
        </Button>

        {/* Trigger Execution Button */}
        <Button
          size="sm"
          variant="default"
          onClick={onTriggerExecution}
          disabled={workflowStatus === 'RUNNING'}
          className="text-xs h-8 font-medium"
        >
          {workflowStatus === 'RUNNING' ? (
            <>
              <Loader2 className="size-3.5 animate-spin mr-1.5" />
              Running...
            </>
          ) : (
            <>
              <Play className="size-3.5 fill-current mr-1.5" />
              Run DAG
            </>
          )}
        </Button>

        {/* Theme Toggle */}
        <Button
          size="icon"
          variant="ghost"
          onClick={onToggleTheme}
          title={isDark ? 'Switch to Light Mode' : 'Switch to Dark Mode'}
          className="size-8 rounded-lg text-muted-foreground hover:text-foreground shrink-0"
        >
          {isDark ? (
            <Sun className="size-4 text-amber-400" />
          ) : (
            <Moon className="size-4 text-slate-600" />
          )}
        </Button>
      </div>
    </header>
  );
}
