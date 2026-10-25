CREATE TABLE `faction_history` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`id` text NOT NULL,
	`event_id` text NOT NULL,
	`game_minutes` integer NOT NULL,
	`text` text NOT NULL,
	`changes_json` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `world_events`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "faction_history_text_len" CHECK(length("faction_history"."text") between 1 and 400),
	CONSTRAINT "faction_history_time_nonneg" CHECK("faction_history"."game_minutes" >= 0),
	CONSTRAINT "faction_history_changes_json" CHECK(json_valid("faction_history"."changes_json") and json_type("faction_history"."changes_json") = 'array')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `faction_history_id_unique` ON `faction_history` (`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `faction_history_event_unique` ON `faction_history` (`event_id`);--> statement-breakpoint
CREATE TABLE `faction_relations` (
	`a` text NOT NULL,
	`b` text NOT NULL,
	`value` integer NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	PRIMARY KEY(`a`, `b`),
	FOREIGN KEY (`a`) REFERENCES `factions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`b`) REFERENCES `factions`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "faction_relations_order" CHECK("faction_relations"."a" < "faction_relations"."b"),
	CONSTRAINT "faction_relations_range" CHECK("faction_relations"."value" between -100 and 100)
);
--> statement-breakpoint
CREATE TABLE `factions` (
	`id` text PRIMARY KEY NOT NULL,
	`strength` integer NOT NULL,
	`attitude` integer NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	CONSTRAINT "factions_id_format" CHECK("factions"."id" glob 'fac_*' and length("factions"."id") <= 40),
	CONSTRAINT "factions_strength_range" CHECK("factions"."strength" between 0 and 100),
	CONSTRAINT "factions_attitude_range" CHECK("factions"."attitude" between -100 and 100)
);
