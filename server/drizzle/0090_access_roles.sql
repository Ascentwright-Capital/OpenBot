CREATE TABLE "access_role_bots" (
	"role_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"granted_by" text NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "access_role_bots_role_id_agent_id_pk" PRIMARY KEY("role_id","agent_id")
);
--> statement-breakpoint
CREATE TABLE "access_role_people" (
	"role_id" text NOT NULL,
	"user_id" text NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "access_role_people_role_id_user_id_pk" PRIMARY KEY("role_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "access_roles" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "access_role_bots" ADD CONSTRAINT "access_role_bots_role_id_access_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."access_roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_role_bots" ADD CONSTRAINT "access_role_bots_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_role_people" ADD CONSTRAINT "access_role_people_role_id_access_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."access_roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_role_people" ADD CONSTRAINT "access_role_people_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_roles" ADD CONSTRAINT "access_roles_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "access_role_bots_agent_idx" ON "access_role_bots" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "access_role_people_user_idx" ON "access_role_people" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "access_roles_name_key" ON "access_roles" USING btree (lower("name"));