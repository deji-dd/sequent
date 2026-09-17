import { describe, expect, it } from 'bun:test';
import { DAGCompiler } from '../src/core/dag-compiler';
import type { WorkflowDefinition } from '../src/core/types';

describe('DAGCompiler', () => {
  it('should compile a linear DAG and compute correct topological order', () => {
    const def: WorkflowDefinition = {
      id: 'linear_test',
      name: 'Linear Test',
      version: 1,
      nodes: [
        { id: 'node_a', name: 'A', type: 'task', activityType: 'test' },
        { id: 'node_b', name: 'B', type: 'task', activityType: 'test' },
        { id: 'node_c', name: 'C', type: 'task', activityType: 'test' },
      ],
      edges: [
        { id: 'e1', source: 'node_a', target: 'node_b' },
        { id: 'e2', source: 'node_b', target: 'node_c' },
      ],
    };

    const compiled = DAGCompiler.compile(def);
    expect(compiled.topologicalOrder).toEqual(['node_a', 'node_b', 'node_c']);
    expect(compiled.reverseTopologicalOrder).toEqual(['node_c', 'node_b', 'node_a']);
    expect(compiled.entryNodes).toEqual(['node_a']);
    expect(compiled.terminalNodes).toEqual(['node_c']);
    expect(compiled.joinNodes.size).toBe(0);
  });

  it('should detect join synchronization nodes in parallel branching graphs', () => {
    const def: WorkflowDefinition = {
      id: 'branching_test',
      name: 'Branching Test',
      version: 1,
      nodes: [
        { id: 'start', name: 'Start', type: 'task', activityType: 'test' },
        { id: 'branch_1', name: 'B1', type: 'task', activityType: 'test' },
        { id: 'branch_2', name: 'B2', type: 'task', activityType: 'test' },
        { id: 'join_node', name: 'Join', type: 'join', activityType: 'test' },
      ],
      edges: [
        { id: 'e1', source: 'start', target: 'branch_1' },
        { id: 'e2', source: 'start', target: 'branch_2' },
        { id: 'e3', source: 'branch_1', target: 'join_node' },
        { id: 'e4', source: 'branch_2', target: 'join_node' },
      ],
    };

    const compiled = DAGCompiler.compile(def);
    expect(compiled.joinNodes.has('join_node')).toBe(true);

    // Test dependency satisfaction check
    const completed = new Set(['start', 'branch_1']);
    expect(DAGCompiler.isNodeReady('join_node', compiled.dependencies, completed)).toBe(false);

    completed.add('branch_2');
    expect(DAGCompiler.isNodeReady('join_node', compiled.dependencies, completed)).toBe(true);
  });

  it('should throw an error on cyclic graphs', () => {
    const cyclicDef: WorkflowDefinition = {
      id: 'cycle_test',
      name: 'Cycle Test',
      version: 1,
      nodes: [
        { id: 'node_1', name: '1', type: 'task', activityType: 'test' },
        { id: 'node_2', name: '2', type: 'task', activityType: 'test' },
      ],
      edges: [
        { id: 'e1', source: 'node_1', target: 'node_2' },
        { id: 'e2', source: 'node_2', target: 'node_1' },
      ],
    };

    expect(() => DAGCompiler.compile(cyclicDef)).toThrow();
  });
});
