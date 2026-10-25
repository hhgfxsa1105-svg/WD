CREATE TABLE `ai_call_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`action_id` text,
	`purpose` text NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`day` text NOT NULL,
	`status` text NOT NULL,
	`error_kind` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`latency_ms` integer,
	`prompt_tokens` integer,
	`completion_tokens` integer,
	`total_tokens` integer,
	`request_chars` integer NOT NULL,
	`response_chars` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`action_id`) REFERENCES `actions`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "ai_call_logs_purpose_valid" CHECK("ai_call_logs"."purpose" in ('parse', 'narrate')),
	CONSTRAINT "ai_call_logs_status_valid" CHECK("ai_call_logs"."status" in ('pending', 'ok', 'error')),
	CONSTRAINT "ai_call_logs_day_format" CHECK("ai_call_logs"."day" glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
	CONSTRAINT "ai_call_logs_attempts_nonneg" CHECK("ai_call_logs"."attempts" >= 0),
	CONSTRAINT "ai_call_logs_nonneg" CHECK("ai_call_logs"."request_chars" >= 0 and ("ai_call_logs"."response_chars" is null or "ai_call_logs"."response_chars" >= 0) and ("ai_call_logs"."latency_ms" is null or "ai_call_logs"."latency_ms" >= 0))
);
--> statement-breakpoint
CREATE INDEX `ai_call_logs_day_idx` ON `ai_call_logs` (`day`);