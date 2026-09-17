import { sagaCompensator } from './saga-compensator';
import type { WorkflowDefinition } from './types';

// Register standard compensation handlers
sagaCompensator.registerHandler('refund_payment', async (_node, _input, output) => {
  // Simulate refunding Stripe charge
  await new Promise((r) => setTimeout(r, 300));
  return { refunded: true, amount: output?.amount || 149.99, refundId: `rf_${Date.now()}` };
});

sagaCompensator.registerHandler('release_inventory', async (_node, _input, output) => {
  // Simulate releasing warehouse hold
  await new Promise((r) => setTimeout(r, 250));
  return { released: true, sku: output?.sku || 'SKU-7721' };
});

sagaCompensator.registerHandler('cancel_shipment', async (_node, _input, _output) => {
  // Simulate cancelling courier pickup
  await new Promise((r) => setTimeout(r, 200));
  return { shipmentCancelled: true };
});

sagaCompensator.registerHandler('delete_s3_batch', async (_node, _input, _output) => {
  await new Promise((r) => setTimeout(r, 300));
  return { s3BatchDeleted: true };
});

sagaCompensator.registerHandler(
  'poison_pill_failing_handler',
  async (_node, _input, _output, attempt) => {
    // Always throws an error to demonstrate max retry exhaustion & poison pill quarantine
    await new Promise((r) => setTimeout(r, 200));
    throw new Error(
      `External Gateway 502 Bad Gateway (Attempt ${attempt}): Permanent failure on downstream billing API`
    );
  }
);

export const PRESET_WORKFLOWS: WorkflowDefinition[] = [
  {
    id: 'ecommerce_order_saga',
    name: 'E-Commerce Order Saga (Parallel Branches & Rollback)',
    description:
      'Authenticates order, executes parallel inventory reservation, payment processing, and courier booking. Supports active sibling cancellation and reverse topological compensation.',
    version: 1,
    nodes: [
      {
        id: 'auth_order',
        name: 'Authenticate & Fraud Check',
        type: 'task',
        activityType: 'fraud_check',
        metadata: {
          icon: 'ShieldCheck',
          description: 'Validates customer token and calculates fraud score',
          simulatedLatencyMs: 350,
        },
      },
      {
        id: 'reserve_inventory',
        name: 'Reserve Warehouse Inventory',
        type: 'task',
        activityType: 'reserve_inventory',
        compensationType: 'release_inventory',
        retryPolicy: { maxRetries: 3, initialBackoffMs: 200, backoffMultiplier: 2 },
        metadata: {
          icon: 'Boxes',
          description: 'Holds items in fulfillment warehouse',
          simulatedLatencyMs: 600,
        },
      },
      {
        id: 'charge_payment',
        name: 'Process Credit Card Payment',
        type: 'task',
        activityType: 'charge_card',
        compensationType: 'refund_payment',
        retryPolicy: { maxRetries: 3, initialBackoffMs: 200, backoffMultiplier: 2 },
        metadata: {
          icon: 'CreditCard',
          description: 'Charges payment gateway through deterministic proxy',
          simulatedLatencyMs: 700,
        },
      },
      {
        id: 'book_shipping',
        name: 'Book Carrier Shipping',
        type: 'task',
        activityType: 'dispatch_courier',
        compensationType: 'cancel_shipment',
        retryPolicy: { maxRetries: 3, initialBackoffMs: 200, backoffMultiplier: 2 },
        metadata: {
          icon: 'Truck',
          description: 'Generates shipping label and carrier pickup slot',
          simulatedLatencyMs: 500,
        },
      },
      {
        id: 'sync_barrier',
        name: 'Synchronize Parallel Branches',
        type: 'join',
        activityType: 'sync_branches',
        metadata: {
          icon: 'GitMerge',
          description: 'Join node: waits for inventory, payment, and shipping to all succeed',
          simulatedLatencyMs: 200,
        },
      },
      {
        id: 'send_confirmation',
        name: 'Send Customer Confirmation',
        type: 'task',
        activityType: 'email_receipt',
        metadata: {
          icon: 'MailCheck',
          description: 'Dispatches invoice and tracking notifications to customer',
          simulatedLatencyMs: 300,
        },
      },
    ],
    edges: [
      { id: 'e1', source: 'auth_order', target: 'reserve_inventory' },
      { id: 'e2', source: 'auth_order', target: 'charge_payment' },
      { id: 'e3', source: 'auth_order', target: 'book_shipping' },
      { id: 'e4', source: 'reserve_inventory', target: 'sync_barrier' },
      { id: 'e5', source: 'charge_payment', target: 'sync_barrier' },
      { id: 'e6', source: 'book_shipping', target: 'sync_barrier' },
      { id: 'e7', source: 'sync_barrier', target: 'send_confirmation' },
    ],
  },
  {
    id: 'fencing_zombie_demo',
    name: 'Distributed Fencing & Zombie Worker Rejection',
    description:
      'Demonstrates split-brain write prevention. A simulated GC pause causes lease expiration and re-assignment with a higher fencing token; the delayed worker write is aborted.',
    version: 1,
    nodes: [
      {
        id: 'step_1_init',
        name: 'Initialize Cluster Session',
        type: 'task',
        activityType: 'init_session',
        metadata: {
          icon: 'Server',
          description: 'Sets up distributed context',
          simulatedLatencyMs: 300,
        },
      },
      {
        id: 'step_2_zombie_target',
        name: 'Critical Task (Zombie Target)',
        type: 'task',
        activityType: 'process_critical_state',
        timeoutMs: 2000,
        metadata: {
          icon: 'Cpu',
          description:
            'Acquires lease with fencing token. Can be delayed to trigger split-brain rejection.',
          simulatedLatencyMs: 500,
        },
      },
      {
        id: 'step_3_finalize',
        name: 'Commit Final State',
        type: 'task',
        activityType: 'finalize_state',
        metadata: {
          icon: 'CheckCircle2',
          description: 'Verified write to persistent storage',
          simulatedLatencyMs: 300,
        },
      },
    ],
    edges: [
      { id: 'ez1', source: 'step_1_init', target: 'step_2_zombie_target' },
      { id: 'ez2', source: 'step_2_zombie_target', target: 'step_3_finalize' },
    ],
  },
  {
    id: 'poison_pill_quarantine_demo',
    name: 'Poison Pill Quarantine & Manual Recovery',
    description:
      'Executes a pipeline where a downstream compensation activity fails continuously, exhausting retries and entering POISON_PILL_BLOCKED state for operator review.',
    version: 1,
    nodes: [
      {
        id: 'step_1_prepare',
        name: 'Prepare Migration Assets',
        type: 'task',
        activityType: 'prepare_assets',
        compensationType: 'poison_pill_failing_handler', // Fails on rollback
        retryPolicy: { maxRetries: 2, initialBackoffMs: 150, backoffMultiplier: 2 },
        metadata: {
          icon: 'Layers',
          description: 'Prepares data migration chunks (compensation will exhaust retries)',
          simulatedLatencyMs: 400,
        },
      },
      {
        id: 'step_2_execute',
        name: 'Inject Intentional Failure',
        type: 'task',
        activityType: 'fail_intentionally',
        metadata: {
          icon: 'Flame',
          description: 'Fails to trigger the rollback mechanism',
          simulatedLatencyMs: 300,
          failureProbability: 1.0, // 100% intentional failure
        },
      },
    ],
    edges: [{ id: 'ep1', source: 'step_1_prepare', target: 'step_2_execute' }],
  },
];
