import type { ChaosConfig, WorkflowDefinition } from '@core/types';
import { Play } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';

interface TestConfigurationModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workflows: WorkflowDefinition[];
  selectedWorkflow: WorkflowDefinition | null;
  onSelectWorkflow: (def: WorkflowDefinition) => void;
  onLaunchTest: (defId: string, chaosConfig: ChaosConfig) => void;
  isRunning?: boolean;
}

export function TestConfigurationModal({
  open,
  onOpenChange,
  workflows,
  selectedWorkflow,
  onSelectWorkflow,
  onLaunchTest,
  isRunning = false,
}: TestConfigurationModalProps) {
  // Pacing
  const [stepDelayMs, setStepDelayMs] = useState<number>(1200);

  // Injections
  const [enableZombie, setEnableZombie] = useState<boolean>(false);
  const [zombieNodeId, setZombieNodeId] = useState<string>('');

  const [enableCrash, setEnableCrash] = useState<boolean>(false);
  const [crashNodeId, setCrashNodeId] = useState<string>('');

  const [enableFailure, setEnableFailure] = useState<boolean>(false);
  const [failNodeId, setFailNodeId] = useState<string>('');

  const [enablePoisonPill, setEnablePoisonPill] = useState<boolean>(false);
  const [poisonPillNodeId, setPoisonPillNodeId] = useState<string>('');

  // Selected workflow
  const activeWorkflow = selectedWorkflow || workflows[0];
  const taskNodes = activeWorkflow?.nodes || [];

  // Update default node targets when workflow changes
  useEffect(() => {
    if (!taskNodes.length) return;
    const firstTask = taskNodes.find((n) => n.type === 'task') || taskNodes[0];
    const secondTask =
      taskNodes.find((n) => n.type === 'task' && n.id !== firstTask?.id) || firstTask;
    const compensatingTask = taskNodes.find((n) => n.compensationType) || secondTask;

    if (!zombieNodeId || !taskNodes.some((n) => n.id === zombieNodeId)) {
      setZombieNodeId(secondTask?.id || '');
    }
    if (!crashNodeId || !taskNodes.some((n) => n.id === crashNodeId)) {
      setCrashNodeId(secondTask?.id || '');
    }
    if (!failNodeId || !taskNodes.some((n) => n.id === failNodeId)) {
      setFailNodeId(secondTask?.id || '');
    }
    if (!poisonPillNodeId || !taskNodes.some((n) => n.id === poisonPillNodeId)) {
      setPoisonPillNodeId(compensatingTask?.id || '');
    }
  }, [activeWorkflow?.id, taskNodes]);

  // Preset recipe applicator
  const applyRecipe = (type: 'happy' | 'zombie' | 'crash' | 'saga' | 'poison') => {
    // Default to observable speed
    setStepDelayMs(1200);

    const firstTask = taskNodes.find((n) => n.type === 'task') || taskNodes[0];
    const secondTask =
      taskNodes.find((n) => n.type === 'task' && n.id !== firstTask?.id) || firstTask;
    const compensatingTask = taskNodes.find((n) => n.compensationType) || secondTask;

    if (type === 'happy') {
      setEnableZombie(false);
      setEnableCrash(false);
      setEnableFailure(false);
      setEnablePoisonPill(false);
    } else if (type === 'zombie') {
      setEnableZombie(true);
      setZombieNodeId(secondTask?.id || '');
      setEnableCrash(false);
      setEnableFailure(false);
      setEnablePoisonPill(false);
    } else if (type === 'crash') {
      setEnableZombie(false);
      setEnableCrash(true);
      setCrashNodeId(secondTask?.id || '');
      setEnableFailure(false);
      setEnablePoisonPill(false);
    } else if (type === 'saga') {
      setEnableZombie(false);
      setEnableCrash(false);
      setEnableFailure(true);
      setFailNodeId(secondTask?.id || '');
      setEnablePoisonPill(false);
    } else if (type === 'poison') {
      setEnableZombie(false);
      setEnableCrash(false);
      setEnableFailure(true);
      setFailNodeId(secondTask?.id || '');
      setEnablePoisonPill(true);
      setPoisonPillNodeId(compensatingTask?.id || '');
    }
  };

  const handleLaunch = () => {
    if (!activeWorkflow) return;

    const chaosConfig: ChaosConfig = {
      stepDelayMs,
      zombieNodeId: enableZombie ? zombieNodeId : undefined,
      crashNodeId: enableCrash ? crashNodeId : undefined,
      failNodeId: enableFailure ? failNodeId : undefined,
      poisonPillNodeId: enablePoisonPill ? poisonPillNodeId : undefined,
    };

    onLaunchTest(activeWorkflow.id, chaosConfig);
    onOpenChange(false);
  };

  const activeInjectionsCount = [enableZombie, enableCrash, enableFailure, enablePoisonPill].filter(
    Boolean
  ).length;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto p-6 bg-card border-border shadow-xl">
        <DialogHeader className="space-y-1.5 pb-2 border-b border-border">
          <div className="flex items-center gap-2">
            <div>
              <DialogTitle className="text-base font-semibold text-foreground">
                Configure Test
              </DialogTitle>
              <DialogDescription className="text-xs text-muted-foreground">
                Pre-schedule faults and observable pacing so you can comfortably watch recovery in
                real time.
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="space-y-5 py-2">
          {/* Quick Recipe Presets */}
          <div className="space-y-2">
            <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
              Quick Recipe Presets
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="text-xs h-7 gap-1.5 hover:border-emerald-500/50"
                onClick={() => applyRecipe('happy')}
              >
                <span className="size-2 rounded-full bg-emerald-500" />
                Happy Path
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="text-xs h-7 gap-1.5 hover:border-amber-500/50"
                onClick={() => applyRecipe('zombie')}
              >
                <span className="size-2 rounded-full bg-amber-500" />
                Zombie Split-Brain
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="text-xs h-7 gap-1.5 hover:border-sky-500/50"
                onClick={() => applyRecipe('crash')}
              >
                <span className="size-2 rounded-full bg-sky-500" />
                Crash & Replay
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="text-xs h-7 gap-1.5 hover:border-purple-500/50"
                onClick={() => applyRecipe('saga')}
              >
                <span className="size-2 rounded-full bg-purple-500" />
                Saga Rollback
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="text-xs h-7 gap-1.5 hover:border-rose-500/50 text-rose-500 hover:text-rose-500"
                onClick={() => applyRecipe('poison')}
              >
                <span className="size-2 rounded-full bg-rose-500" />
                Poison Pill
              </Button>
            </div>
          </div>

          {/* Target Workflow Selection */}
          <div className="space-y-1.5">
            <div className="text-xs font-semibold text-foreground">Target Workflow DAG</div>
            <Select
              value={activeWorkflow?.id || ''}
              onValueChange={(val) => {
                const found = workflows.find((w) => w.id === val);
                if (found) onSelectWorkflow(found);
              }}
            >
              <SelectTrigger className="w-full text-xs h-9 bg-background border-border">
                <SelectValue placeholder="Select workflow..." />
              </SelectTrigger>
              <SelectContent className="glass-panel border-border">
                {workflows.map((w) => (
                  <SelectItem key={w.id} value={w.id} className="text-xs">
                    {w.name} ({w.nodes?.length || 0} nodes)
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Execution Pacing / Observable Speed */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <div className="text-xs font-semibold text-foreground flex items-center gap-1.5">
                Execution Pacing (Observable Delay)
              </div>
              <Badge variant="outline" className="text-[11px] font-mono font-normal">
                {stepDelayMs === 400
                  ? '400ms (Fast)'
                  : stepDelayMs === 1200
                    ? '1,200ms (Observable)'
                    : '2,000ms (Slow-Mo)'}
              </Badge>
            </div>
            <div className="grid grid-cols-3 gap-2">
              <button
                type="button"
                onClick={() => setStepDelayMs(400)}
                className={`p-2.5 rounded-lg border text-left transition-all ${
                  stepDelayMs === 400
                    ? 'border-primary bg-primary/10 text-primary'
                    : 'border-border bg-background hover:bg-muted/50 text-muted-foreground'
                }`}
              >
                <div className="text-xs font-semibold text-foreground">Fast (400ms)</div>
                <div className="text-[11px] text-muted-foreground mt-0.5">Rapid throughput</div>
              </button>
              <button
                type="button"
                onClick={() => setStepDelayMs(1200)}
                className={`p-2.5 rounded-lg border text-left transition-all ${
                  stepDelayMs === 1200
                    ? 'border-primary bg-primary/10 text-primary'
                    : 'border-border bg-background hover:bg-muted/50 text-muted-foreground'
                }`}
              >
                <div className="text-xs font-semibold text-foreground">Observable (1.2s)</div>
                <div className="text-[11px] text-muted-foreground mt-0.5">
                  Recommended for demos
                </div>
              </button>
              <button
                type="button"
                onClick={() => setStepDelayMs(2000)}
                className={`p-2.5 rounded-lg border text-left transition-all ${
                  stepDelayMs === 2000
                    ? 'border-primary bg-primary/10 text-primary'
                    : 'border-border bg-background hover:bg-muted/50 text-muted-foreground'
                }`}
              >
                <div className="text-xs font-semibold text-foreground">Slow-Mo (2.0s)</div>
                <div className="text-[11px] text-muted-foreground mt-0.5">Deep inspection</div>
              </button>
            </div>
          </div>

          {/* Fault Injections Configuration */}
          <div className="space-y-3 pt-2 border-t border-border">
            <div className="flex items-center justify-between">
              <div className="text-xs font-semibold text-foreground uppercase tracking-wider flex items-center gap-1.5">
                Fault Injection Scenarios
              </div>
              <Badge variant={activeInjectionsCount > 0 ? 'rose' : 'glass'} className="text-[11px]">
                {activeInjectionsCount} active
              </Badge>
            </div>

            {/* 1. Worker Fencing Zombie Delay */}
            <div className="p-3 rounded-lg border border-border bg-background/60 space-y-2">
              <div className="flex items-center justify-between">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={enableZombie}
                    onChange={(e) => setEnableZombie(e.target.checked)}
                    className="size-4 rounded border-border text-primary focus:ring-primary accent-primary"
                  />
                  <div>
                    <div className="text-xs font-medium text-foreground">
                      Worker Lease Freeze (Zombie Fencing)
                    </div>
                    <div className="text-[11px] text-muted-foreground">
                      Simulates GC pause; new worker takes over with higher token; stale commit is
                      rejected.
                    </div>
                  </div>
                </label>
              </div>
              {enableZombie && (
                <div className="pt-1.5 pl-6 flex items-center gap-2">
                  <span className="text-xs text-muted-foreground shrink-0">Target Node:</span>
                  <Select value={zombieNodeId} onValueChange={setZombieNodeId}>
                    <SelectTrigger className="h-7 text-xs bg-card border-border flex-1">
                      <SelectValue placeholder="Pick node..." />
                    </SelectTrigger>
                    <SelectContent className="glass-panel border-border">
                      {taskNodes.map((n) => (
                        <SelectItem key={n.id} value={n.id} className="text-xs">
                          {n.name} ({n.id})
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
            </div>

            {/* 2. Coordinator Crash & Replay */}
            <div className="p-3 rounded-lg border border-border bg-background/60 space-y-2">
              <div className="flex items-center justify-between">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={enableCrash}
                    onChange={(e) => setEnableCrash(e.target.checked)}
                    className="size-4 rounded border-border text-primary focus:ring-primary accent-primary"
                  />
                  <div>
                    <div className="text-xs font-medium text-foreground">
                      Coordinator Crash & Zero-Loss Replay
                    </div>
                    <div className="text-[11px] text-muted-foreground">
                      Kills orchestrator process at this step; reboots and reconstructs state from
                      event log.
                    </div>
                  </div>
                </label>
              </div>
              {enableCrash && (
                <div className="pt-1.5 pl-6 flex items-center gap-2">
                  <span className="text-xs text-muted-foreground shrink-0">
                    Crash When Starting:
                  </span>
                  <Select value={crashNodeId} onValueChange={setCrashNodeId}>
                    <SelectTrigger className="h-7 text-xs bg-card border-border flex-1">
                      <SelectValue placeholder="Pick node..." />
                    </SelectTrigger>
                    <SelectContent className="glass-panel border-border">
                      {taskNodes.map((n) => (
                        <SelectItem key={n.id} value={n.id} className="text-xs">
                          {n.name} ({n.id})
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
            </div>

            {/* 3. Force Task Failure (Saga Rollback) */}
            <div className="p-3 rounded-lg border border-border bg-background/60 space-y-2">
              <div className="flex items-center justify-between">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={enableFailure}
                    onChange={(e) => setEnableFailure(e.target.checked)}
                    className="size-4 rounded border-border text-primary focus:ring-primary accent-primary"
                  />
                  <div>
                    <div className="text-xs font-medium text-foreground">
                      Force Task Failure (Trigger Saga Rollback)
                    </div>
                    <div className="text-[11px] text-muted-foreground">
                      Throws an exception. Active siblings receive abort signals and completed steps
                      compensate.
                    </div>
                  </div>
                </label>
              </div>
              {enableFailure && (
                <div className="pt-1.5 pl-6 flex items-center gap-2">
                  <span className="text-xs text-muted-foreground shrink-0">Failing Node:</span>
                  <Select value={failNodeId} onValueChange={setFailNodeId}>
                    <SelectTrigger className="h-7 text-xs bg-card border-border flex-1">
                      <SelectValue placeholder="Pick node..." />
                    </SelectTrigger>
                    <SelectContent className="glass-panel border-border">
                      {taskNodes.map((n) => (
                        <SelectItem key={n.id} value={n.id} className="text-xs">
                          {n.name} ({n.id})
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
            </div>

            {/* 4. Poison Pill Quarantine */}
            <div className="p-3 rounded-lg border border-border bg-background/60 space-y-2">
              <div className="flex items-center justify-between">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={enablePoisonPill}
                    onChange={(e) => setEnablePoisonPill(e.target.checked)}
                    className="size-4 rounded border-border text-primary focus:ring-primary accent-primary"
                  />
                  <div>
                    <div className="text-xs font-medium text-rose-600 dark:text-rose-400">
                      Poison Pill Quarantine (Exhaust Retries)
                    </div>
                    <div className="text-[11px] text-muted-foreground">
                      Rollback compensation fails repeatedly, quarantining workflow into the
                      Recovery Queue.
                    </div>
                  </div>
                </label>
              </div>
              {enablePoisonPill && (
                <div className="pt-1.5 pl-6 flex items-center gap-2">
                  <span className="text-xs text-muted-foreground shrink-0">
                    Target Rollback Node:
                  </span>
                  <Select value={poisonPillNodeId} onValueChange={setPoisonPillNodeId}>
                    <SelectTrigger className="h-7 text-xs bg-card border-border flex-1">
                      <SelectValue placeholder="Pick node..." />
                    </SelectTrigger>
                    <SelectContent className="glass-panel border-border">
                      {taskNodes
                        .filter((n) => n.compensationType)
                        .map((n) => (
                          <SelectItem key={n.id} value={n.id} className="text-xs">
                            {n.name} ({n.compensationType})
                          </SelectItem>
                        ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
            </div>
          </div>
        </div>

        <DialogFooter className="pt-3 border-t border-border flex items-center justify-between gap-3 sm:justify-between">
          <div className="text-xs text-muted-foreground">
            {activeInjectionsCount === 0 ? (
              <span className="text-emerald-500 font-medium">Clean Run (No Faults)</span>
            ) : (
              <span className="text-amber-500 font-medium">
                {activeInjectionsCount} fault{activeInjectionsCount > 1 ? 's' : ''} scheduled
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => onOpenChange(false)}
              className="text-xs h-8"
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="default"
              size="sm"
              onClick={handleLaunch}
              disabled={isRunning}
              className="text-xs h-8 font-medium gap-1.5"
            >
              <Play className="size-3.5 fill-current" />
              Launch Test
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
