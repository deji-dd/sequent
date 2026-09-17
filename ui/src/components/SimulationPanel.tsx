import type { ChaosConfig, WorkflowStatus } from '@core/types';
import { Clock, Sparkles } from 'lucide-react';
import { useState } from 'react';
import { Badge } from './ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card';

interface SimulationPanelProps {
  workflowStatus: WorkflowStatus;
  activeChaosConfig?: ChaosConfig | null;
  onLaunchConfiguredTest: (presetId?: string, chaosConfig?: ChaosConfig) => void;
}

export function SimulationPanel({
  workflowStatus,
  activeChaosConfig,
  onLaunchConfiguredTest,
}: SimulationPanelProps) {
  const [simulationLog, setSimulationLog] = useState<string | null>(null);

  const isRunning = workflowStatus === 'RUNNING';

  const runQuickScenario = (presetId: string, chaosConfig: ChaosConfig, description: string) => {
    setSimulationLog(`Launching scenario: ${description}`);
    onLaunchConfiguredTest(presetId, chaosConfig);
  };

  return (
    <Card className="border-border shadow-xs">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-semibold text-foreground flex items-center gap-2">
          Test Lab & Fault Injection
        </CardTitle>
        <CardDescription className="text-xs text-muted-foreground mt-0.5">
          Pre-schedule chaos events and observable pacing to comfortably inspect resilient behavior.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-3.5">
        {/* Active Configuration Status Pill */}
        <div className="p-2.5 rounded-lg bg-muted/40 border border-border flex flex-wrap items-center justify-between gap-2 text-xs">
          <div className="flex items-center gap-2">
            <span className="font-medium text-foreground">Current Test Profile:</span>
            {activeChaosConfig ? (
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge variant="outline" className="text-[11px] font-mono gap-1">
                  <Clock className="size-3 text-primary" />
                  {activeChaosConfig.stepDelayMs || 400}ms pacing
                </Badge>
                {activeChaosConfig.zombieNodeId && (
                  <Badge variant="amber" className="text-[11px]">
                    Zombie: {activeChaosConfig.zombieNodeId}
                  </Badge>
                )}
                {activeChaosConfig.crashNodeId && (
                  <Badge variant="cyan" className="text-[11px]">
                    Crash: {activeChaosConfig.crashNodeId}
                  </Badge>
                )}
                {activeChaosConfig.failNodeId && (
                  <Badge variant="purple" className="text-[11px]">
                    Rollback: {activeChaosConfig.failNodeId}
                  </Badge>
                )}
                {activeChaosConfig.poisonPillNodeId && (
                  <Badge variant="rose" className="text-[11px]">
                    Poison Pill: {activeChaosConfig.poisonPillNodeId}
                  </Badge>
                )}
              </div>
            ) : (
              <Badge variant="glass" className="text-[11px]">
                Standard Execution (400ms) &bull; Clean Run
              </Badge>
            )}
          </div>

          <div className="text-[11px] text-muted-foreground font-mono">
            {isRunning ? 'Execution in progress...' : 'Ready for test run'}
          </div>
        </div>

        {/* Quick Launch Presets Toolbar */}
        <div className="space-y-1.5">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1">
            <Sparkles className="size-3 text-primary" />
            Quick-Run Scenarios (Pre-Configured with 1.2s Observable Pacing)
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            {/* 1. Split Brain Zombie */}
            <button
              type="button"
              disabled={isRunning}
              onClick={() =>
                runQuickScenario(
                  'fencing_zombie_demo',
                  {
                    stepDelayMs: 1200,
                    zombieNodeId: 'step_2_zombie_target',
                  },
                  'Worker Fencing & Zombie Write Rejection'
                )
              }
              className="p-2.5 rounded-lg border border-border bg-background hover:bg-muted/60 transition-colors text-left disabled:opacity-50 disabled:cursor-not-allowed group"
            >
              <div className="flex items-center gap-1.5 text-xs font-semibold text-foreground group-hover:text-amber-500 transition-colors">
                <span className="size-2 rounded-full bg-amber-500" />
                Zombie Defense
              </div>
              <div className="text-[11px] text-muted-foreground mt-0.5 line-clamp-1">
                Fencing token rejection
              </div>
            </button>

            {/* 2. Crash & Replay */}
            <button
              type="button"
              disabled={isRunning}
              onClick={() =>
                runQuickScenario(
                  'ecommerce_order_saga',
                  {
                    stepDelayMs: 1200,
                    crashNodeId: 'charge_payment',
                  },
                  'Coordinator SIGKILL & Zero-Loss Replay Recovery'
                )
              }
              className="p-2.5 rounded-lg border border-border bg-background hover:bg-muted/60 transition-colors text-left disabled:opacity-50 disabled:cursor-not-allowed group"
            >
              <div className="flex items-center gap-1.5 text-xs font-semibold text-foreground group-hover:text-sky-500 transition-colors">
                <span className="size-2 rounded-full bg-sky-500" />
                Crash & Replay
              </div>
              <div className="text-[11px] text-muted-foreground mt-0.5 line-clamp-1">
                Zero-loss event recovery
              </div>
            </button>

            {/* 3. Saga Rollback */}
            <button
              type="button"
              disabled={isRunning}
              onClick={() =>
                runQuickScenario(
                  'ecommerce_order_saga',
                  {
                    stepDelayMs: 1200,
                    failNodeId: 'charge_payment',
                  },
                  'Sibling Cancellation & Reverse Saga Compensation'
                )
              }
              className="p-2.5 rounded-lg border border-border bg-background hover:bg-muted/60 transition-colors text-left disabled:opacity-50 disabled:cursor-not-allowed group"
            >
              <div className="flex items-center gap-1.5 text-xs font-semibold text-foreground group-hover:text-purple-500 transition-colors">
                <span className="size-2 rounded-full bg-purple-500" />
                Saga Rollback
              </div>
              <div className="text-[11px] text-muted-foreground mt-0.5 line-clamp-1">
                Parallel branch abort
              </div>
            </button>

            {/* 4. Poison Pill */}
            <button
              type="button"
              disabled={isRunning}
              onClick={() =>
                runQuickScenario(
                  'poison_pill_quarantine_demo',
                  {
                    stepDelayMs: 1200,
                    failNodeId: 'reserve_inventory',
                    poisonPillNodeId: 'reserve_inventory',
                  },
                  'Poison Pill Quarantine & Retry Exhaustion'
                )
              }
              className="p-2.5 rounded-lg border border-border bg-background hover:bg-muted/60 transition-colors text-left disabled:opacity-50 disabled:cursor-not-allowed group"
            >
              <div className="flex items-center gap-1.5 text-xs font-semibold text-foreground group-hover:text-rose-500 transition-colors">
                <span className="size-2 rounded-full bg-rose-500" />
                Poison Pill
              </div>
              <div className="text-[11px] text-muted-foreground mt-0.5 line-clamp-1">
                Manual recovery queue
              </div>
            </button>
          </div>
        </div>

        {/* Live Simulation Notice */}
        {simulationLog && (
          <div className="p-2.5 rounded-lg bg-muted border border-border text-xs font-mono text-foreground flex items-start gap-2 leading-relaxed">
            <span className="text-primary font-bold shrink-0">&gt;</span>
            <span className="flex-1">{simulationLog}</span>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
