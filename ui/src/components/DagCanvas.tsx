import {
  Background,
  BackgroundVariant,
  Controls,
  type Edge,
  type Node,
  ReactFlow,
  useEdgesState,
  useNodesState,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { NodeRuntimeState, WorkflowDefinition, WorkflowEdge, WorkflowNode } from '@core/types';
import dagre from '@dagrejs/dagre';
import { useEffect, useMemo, useRef } from 'react';

import { CustomDagNode } from './CustomDagNode';

const nodeTypes = {
  customDagNode: CustomDagNode,
};

const IDLE_STATE: NodeRuntimeState = { status: 'IDLE', attempts: 0 };

interface DagCanvasProps {
  workflow: WorkflowDefinition | null;
  nodeStates: Record<string, NodeRuntimeState>;
  onZombieClick?: (nodeId: string) => void;
  isDark?: boolean;
}

export function DagCanvas({ workflow, nodeStates, onZombieClick, isDark = true }: DagCanvasProps) {
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const workflowIdRef = useRef<string | null>(null);

  // Layout is computed only when the workflow definition changes. Telemetry frames
  // must not trigger Dagre (it is relatively expensive and would reset drag positions).
  const layout = useMemo(() => {
    if (!workflow?.nodes) return { layoutNodes: [] as Node[] };

    const dagreGraph = new dagre.graphlib.Graph();
    dagreGraph.setDefaultEdgeLabel(() => ({}));
    dagreGraph.setGraph({ rankdir: 'LR', ranksep: 70, nodesep: 35 });

    const nodeWidth = 275;
    const nodeHeight = 150;

    for (const n of workflow.nodes) {
      dagreGraph.setNode(n.id, { width: nodeWidth, height: nodeHeight });
    }

    for (const e of workflow.edges) {
      dagreGraph.setEdge(e.source, e.target);
    }

    dagre.layout(dagreGraph);

    const layoutNodes: Node[] = workflow.nodes.map((n: WorkflowNode) => {
      const nodeWithPos = dagreGraph.node(n.id);
      return {
        id: n.id,
        type: 'customDagNode',
        position: {
          x: nodeWithPos.x - nodeWidth / 2,
          y: nodeWithPos.y - nodeHeight / 2,
        },
        data: {
          node: n,
          state: IDLE_STATE,
        },
      };
    });

    return { layoutNodes };
  }, [workflow]);

  // Merge live state into the stable layout. Existing positions (including user drags)
  // are preserved unless the workflow itself changed.
  useEffect(() => {
    if (!workflow) {
      setNodes([]);
      setEdges([]);
      workflowIdRef.current = null;
      return;
    }

    const workflowChanged = workflowIdRef.current !== workflow.id;
    workflowIdRef.current = workflow.id;

    setNodes((prev) => {
      const previousById = new Map(prev.map((node) => [node.id, node]));
      return layout.layoutNodes.map((layoutNode) => {
        const state = nodeStates[layoutNode.id] || IDLE_STATE;
        const previous = workflowChanged ? undefined : previousById.get(layoutNode.id);
        return {
          ...layoutNode,
          ...(previous
            ? {
                position: previous.position,
                selected: previous.selected,
                dragging: previous.dragging,
              }
            : {}),
          data: {
            ...layoutNode.data,
            state,
            onZombieClick,
          },
        };
      });
    });
  }, [workflow, layout, nodeStates, onZombieClick, setNodes, setEdges]);

  // Edge styling is cheap and can follow live state every frame.
  const layoutEdges = useMemo<Edge[]>(() => {
    if (!workflow) return [];
    return workflow.edges.map((e: WorkflowEdge) => {
      const sourceState = nodeStates[e.source];
      const targetState = nodeStates[e.target];

      const isSourceDone = sourceState?.status === 'COMPLETED';
      const isTargetActive =
        targetState?.status === 'RUNNING' || targetState?.status === 'SCHEDULED';
      const isCompensating =
        sourceState?.status === 'COMPENSATING' ||
        sourceState?.status === 'COMPENSATED' ||
        targetState?.status === 'COMPENSATING' ||
        targetState?.status === 'COMPENSATED';

      let strokeColor = isDark ? 'rgba(148, 163, 184, 0.25)' : 'rgba(100, 116, 139, 0.25)';
      let isAnimated = false;

      if (isCompensating) {
        strokeColor = '#a855f7';
        isAnimated = true;
      } else if (isTargetActive) {
        strokeColor = '#38bdf8';
        isAnimated = true;
      } else if (isSourceDone) {
        strokeColor = '#10b981';
      }

      return {
        id: e.id,
        source: e.source,
        target: e.target,
        animated: isAnimated,
        style: {
          stroke: strokeColor,
          strokeWidth: isAnimated ? 2.5 : 1.75,
          transition: 'stroke 0.2s ease, stroke-width 0.2s ease',
        },
      };
    });
  }, [workflow, nodeStates, isDark]);

  useEffect(() => {
    setEdges(layoutEdges);
  }, [layoutEdges, setEdges]);

  if (!workflow) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground text-sm">
        Select a workflow template to inspect DAG execution
      </div>
    );
  }

  return (
    <div className="relative w-full h-full bg-card">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        fitView
        fitViewOptions={{ padding: 0.15 }}
        minZoom={0.2}
        maxZoom={1.5}
        proOptions={{ hideAttribution: true }}
      >
        <Background
          variant={BackgroundVariant.Dots}
          gap={24}
          size={1}
          color={isDark ? 'rgba(255, 255, 255, 0.08)' : 'rgba(15, 23, 42, 0.08)'}
        />
        <Controls className="!bg-card !border-border !rounded-lg overflow-hidden fill-foreground shadow-xs" />
      </ReactFlow>
    </div>
  );
}
