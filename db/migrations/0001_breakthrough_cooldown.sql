-- 手工修正：旧表没有 breakthrough_available_at 列，已有存档迁移时该列填 NULL（drizzle-kit 默认生成会读取不存在的列）
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_player_states` (
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
	`breakthrough_available_at` integer,
	`version` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`player_id`) REFERENCES `players`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "player_states_realm_valid" CHECK("__new_player_states"."realm" in ('body_tempering', 'opening', 'houtian', 'xiantian', 'grandmaster', 'mingshen', 'land_immortal')),
	CONSTRAINT "player_states_progress_range" CHECK("__new_player_states"."realm_progress" between 0 and 100),
	CONSTRAINT "player_states_hp_range" CHECK("__new_player_states"."hp" >= 0 and "__new_player_states"."max_hp" >= 1 and "__new_player_states"."hp" <= "__new_player_states"."max_hp"),
	CONSTRAINT "player_states_stamina_range" CHECK("__new_player_states"."stamina" >= 0 and "__new_player_states"."max_stamina" >= 1 and "__new_player_states"."stamina" <= "__new_player_states"."max_stamina"),
	CONSTRAINT "player_states_neili_consistent" CHECK(("__new_player_states"."neili_current" is null and "__new_player_states"."neili_max" is null) or ("__new_player_states"."neili_current" is not null and "__new_player_states"."neili_max" is not null and "__new_player_states"."neili_current" >= 0 and "__new_player_states"."neili_max" >= 1 and "__new_player_states"."neili_current" <= "__new_player_states"."neili_max")),
	CONSTRAINT "player_states_currency_nonneg" CHECK("__new_player_states"."yuanbao" >= 0 and "__new_player_states"."silver" >= 0 and "__new_player_states"."copper" >= 0),
	CONSTRAINT "player_states_version_nonneg" CHECK("__new_player_states"."version" >= 0),
	CONSTRAINT "player_states_cooldown_nonneg" CHECK("__new_player_states"."breakthrough_available_at" is null or "__new_player_states"."breakthrough_available_at" >= 0)
);
--> statement-breakpoint
INSERT INTO `__new_player_states`("player_id", "realm", "realm_progress", "hp", "max_hp", "stamina", "max_stamina", "neili_current", "neili_max", "yuanbao", "silver", "copper", "attributes_json", "title_json", "epithet_json", "fate_json", "location_id", "location_name", "breakthrough_available_at", "version", "created_at", "updated_at") SELECT "player_id", "realm", "realm_progress", "hp", "max_hp", "stamina", "max_stamina", "neili_current", "neili_max", "yuanbao", "silver", "copper", "attributes_json", "title_json", "epithet_json", "fate_json", "location_id", "location_name", NULL, "version", "created_at", "updated_at" FROM `player_states`;--> statement-breakpoint
DROP TABLE `player_states`;--> statement-breakpoint
ALTER TABLE `__new_player_states` RENAME TO `player_states`;--> statement-breakpoint
PRAGMA foreign_keys=ON;