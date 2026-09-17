import type {
  ChaosConfig,
  EventRecord,
  NodeRuntimeState,
  TelemetryFrame,
  WorkerLease,
  WorkflowDefinition,
  WorkflowStatus,
} from '@core/types';
import { useCallback, useEffect, useRef, useState } from 'react';

export function useWorkflowEngine() {
  const [workflows, setWorkflows] = useState<WorkflowDefinition[]>([]);
  const [selectedWorkflow, setSelectedWorkflow] = useState<WorkflowDefinition | null>(null);
  const [activeExecutionId, setActiveExecutionId] = useState<string | null>(null);
  const [workflowStatus, setWorkflowStatus] = useState<WorkflowStatus>('PENDING');
  const [nodeStates, setNodeStates] = useState<Record<string, NodeRuntimeState>>({});
  const [activeLeases, setActiveLeases] = useState<WorkerLease[]>([]);
  const [activeFencingToken, setActiveFencingToken] = useState<number>(0);
  const [events, setEvents] = useState<EventRecord[]>([]);
  const [contextState, setContextState] = useState<Record<string, any>>({});
  const [activeChaosConfig, setActiveChaosConfig] = useState<ChaosConfig | null>(null);
  const [metrics, setMetrics] = useState({
    totalNodes: 0,
    completedNodes: 0,
    failedNodes: 0,
    compensatedNodes: 0,
    zombieWritesBlocked: 0,
    crashesRecovered: 0,
  });

  // Time-Travel Debugging State
  const [isTimeTraveling, setIsTimeTraveling] = useState<boolean>(false);
  const [timeTravelSequence, setTimeTravelSequence] = useState<number>(1);
  const [timeTravelData, setTimeTravelData] = useState<{
    nodeStates: Record<string, any>;
    contextState: Record<string, any>;
    eventSnapshot: EventRecord | null;
  } | null>(null);

  // Historical Execution Inspection State
  const [isHistoricalView, setIsHistoricalView] = useState<boolean>(false);
  const [historicalExecution, setHistoricalExecution] = useState<any | null>(null);

  const [isConnected, setIsConnected] = useState<boolean>(false);
  const wsRef = useRef<WebSocket | null>(null);

  // Fetch available workflows
  const fetchWorkflows = useCallback(async () => {
    try {
      const res = await fetch('/api/workflows');
      if (res.ok) {
        const list: WorkflowDefinition[] = await res.json();
        setWorkflows(list);
        if (list.length > 0 && !selectedWorkflow) {
          setSelectedWorkflow(list[0]);
        }
      }
    } catch (err) {
      console.error('Error fetching workflows:', err);
    }
  }, [selectedWorkflow]);

  // Connect WebSocket
  useEffect(() => {
    fetchWorkflows();

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws`;

    let ws: WebSocket;
    let reconnectTimeout: any;

    function connect() {
      ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        setIsConnected(true);
      };

      ws.onclose = () => {
        setIsConnected(false);
        reconnectTimeout = setTimeout(connect, 2000);
      };

      ws.onerror = () => {
        ws.close();
      };

      ws.onmessage = (event) => {
        try {
          // If the user is inspecting a past execution, ignore live telemetry stream
          if (isHistoricalView) return;

          const msg = JSON.parse(event.data);
          if (msg.type === 'TELEMETRY_FRAME') {
            const frame: TelemetryFrame = msg.data;
            if (!isTimeTraveling) {
              setWorkflowStatus(frame.status);
              setNodeStates(frame.nodeStates);
              setActiveLeases(frame.activeLeases || []);
              setActiveFencingToken(frame.activeFencingToken || 0);
              setContextState(frame.contextState || {});
              if (frame.metrics) setMetrics(frame.metrics);
            }
          } else if (msg.type === 'EVENT_RECORD') {
            const evt: EventRecord = msg.data;
            setEvents((prev) => {
              if (prev.some((e) => e.id === evt.id)) return prev;
              const next = [...prev, evt].sort((a, b) => a.sequenceId - b.sequenceId);
              return next;
            });
          } else if (msg.type === 'WORKFLOW_STATUS_CHANGED') {
            if (!isTimeTraveling) {
              setWorkflowStatus(msg.data.status);
            }
          }
        } catch {
          // Ignored
        }
      };
    }

    connect();

    return () => {
      clearTimeout(reconnectTimeout);
      if (ws) ws.close();
    };
  }, [fetchWorkflows, isTimeTraveling, isHistoricalView]);

  // Trigger new execution
  const triggerWorkflow = async (defId?: string, customInput?: any, chaosConfig?: ChaosConfig) => {
    const targetDef = defId
      ? workflows.find((w) => w.id === defId) || selectedWorkflow
      : selectedWorkflow;
    if (!targetDef) return;

    // Reset local view
    setEvents([]);
    setIsTimeTraveling(false);
    setTimeTravelData(null);
    setNodeStates({});
    setIsHistoricalView(false);
    setHistoricalExecution(null);
    setActiveChaosConfig(chaosConfig || null);

    try {
      const res = await fetch(`/api/workflows/${targetDef.id}/trigger`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          input: customInput || { initiatedBy: 'Web UI', timestamp: Date.now() },
          chaosConfig,
        }),
      });
      const data = await res.json();
      if (data.success && data.executionId) {
        setActiveExecutionId(data.executionId);
        setWorkflowStatus('RUNNING');
      }
    } catch (err) {
      console.error('Trigger workflow failed:', err);
    }
  };

  // Load a historical execution for inspection and time-travel replay
  const loadExecution = async (executionId: string) => {
    try {
      // 1. Fetch execution record
      const execRes = await fetch(`/api/executions/${executionId}`);
      if (!execRes.ok) throw new Error('Failed to load execution');
      const exec = await execRes.json();

      // 2. Fetch all events
      const eventsRes = await fetch(`/api/executions/${executionId}/events`);
      const eventList: EventRecord[] = eventsRes.ok ? await eventsRes.json() : [];

      // 3. Ensure corresponding workflow is selected
      let targetWorkflow = workflows.find((w) => w.id === exec.workflowDefinitionId);
      if (!targetWorkflow) {
        const defRes = await fetch(`/api/workflows/${exec.workflowDefinitionId}`);
        if (defRes.ok) {
          targetWorkflow = await defRes.json();
        }
      }
      if (targetWorkflow) {
        setSelectedWorkflow(targetWorkflow);
      }

      // 4. Update state to reflect past test run
      setActiveExecutionId(exec.id);
      setWorkflowStatus(exec.status);
      setNodeStates(exec.nodeStates || {});
      setContextState(exec.contextState || {});
      setActiveChaosConfig(exec.chaosConfig || null);
      setActiveFencingToken(exec.activeFencingToken || 0);
      setEvents(eventList);
      setIsHistoricalView(true);
      setHistoricalExecution(exec);

      // Reset time travel scrubber to final sequence
      setIsTimeTraveling(false);
      setTimeTravelData(null);
      if (eventList.length > 0) {
        setTimeTravelSequence(eventList[eventList.length - 1].sequenceId);
      }
      return true;
    } catch (err) {
      console.error('Failed to load historical execution:', err);
      return false;
    }
  };

  const exitHistoricalView = () => {
    setIsHistoricalView(false);
    setHistoricalExecution(null);
    setIsTimeTraveling(false);
    setTimeTravelData(null);
  };

  // Time-Travel Scrubber function
  const scrubToSequence = async (seq: number) => {
    if (!activeExecutionId) return;
    setIsTimeTraveling(true);
    setTimeTravelSequence(seq);

    try {
      const res = await fetch(`/api/executions/${activeExecutionId}/time-travel?sequenceId=${seq}`);
      if (res.ok) {
        const data = await res.json();
        setTimeTravelData({
          nodeStates: data.nodeStates,
          contextState: data.contextState,
          eventSnapshot: data.eventSnapshot,
        });
      }
    } catch (err) {
      console.error('Time travel scrub error:', err);
    }
  };

  const exitTimeTravel = () => {
    setIsTimeTraveling(false);
    setTimeTravelData(null);
  };

  // Simulation Controls
  const triggerZombieDelay = async (nodeId: string) => {
    if (!activeExecutionId) return;
    try {
      const res = await fetch(`/api/executions/${activeExecutionId}/simulate-zombie`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nodeId }),
      });
      return await res.json();
    } catch (err) {
      console.error('Zombie simulation error:', err);
    }
  };

  const triggerSimulatedCrash = async () => {
    if (!activeExecutionId) return;
    try {
      const res = await fetch(`/api/executions/${activeExecutionId}/simulate-crash`, {
        method: 'POST',
      });
      return await res.json();
    } catch (err) {
      console.error('Crash simulation error:', err);
    }
  };

  return {
    workflows,
    selectedWorkflow,
    setSelectedWorkflow,
    activeExecutionId,
    workflowStatus,
    nodeStates: isTimeTraveling && timeTravelData ? timeTravelData.nodeStates : nodeStates,
    contextState: isTimeTraveling && timeTravelData ? timeTravelData.contextState : contextState,
    activeLeases,
    activeFencingToken,
    events,
    metrics,
    isConnected,
    isTimeTraveling,
    timeTravelSequence,
    timeTravelData,
    triggerWorkflow,
    activeChaosConfig,
    scrubToSequence,
    exitTimeTravel,
    triggerZombieDelay,
    triggerSimulatedCrash,
    refreshWorkflows: fetchWorkflows,
    isHistoricalView,
    historicalExecution,
    loadExecution,
    exitHistoricalView,
  };
}
