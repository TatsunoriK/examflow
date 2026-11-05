CREATE TABLE `exams` (
	`id` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`code` text NOT NULL,
	`body` text NOT NULL,
	`created` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `exams_code_unique` ON `exams` (`code`);--> statement-breakpoint
CREATE TABLE `attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`exam` text NOT NULL,
	`student` text NOT NULL,
	`name` text NOT NULL,
	`started` integer NOT NULL,
	`submitted` integer,
	`answers` text DEFAULT '{}' NOT NULL,
	`events` text DEFAULT '[]' NOT NULL,
	`recordings` text DEFAULT '[]' NOT NULL,
	`score` integer
);
