import { useState } from 'react';
import { DagCanvas } from './components/DagCanvas';
import { EventLogViewer } from './components/EventLogViewer';
import { Header } from './components/Header';
import { PastTestsModal } from './components/PastTestsModal';
import { PoisonPillModal } from './components/PoisonPillModal';
import { SimulationPanel } from './components/SimulationPanel';
import { TestConfigurationModal } from './components/TestConfigurationModal';
import { TimeTravelSlider } from './components/TimeTravelSlider';
import { Badge } from './components/ui/badge';
import { Button } from './components/ui/button';
import { WorkerPoolViewer } from './components/WorkerPoolViewer';
import { useTheme } from './hooks/useTheme';
import { useWorkflowEngine } from './hooks/useWorkflowEngine';

export function App() {
  const { isDark, toggleTheme } = useTheme();
  const {
    workflows,
    selectedWorkflow,
    setSelectedWorkflow,
    activeExecutionId,
    workflowStatus,
    nodeStates,
    activeLeases,
    activeFencingToken,
    activeChaosConfig,
    events,
    metrics,
    isTimeTraveling,
    timeTravelSequence,
    timeTravelData,
    triggerWorkflow,
    scrubToSequence,
    exitTimeTravel,
    triggerZombieDelay,
    isHistoricalView,
    loadExecution,
    exitHistoricalView,
  } = useWorkflowEngine();

  const [isPoisonPillOpen, setIsPoisonPillOpen] = useState<boolean>(false);
  const [isTestConfigOpen, setIsTestConfigOpen] = useState<boolean>(false);
  const [isHistoryOpen, setIsHistoryOpen] = useState<boolean>(false);

  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col antialiased">
      {/* Top Navigation Header */}
      <Header
        workflows={workflows}
        selectedWorkflow={selectedWorkflow}
        onSelectWorkflow={setSelectedWorkflow}
        workflowStatus={workflowStatus}
        activeExecutionId={activeExecutionId}
        isDark={isDark}
        onToggleTheme={toggleTheme}
        onTriggerExecution={() => triggerWorkflow()}
        onOpenPoisonPillModal={() => setIsPoisonPillOpen(true)}
        onOpenTestConfigModal={() => setIsTestConfigOpen(true)}
        onOpenHistoryModal={() => setIsHistoryOpen(true)}
        isHistoricalView={isHistoricalView}
      />

      {/* Main Workspace */}
      <main className="flex-1 p-5 md:p-6 max-w-[1600px] w-full mx-auto space-y-6">
        {/* Historical View Banner */}
        {isHistoricalView && (
          <div className="rounded-xl border border-purple-500/30 bg-purple-500/10 px-4 py-2.5 flex items-center justify-between gap-3 text-xs">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-semibold text-purple-600 dark:text-purple-400">
                Viewing Historical Run:
              </span>
              <span className="font-mono text-foreground font-medium">{activeExecutionId}</span>
              <Badge variant="purple" className="text-[10px]">
                {workflowStatus}
              </Badge>
              <span className="text-muted-foreground hidden sm:inline">
                &bull; Scrub the time-travel slider below to replay DAG states
              </span>
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={exitHistoricalView}
              className="h-7 text-xs px-2.5 border-purple-500/30 hover:bg-purple-500/20 shrink-0"
            >
              Return to Live Mode
            </Button>
          </div>
        )}
        {/* Interactive DAG Canvas */}
        <div className="h-[480px] w-full rounded-xl overflow-hidden relative border border-border bg-card shadow-xs">
          <DagCanvas
            workflow={selectedWorkflow}
            nodeStates={nodeStates}
            onZombieClick={(nodeId) => triggerZombieDelay(nodeId)}
            isDark={isDark}
          />

          {/* Canvas Floating Overlay Controls */}
          <div className="absolute top-3.5 left-3.5 z-10 flex items-center gap-2">
            <div className="px-3 py-1.5 rounded-lg bg-card/90 backdrop-blur-md border border-border text-xs font-medium flex items-center gap-2.5 shadow-xs">
              <span className="text-foreground">{selectedWorkflow?.name}</span>
              <span className="text-muted-foreground">|</span>
              <Badge variant="outline" className="text-xs font-normal px-2 py-0">
                {selectedWorkflow?.nodes?.length || 0} Nodes
              </Badge>
            </div>
          </div>
        </div>

        {/* Time-Travel Debugging Slider */}
        <TimeTravelSlider
          events={events}
          isTimeTraveling={isTimeTraveling}
          currentSequence={timeTravelSequence}
          timeTravelSnapshot={timeTravelData?.eventSnapshot || null}
          onScrub={scrubToSequence}
          onExitTimeTravel={exitTimeTravel}
        />

        {/* Operational Split Grid: Chaos Lab & Fencing Pool on Left, Event Store Log on Right */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          {/* Left Column: Chaos Lab & Worker Pool */}
          <div className="lg:col-span-6 space-y-6">
            <SimulationPanel
              workflowStatus={workflowStatus}
              activeChaosConfig={activeChaosConfig}
              onLaunchConfiguredTest={(presetId, chaosConfig) => {
                if (presetId) {
                  const target = workflows.find((w) => w.id === presetId);
                  if (target) setSelectedWorkflow(target);
                }
                triggerWorkflow(presetId, undefined, chaosConfig);
              }}
            />

            <WorkerPoolViewer
              activeLeases={activeLeases}
              activeFencingToken={activeFencingToken}
              zombieWritesBlocked={metrics.zombieWritesBlocked}
            />
          </div>

          {/* Right Column: Append-Only Event Store Log */}
          <div className="lg:col-span-6 space-y-6">
            <EventLogViewer events={events} />
          </div>
        </div>
      </main>

      {/* Footer */}
      <footer className="w-full border-t border-border bg-card/30 py-4 px-6 text-center text-xs text-muted-foreground mt-auto">
        Sequent Engine &bull; Distributed Event-Sourced Workflows with Worker Fencing &
        Deterministic Replay
      </footer>

      {/* Modals */}
      <PastTestsModal
        open={isHistoryOpen}
        onOpenChange={setIsHistoryOpen}
        onSelectExecution={(execId) => loadExecution(execId)}
        currentExecutionId={activeExecutionId}
        isHistoricalView={isHistoricalView}
      />
      <PoisonPillModal open={isPoisonPillOpen} onOpenChange={setIsPoisonPillOpen} />
      <TestConfigurationModal
        open={isTestConfigOpen}
        onOpenChange={setIsTestConfigOpen}
        workflows={workflows}
        selectedWorkflow={selectedWorkflow}
        onSelectWorkflow={setSelectedWorkflow}
        isRunning={workflowStatus === 'RUNNING'}
        onLaunchTest={(defId, chaosConfig) => {
          const target = workflows.find((w) => w.id === defId);
          if (target) setSelectedWorkflow(target);
          triggerWorkflow(defId, undefined, chaosConfig);
        }}
      />
    </div>
  );
}

export default App;
