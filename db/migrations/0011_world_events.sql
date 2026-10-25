CREATE TABLE `news` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`id` text NOT NULL,
	`event_id` text NOT NULL,
	`kind` text NOT NULL,
	`text` text NOT NULL,
	`game_minutes` integer NOT NULL,
	`participated` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `world_events`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "news_kind_valid" CHECK("news"."kind" in ('rumor', 'news')),
	CONSTRAINT "news_text_len" CHECK(length("news"."text") between 1 and 400),
	CONSTRAINT "news_time_nonneg" CHECK("news"."game_minutes" >= 0),
	CONSTRAINT "news_participated_flag" CHECK("news"."participated" in (0, 1))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `news_id_unique` ON `news` (`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `news_event_kind_unique` ON `news` (`event_id`,`kind`);--> statement-breakpoint
CREATE TABLE `world_events` (
	`id` text PRIMARY KEY NOT NULL,
	`state` text NOT NULL,
	`rumored` integer DEFAULT 0 NOT NULL,
	`participated` integer DEFAULT 0 NOT NULL,
	`resolved_at` integer,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	CONSTRAINT "world_events_id_format" CHECK("world_events"."id" glob 'evt_*' and length("world_events"."id") <= 48),
	CONSTRAINT "world_events_state_valid" CHECK("world_events"."state" in ('scheduled', 'open', 'resolved', 'missed')),
	CONSTRAINT "world_events_flags" CHECK("world_events"."rumored" in (0, 1) and "world_events"."participated" in (0, 1)),
	CONSTRAINT "world_events_resolved_time" CHECK(("world_events"."state" in ('resolved', 'missed')) = ("world_events"."resolved_at" is not null)),
	CONSTRAINT "world_events_resolved_time_nonneg" CHECK("world_events"."resolved_at" is null or "world_events"."resolved_at" >= 0),
	CONSTRAINT "world_events_participated_resolved" CHECK("world_events"."participated" = 0 or "world_events"."state" = 'resolved')
);
