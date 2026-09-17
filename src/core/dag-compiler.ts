import type { WorkflowDefinition, WorkflowEdge, WorkflowNode } from './types';

export interface CompiledDAG {
  definition: WorkflowDefinition;
  entryNodes: string[];
  terminalNodes: string[];
  joinNodes: Set<string>;
  dependencies: Map<string, Set<string>>; // node -> set of upstream parent nodes
  dependents: Map<string, Set<string>>; // node -> set of downstream child nodes
  topologicalOrder: string[];
  reverseTopologicalOrder: string[];
  nodeMap: Map<string, WorkflowNode>;
  edgeMap: Map<string, WorkflowEdge>;
}

export class DAGCompilationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DAGCompilationError';
  }
}

export class DAGCompiler {
  static compile(definition: WorkflowDefinition): CompiledDAG {
    if (!definition || !Array.isArray(definition.nodes) || definition.nodes.length === 0) {
      throw new DAGCompilationError('Workflow definition must contain at least one node');
    }

    const nodeMap = new Map<string, WorkflowNode>();
    for (const node of definition.nodes) {
      if (nodeMap.has(node.id)) {
        throw new DAGCompilationError(`Duplicate node ID detected: ${node.id}`);
      }
      nodeMap.set(node.id, node);
    }

    const edgeMap = new Map<string, WorkflowEdge>();
    const dependencies = new Map<string, Set<string>>();
    const dependents = new Map<string, Set<string>>();

    for (const node of definition.nodes) {
      dependencies.set(node.id, new Set<string>());
      dependents.set(node.id, new Set<string>());
    }

    const edges = definition.edges || [];
    for (const edge of edges) {
      if (!nodeMap.has(edge.source)) {
        throw new DAGCompilationError(`Edge source '${edge.source}' does not exist in graph nodes`);
      }
      if (!nodeMap.has(edge.target)) {
        throw new DAGCompilationError(`Edge target '${edge.target}' does not exist in graph nodes`);
      }
      if (edge.source === edge.target) {
        throw new DAGCompilationError(`Self-loop detected on node: ${edge.source}`);
      }

      edgeMap.set(edge.id, edge);
      dependencies.get(edge.target)!.add(edge.source);
      dependents.get(edge.source)!.add(edge.target);
    }

    // Identify entry nodes, terminal nodes, and join nodes
    const entryNodes: string[] = [];
    const terminalNodes: string[] = [];
    const joinNodes = new Set<string>();

    for (const [nodeId, parents] of dependencies.entries()) {
      if (parents.size === 0) {
        entryNodes.push(nodeId);
      } else if (parents.size > 1) {
        // Multi-parent join barrier
        joinNodes.add(nodeId);
      }
    }

    for (const [nodeId, children] of dependents.entries()) {
      if (children.size === 0) {
        terminalNodes.push(nodeId);
      }
    }

    if (entryNodes.length === 0) {
      throw new DAGCompilationError('Workflow has no entry nodes (possible cyclic graph)');
    }

    // Topological sort via Kahn's Algorithm
    const inDegree = new Map<string, number>();
    for (const [nodeId, parents] of dependencies.entries()) {
      inDegree.set(nodeId, parents.size);
    }

    const queue: string[] = [...entryNodes];
    const topologicalOrder: string[] = [];

    while (queue.length > 0) {
      const current = queue.shift()!;
      topologicalOrder.push(current);

      const children = dependents.get(current) || new Set<string>();
      for (const child of children) {
        const remaining = inDegree.get(child)! - 1;
        inDegree.set(child, remaining);
        if (remaining === 0) {
          queue.push(child);
        }
      }
    }

    if (topologicalOrder.length !== definition.nodes.length) {
      const unvisited = definition.nodes
        .map((n) => n.id)
        .filter((id) => !topologicalOrder.includes(id));
      throw new DAGCompilationError(
        `Cycle or unreachable component detected involving nodes: ${unvisited.join(', ')}`
      );
    }

    const reverseTopologicalOrder = [...topologicalOrder].reverse();

    return {
      definition,
      entryNodes,
      terminalNodes,
      joinNodes,
      dependencies,
      dependents,
      topologicalOrder,
      reverseTopologicalOrder,
      nodeMap,
      edgeMap,
    };
  }

  /**
   * Evaluates whether all upstream dependencies for a node have completed
   */
  static isNodeReady(
    nodeId: string,
    dependencies: Map<string, Set<string>>,
    completedNodes: Set<string>
  ): boolean {
    const parents = dependencies.get(nodeId);
    if (!parents || parents.size === 0) return true;
    for (const parentId of parents) {
      if (!completedNodes.has(parentId)) {
        return false;
      }
    }
    return true;
  }
}
