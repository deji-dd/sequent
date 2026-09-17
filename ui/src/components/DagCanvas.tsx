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
import { useEffect, useMemo } from 'react';
import { CustomDagNode } from './CustomDagNode';

const nodeTypes = {
  customDagNode: CustomDagNode,
};

interface DagCanvasProps {
  workflow: WorkflowDefinition | null;
  nodeStates: Record<string, NodeRuntimeState>;
  onZombieClick?: (nodeId: string) => void;
  isDark?: boolean;
}

export function DagCanvas({ workflow, nodeStates, onZombieClick, isDark = true }: DagCanvasProps) {
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);

  // Layout calculation with dagre
  const layoutedElements = useMemo(() => {
    if (!workflow?.nodes) return { nodes: [], edges: [] };

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
      const state = nodeStates[n.id] || { status: 'IDLE', attempts: 0 };

      return {
        id: n.id,
        type: 'customDagNode',
        position: {
          x: nodeWithPos.x - nodeWidth / 2,
          y: nodeWithPos.y - nodeHeight / 2,
        },
        data: {
          node: n,
          state,
          onZombieClick,
        },
      };
    });

    const layoutEdges: Edge[] = workflow.edges.map((e: WorkflowEdge) => {
      const sourceState = nodeStates[e.source];
      const targetState = nodeStates[e.target];

      const isSourceDone = sourceState?.status === 'COMPLETED';
      const isTargetActive =
        targetState?.status === 'RUNNING' || targetState?.status === 'SCHEDULED';
      const isCompensating =
        sourceState?.status === 'COMPENSATING' || targetState?.status === 'COMPENSATING';

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

    return { nodes: layoutNodes, edges: layoutEdges };
  }, [workflow, nodeStates, onZombieClick, isDark]);

  useEffect(() => {
    setNodes(layoutedElements.nodes);
    setEdges(layoutedElements.edges);
  }, [layoutedElements, setNodes, setEdges]);

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
