CREATE TABLE `quests` (
	`id` text PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`step_index` integer DEFAULT 0 NOT NULL,
	`accepted_at` integer,
	`finished_at` integer,
	`claimed_at` integer,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	CONSTRAINT "quests_id_format" CHECK("quests"."id" glob 'quest_*' and length("quests"."id") <= 64),
	CONSTRAINT "quests_status_valid" CHECK("quests"."status" in ('locked', 'available', 'active', 'completed', 'failed')),
	CONSTRAINT "quests_step_range" CHECK("quests"."step_index" between 0 and 50),
	CONSTRAINT "quests_accepted_rule" CHECK(("quests"."accepted_at" is null) = ("quests"."status" in ('locked', 'available'))),
	CONSTRAINT "quests_finished_rule" CHECK(("quests"."finished_at" is null) = ("quests"."status" not in ('completed', 'failed'))),
	CONSTRAINT "quests_claimed_rule" CHECK("quests"."claimed_at" is null or "quests"."status" = 'completed')
);
--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_actions` (
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
	CONSTRAINT "actions_status_valid" CHECK("__new_actions"."status" in ('RECEIVED', 'PARSING', 'VALIDATING', 'RESOLVING', 'COMMITTED', 'NARRATED', 'COMPLETED', 'FAILED')),
	CONSTRAINT "actions_kind_valid" CHECK("__new_actions"."kind" in ('fixed', 'breakthrough', 'move', 'quest')),
	CONSTRAINT "actions_response_json_valid" CHECK(json_valid("__new_actions"."response_json")),
	CONSTRAINT "actions_key_length" CHECK(length("__new_actions"."idempotency_key") between 8 and 64)
);
--> statement-breakpoint
INSERT INTO `__new_actions`("id", "player_id", "idempotency_key", "kind", "fingerprint", "status", "response_json", "created_at", "updated_at") SELECT "id", "player_id", "idempotency_key", "kind", "fingerprint", "status", "response_json", "created_at", "updated_at" FROM `actions`;--> statement-breakpoint
DROP TABLE `actions`;--> statement-breakpoint
ALTER TABLE `__new_actions` RENAME TO `actions`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `actions_player_key_unique` ON `actions` (`player_id`,`idempotency_key`);