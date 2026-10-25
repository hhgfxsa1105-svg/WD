CREATE TABLE `player_states` (
	`player_id` text PRIMARY KEY NOT NULL,
	`realm` text NOT NULL,
	`realm_progress` integer NOT NULL,
	`hp` integer NOT NULL,
	`max_hp` integer NOT NULL,
	`stamina` integer NOT NULL,
	`max_stamina` integer NOT NULL,
	`neili_current` integer,
	`neili_max` integer,
	`yuanbao` integer NOT NULL,
	`silver` integer NOT NULL,
	`copper` integer NOT NULL,
	`attributes_json` text NOT NULL,
	`title_json` text,
	`epithet_json` text,
	`fate_json` text,
	`location_id` text NOT NULL,
	`location_name` text NOT NULL,
	`version` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`player_id`) REFERENCES `players`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "player_states_realm_valid" CHECK("player_states"."realm" in ('body_tempering', 'opening', 'houtian', 'xiantian', 'grandmaster', 'mingshen', 'land_immortal')),
	CONSTRAINT "player_states_progress_range" CHECK("player_states"."realm_progress" between 0 and 100),
	CONSTRAINT "player_states_hp_range" CHECK("player_states"."hp" >= 0 and "player_states"."max_hp" >= 1 and "player_states"."hp" <= "player_states"."max_hp"),
	CONSTRAINT "player_states_stamina_range" CHECK("player_states"."stamina" >= 0 and "player_states"."max_stamina" >= 1 and "player_states"."stamina" <= "player_states"."max_stamina"),
	CONSTRAINT "player_states_neili_consistent" CHECK(("player_states"."neili_current" is null and "player_states"."neili_max" is null) or ("player_states"."neili_current" is not null and "player_states"."neili_max" is not null and "player_states"."neili_current" >= 0 and "player_states"."neili_max" >= 1 and "player_states"."neili_current" <= "player_states"."neili_max")),
	CONSTRAINT "player_states_currency_nonneg" CHECK("player_states"."yuanbao" >= 0 and "player_states"."silver" >= 0 and "player_states"."copper" >= 0),
	CONSTRAINT "player_states_version_nonneg" CHECK("player_states"."version" >= 0)
);
--> statement-breakpoint
CREATE TABLE `players` (
	`id` text PRIMARY KEY NOT NULL,
	`display_name` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL
);
