import { workflowRepository } from '../db/repository';
import { orchestrator } from './orchestrator';

export class CrashRecoveryCoordinator {
  /**
   * Scans database on server startup to recover unfinalized workflows
   */
  static async recoverUnfinalizedWorkflows(): Promise<{
    recoveredCount: number;
    recoveredIds: string[];
  }> {
    const unfinalized = await workflowRepository.getUnfinalizedExecutions();
    const recoveredIds: string[] = [];

    console.log(
      `[Sequent Recovery] Scanning for unfinalized workflows... Found: ${unfinalized.length}`
    );

    for (const record of unfinalized) {
      try {
        console.log(
          `[Sequent Recovery] Replaying historical event_log for execution ${record.id} (Status: ${record.status})...`
        );
        const success = await orchestrator.recoverWorkflow(record.id);
        if (success) {
          recoveredIds.push(record.id);
        }
      } catch (err) {
        console.error(`[Sequent Recovery] Failed to recover workflow execution ${record.id}:`, err);
      }
    }

    return {
      recoveredCount: recoveredIds.length,
      recoveredIds,
    };
  }
}
