CREATE UNIQUE INDEX IF NOT EXISTS "idx_event_log_exec_seq_unique" ON "event_log" USING btree ("workflow_execution_id","sequence_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_poison_pill_status" ON "poison_pill_queue" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_poison_pill_pending_unique" ON "poison_pill_queue" USING btree ("workflow_execution_id","node_id") WHERE "poison_pill_queue"."status" = 'PENDING';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_worker_leases_expires" ON "worker_leases" USING btree ("expires_at");