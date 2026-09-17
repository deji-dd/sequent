CREATE TABLE "event_log" (
	"id" text PRIMARY KEY NOT NULL,
	"workflow_execution_id" text NOT NULL,
	"sequence_id" integer NOT NULL,
	"node_id" text,
	"event_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"metadata" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "poison_pill_queue" (
	"id" text PRIMARY KEY NOT NULL,
	"workflow_execution_id" text NOT NULL,
	"node_id" text NOT NULL,
	"activity_type" text NOT NULL,
	"compensation_type" text NOT NULL,
	"attempts" integer NOT NULL,
	"last_error" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"blocked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "worker_leases" (
	"id" text PRIMARY KEY NOT NULL,
	"workflow_execution_id" text NOT NULL,
	"node_id" text NOT NULL,
	"worker_id" text NOT NULL,
	"fencing_token" integer NOT NULL,
	"ttl_ms" integer NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"acquired_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow_definitions" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"version" integer DEFAULT 1 NOT NULL,
	"definition" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow_executions" (
	"id" text PRIMARY KEY NOT NULL,
	"workflow_definition_id" text NOT NULL,
	"status" text NOT NULL,
	"current_sequence_id" integer DEFAULT 0 NOT NULL,
	"active_fencing_token" integer DEFAULT 0 NOT NULL,
	"input_payload" jsonb NOT NULL,
	"output_payload" jsonb,
	"context_state" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"node_states" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"chaos_config" jsonb,
	"error" text,
	"started_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
