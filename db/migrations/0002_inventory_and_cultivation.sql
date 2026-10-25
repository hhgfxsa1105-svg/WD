CREATE TABLE `cultivation_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`player_id` text NOT NULL,
	`method_id` text NOT NULL,
	`status` text NOT NULL,
	`started_at` integer NOT NULL,
	`last_settled_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`player_id`) REFERENCES `players`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "cultivation_jobs_status_valid" CHECK("cultivation_jobs"."status" in ('running', 'stopped')),
	CONSTRAINT "cultivation_jobs_time_order" CHECK("cultivation_jobs"."started_at" >= 0 and "cultivation_jobs"."last_settled_at" >= "cultivation_jobs"."started_at")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `cultivation_jobs_one_running` ON `cultivation_jobs` (`player_id`) WHERE "cultivation_jobs"."status" = 'running';--> statement-breakpoint
CREATE INDEX `cultivation_jobs_player_idx` ON `cultivation_jobs` (`player_id`);--> statement-breakpoint
CREATE TABLE `inventory` (
	`player_id` text NOT NULL,
	`item_id` text NOT NULL,
	`quantity` integer NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	PRIMARY KEY(`player_id`, `item_id`),
	FOREIGN KEY (`player_id`) REFERENCES `players`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "inventory_quantity_range" CHECK("inventory"."quantity" >= 0 and "inventory"."quantity" <= 9999)
);
