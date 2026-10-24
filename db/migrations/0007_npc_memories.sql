CREATE TABLE `npc_memories` (
	`id` text PRIMARY KEY NOT NULL,
	`npc_id` text NOT NULL,
	`event_id` text,
	`memory_type` text NOT NULL,
	`summary` text NOT NULL,
	`importance` integer NOT NULL,
	`source_count` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`npc_id`) REFERENCES `npcs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`event_id`) REFERENCES `audit_events`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "npc_memories_type_valid" CHECK("npc_memories"."memory_type" in ('met', 'breakthrough_success', 'breakthrough_failure', 'summary')),
	CONSTRAINT "npc_memories_event_rule" CHECK(("npc_memories"."memory_type" = 'summary') = ("npc_memories"."event_id" is null)),
	CONSTRAINT "npc_memories_summary_len" CHECK(length("npc_memories"."summary") between 1 and 160),
	CONSTRAINT "npc_memories_importance_range" CHECK("npc_memories"."importance" between 1 and 10),
	CONSTRAINT "npc_memories_source_count" CHECK("npc_memories"."source_count" between 1 and 10000),
	CONSTRAINT "npc_memories_created_at" CHECK("npc_memories"."created_at" >= 0)
);
--> statement-breakpoint
CREATE INDEX `npc_memories_npc_idx` ON `npc_memories` (`npc_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `npc_memories_event_idx` ON `npc_memories` (`event_id`);