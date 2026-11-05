ALTER TABLE `attempts` ADD `camera_consent_at` integer;--> statement-breakpoint
ALTER TABLE `attempts` ADD `camera_recordings` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `attempts` ADD `proctoring` text DEFAULT '[]' NOT NULL;