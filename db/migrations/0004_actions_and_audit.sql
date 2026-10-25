CREATE TABLE `actions` (
	`id` text PRIMARY KEY NOT NULL,
	`player_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`kind` text NOT NULL,
	`fingerprint` text NOT NULL,
	`status` text NOT NULL,
	`response_json` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`player_id`) REFERENCES `players`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "actions_status_valid" CHECK("actions"."status" in ('RECEIVED', 'PARSING', 'VALIDATING', 'RESOLVING', 'COMMITTED', 'NARRATED', 'COMPLETED', 'FAILED')),
	CONSTRAINT "actions_kind_valid" CHECK("actions"."kind" in ('fixed', 'breakthrough')),
	CONSTRAINT "actions_response_json_valid" CHECK(json_valid("actions"."response_json")),
	CONSTRAINT "actions_key_length" CHECK(length("actions"."idempotency_key") between 8 and 64)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `actions_player_key_unique` ON `actions` (`player_id`,`idempotency_key`);--> statement-breakpoint
CREATE TABLE `audit_events` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`id` text NOT NULL,
	`actor_id` text NOT NULL,
	`action_id` text,
	`event_type` text NOT NULL,
	`before_json` text,
	`after_json` text,
	`log_json` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`actor_id`) REFERENCES `players`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`action_id`) REFERENCES `actions`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "audit_events_type_nonempty" CHECK(length("audit_events"."event_type") > 0),
	CONSTRAINT "audit_events_before_json_valid" CHECK("audit_events"."before_json" is null or json_valid("audit_events"."before_json")),
	CONSTRAINT "audit_events_after_json_valid" CHECK("audit_events"."after_json" is null or json_valid("audit_events"."after_json")),
	CONSTRAINT "audit_events_log_json_valid" CHECK("audit_events"."log_json" is null or json_valid("audit_events"."log_json"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `audit_events_id_unique` ON `audit_events` (`id`);--> statement-breakpoint
CREATE INDEX `audit_events_action_idx` ON `audit_events` (`action_id`);