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

import { isMessageForActiveExecution } from '../lib/telemetry';

const EMPTY_METRICS = {
  totalNodes: 0,
  completedNodes: 0,
  failedNodes: 0,
  compensatedNodes: 0,
  zombieWritesBlocked: 0,
  crashesRecovered: 0,
};

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
  const [metrics, setMetrics] = useState(EMPTY_METRICS);

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

  // Refs keep the WebSocket handler stable (no reconnect storm while scrubbing).
  const wsRef = useRef<WebSocket | null>(null);
  const activeExecutionIdRef = useRef<string | null>(null);
  const isTimeTravelingRef = useRef<boolean>(false);
  const isHistoricalViewRef = useRef<boolean>(false);

  const setActiveExecution = useCallback((executionId: string | null) => {
    activeExecutionIdRef.current = executionId;
    setActiveExecutionId(executionId);
  }, []);

  const setTimeTraveling = useCallback((value: boolean) => {
    isTimeTravelingRef.current = value;
    setIsTimeTraveling(value);
  }, []);

  const setHistoricalView = useCallback((value: boolean) => {
    isHistoricalViewRef.current = value;
    setIsHistoricalView(value);
  }, []);

  const resetDerivedState = useCallback(() => {
    setEvents([]);
    setNodeStates({});
    setContextState({});
    setActiveLeases([]);
    setActiveFencingToken(0);
    setMetrics(EMPTY_METRICS);
  }, []);

  // Fetch available workflows (stable: no selectedWorkflow dependency)
  const fetchWorkflows = useCallback(async () => {
    try {
      const res = await fetch('/api/workflows');
      if (res.ok) {
        const list: WorkflowDefinition[] = await res.json();
        setWorkflows(list);
        setSelectedWorkflow((prev) => prev ?? list[0] ?? null);
      }
    } catch (err) {
      console.error('Error fetching workflows:', err);
    }
  }, []);

  // Connect WebSocket exactly once per mount.
  useEffect(() => {
    fetchWorkflows();

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws`;

    let shouldReconnect = true;
    let reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
    let reconnectDelay = 2000;
    let ws: WebSocket | null = null;

    function scheduleReconnect() {
      if (!shouldReconnect) return;
      reconnectTimeout = setTimeout(connect, reconnectDelay);
      reconnectDelay = Math.min(15000, Math.round(reconnectDelay * 1.5));
    }

    function connect() {
      if (!shouldReconnect) return;
      ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        reconnectDelay = 2000;
        setIsConnected(true);
      };

      ws.onclose = () => {
        setIsConnected(false);
        wsRef.current = null;
        scheduleReconnect();
      };

      ws.onerror = () => {
        ws?.close();
      };

      ws.onmessage = (event) => {
        try {
          // Historical inspection is a static snapshot: ignore live traffic.
          if (isHistoricalViewRef.current) return;

          const msg = JSON.parse(event.data);
          if (msg.type === 'TELEMETRY_FRAME') {
            // While scrubbing, keep the replayed state but continue collecting events.
            if (isTimeTravelingRef.current) return;
            const frame: TelemetryFrame = msg.data;
            if (
              !isMessageForActiveExecution(frame.workflowExecutionId, activeExecutionIdRef.current)
            ) {
              return;
            }
            setWorkflowStatus(frame.status);
            setNodeStates(frame.nodeStates);
            setActiveLeases(frame.activeLeases || []);
            setActiveFencingToken(frame.activeFencingToken || 0);
            setContextState(frame.contextState || {});
            if (frame.metrics) setMetrics(frame.metrics);
          } else if (msg.type === 'EVENT_RECORD') {
            const evt: EventRecord = msg.data;
            if (
              !isMessageForActiveExecution(evt.workflowExecutionId, activeExecutionIdRef.current)
            ) {
              return;
            }
            setEvents((prev) => {
              if (prev.some((e) => e.id === evt.id)) return prev;
              const next = [...prev, evt].sort((a, b) => a.sequenceId - b.sequenceId);
              return next;
            });
          } else if (msg.type === 'WORKFLOW_STATUS_CHANGED') {
            if (isTimeTravelingRef.current) return;
            if (!isMessageForActiveExecution(msg.data.executionId, activeExecutionIdRef.current)) {
              return;
            }
            setWorkflowStatus(msg.data.status);
          }
        } catch {
          // Ignored
        }
      };
    }

    connect();

    return () => {
      shouldReconnect = false;
      if (reconnectTimeout) clearTimeout(reconnectTimeout);
      ws?.close();
      wsRef.current = null;
    };
  }, [fetchWorkflows]);

  // Backfill the event log after a trigger so events emitted before the response
  // (or before the WebSocket connected) are not lost.
  const backfillEvents = useCallback(async (executionId: string) => {
    try {
      const res = await fetch(`/api/executions/${executionId}/events`);
      if (res.ok) {
        const eventList: EventRecord[] = await res.json();
        setEvents((prev) => {
          const byId = new Map(prev.map((evt) => [evt.id, evt]));
          for (const evt of eventList) byId.set(evt.id, evt);
          return [...byId.values()].sort((a, b) => a.sequenceId - b.sequenceId);
        });
      }
    } catch (err) {
      console.error('Failed to backfill events:', err);
    }
  }, []);

  // Re-read the durable execution snapshot to cover telemetry frames that arrived
  // before the trigger response assigned the active execution id.
  const refreshExecution = useCallback(async (executionId: string) => {
    try {
      const res = await fetch(`/api/executions/${executionId}`);
      if (!res.ok) return;
      const exec = await res.json();
      setWorkflowStatus(exec.status);
      // Do not clear live state with an empty in-flight DB snapshot.
      if (exec.nodeStates && Object.keys(exec.nodeStates).length > 0) {
        setNodeStates(exec.nodeStates);
      }
      if (exec.contextState && Object.keys(exec.contextState).length > 0) {
        setContextState(exec.contextState);
      }
      setActiveFencingToken((prev) => Math.max(prev, Number(exec.activeFencingToken) || 0));
      if (exec.chaosConfig) setActiveChaosConfig(exec.chaosConfig);
    } catch (err) {
      console.error('Failed to refresh execution:', err);
    }
  }, []);

  // Trigger new execution
  const triggerWorkflow = async (defId?: string, customInput?: any, chaosConfig?: ChaosConfig) => {
    const targetDef = defId
      ? workflows.find((w) => w.id === defId) || selectedWorkflow
      : selectedWorkflow;
    if (!targetDef) return;

    // Reset local view and detach from the previous execution before the request.
    setActiveExecution(null);
    setHistoricalView(false);
    setHistoricalExecution(null);
    setTimeTraveling(false);
    setTimeTravelData(null);
    resetDerivedState();
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
        setActiveExecution(data.executionId);
        setWorkflowStatus(data.status || 'RUNNING');
        setTimeTravelSequence(1);
        void backfillEvents(data.executionId);
        void refreshExecution(data.executionId);
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
      setActiveExecution(exec.id);
      setHistoricalView(true);
      setTimeTraveling(false);
      setTimeTravelData(null);
      setWorkflowStatus(exec.status);
      setNodeStates(exec.nodeStates || {});
      setContextState(exec.contextState || {});
      setActiveChaosConfig(exec.chaosConfig || null);
      setActiveFencingToken(exec.activeFencingToken || 0);
      setActiveLeases([]);

      const nodeStateValues = Object.values(exec.nodeStates || {}) as NodeRuntimeState[];
      setMetrics({
        totalNodes: nodeStateValues.length,
        completedNodes: nodeStateValues.filter((s) => s.status === 'COMPLETED').length,
        failedNodes: nodeStateValues.filter((s) => s.status === 'FAILED').length,
        compensatedNodes: nodeStateValues.filter((s) => s.status === 'COMPENSATED').length,
        zombieWritesBlocked: eventList.filter((evt) => evt.eventType === 'WorkerFencingRejected')
          .length,
        crashesRecovered: eventList.filter((evt) => evt.eventType === 'WorkflowRecoveredFromCrash')
          .length,
      });

      setEvents(eventList);
      setHistoricalExecution(exec);

      // Reset time travel scrubber to final sequence
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
    setHistoricalView(false);
    setHistoricalExecution(null);
    setTimeTraveling(false);
    setTimeTravelData(null);
  };

  // Time-Travel Scrubber function
  const scrubToSequence = async (seq: number) => {
    if (!activeExecutionId) return;
    setTimeTraveling(true);
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
    setTimeTraveling(false);
    setTimeTravelData(null);
  };

  // Simulation Controls
  const triggerZombieDelay = useCallback(
    async (nodeId: string) => {
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
    },
    [activeExecutionId]
  );

  const triggerSimulatedCrash = useCallback(async () => {
    if (!activeExecutionId) return;
    try {
      const res = await fetch(`/api/executions/${activeExecutionId}/simulate-crash`, {
        method: 'POST',
      });
      return await res.json();
    } catch (err) {
      console.error('Crash simulation error:', err);
    }
  }, [activeExecutionId]);

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
