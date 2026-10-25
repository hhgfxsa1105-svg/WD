CREATE TABLE `locations` (
	`id` text PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`reason` text,
	`visited` integer DEFAULT 0 NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	CONSTRAINT "locations_id_format" CHECK("locations"."id" glob 'loc_*' and length("locations"."id") <= 64),
	CONSTRAINT "locations_status_valid" CHECK("locations"."status" in ('open', 'blocked')),
	CONSTRAINT "locations_reason_rule" CHECK(("locations"."status" = 'blocked') = ("locations"."reason" is not null)),
	CONSTRAINT "locations_reason_len" CHECK("locations"."reason" is null or length("locations"."reason") between 1 and 60),
	CONSTRAINT "locations_visited_flag" CHECK("locations"."visited" in (0, 1))
);
