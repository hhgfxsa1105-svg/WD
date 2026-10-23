CREATE TABLE `npc_relationships` (
	`npc_id` text NOT NULL,
	`target_type` text NOT NULL,
	`target_id` text NOT NULL,
	`affinity` integer NOT NULL,
	`trust` integer NOT NULL,
	`hostility` integer NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	PRIMARY KEY(`npc_id`, `target_type`, `target_id`),
	FOREIGN KEY (`npc_id`) REFERENCES `npcs`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "npc_relationships_target_type" CHECK("npc_relationships"."target_type" in ('player', 'npc')),
	CONSTRAINT "npc_relationships_no_self" CHECK(not ("npc_relationships"."target_type" = 'npc' and "npc_relationships"."target_id" = "npc_relationships"."npc_id")),
	CONSTRAINT "npc_relationships_affinity_range" CHECK("npc_relationships"."affinity" between -100 and 100),
	CONSTRAINT "npc_relationships_trust_range" CHECK("npc_relationships"."trust" between 0 and 100),
	CONSTRAINT "npc_relationships_hostility_range" CHECK("npc_relationships"."hostility" between 0 and 100)
);
--> statement-breakpoint
CREATE INDEX `npc_relationships_target_idx` ON `npc_relationships` (`target_type`,`target_id`);--> statement-breakpoint
CREATE TABLE `npcs` (
	`id` text PRIMARY KEY NOT NULL,
	`location_id` text NOT NULL,
	`status` text NOT NULL,
	`goals_json` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	CONSTRAINT "npcs_id_format" CHECK("npcs"."id" glob 'npc_*' and length("npcs"."id") <= 64),
	CONSTRAINT "npcs_location_format" CHECK("npcs"."location_id" glob 'loc_*' and length("npcs"."location_id") <= 64),
	CONSTRAINT "npcs_status_valid" CHECK("npcs"."status" in ('active', 'away', 'resting')),
	CONSTRAINT "npcs_goals_json_valid" CHECK(json_valid("npcs"."goals_json") and json_type("npcs"."goals_json") = 'array')
);
--> statement-breakpoint
CREATE INDEX `npcs_location_idx` ON `npcs` (`location_id`);