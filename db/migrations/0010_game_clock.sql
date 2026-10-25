CREATE TABLE `game_clock` (
	`id` text PRIMARY KEY NOT NULL,
	`minutes` integer NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	CONSTRAINT "game_clock_single" CHECK("game_clock"."id" = 'main'),
	CONSTRAINT "game_clock_nonneg" CHECK("game_clock"."minutes" >= 0)
);
--> statement-breakpoint
INSERT INTO `game_clock` (`id`, `minutes`) VALUES ('main', 420);
--> statement-breakpoint
UPDATE `player_states` SET `breakthrough_available_at` = NULL WHERE `breakthrough_available_at` IS NOT NULL AND `breakthrough_available_at` <= CAST(strftime('%s', 'now') AS INTEGER) * 1000;
--> statement-breakpoint
UPDATE `player_states` SET `breakthrough_available_at` = 420 + MIN(1440, (`breakthrough_available_at` - CAST(strftime('%s', 'now') AS INTEGER) * 1000 + 59999) / 60000) WHERE `breakthrough_available_at` IS NOT NULL;
