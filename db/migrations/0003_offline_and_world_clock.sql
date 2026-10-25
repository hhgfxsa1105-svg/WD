CREATE TABLE `world_clock` (
	`id` text PRIMARY KEY NOT NULL,
	`high_water_at` integer NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	CONSTRAINT "world_clock_nonneg" CHECK("world_clock"."high_water_at" >= 0)
);
--> statement-breakpoint
ALTER TABLE `cultivation_jobs` ADD `last_checked_at` integer;