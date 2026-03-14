#!/usr/bin/env node
import "dotenv/config";
import { Command } from "commander";
import { bootstrap } from "./config/env";
import { registerSetupCommands } from "./commands/setup";
import { registerServeCommands } from "./commands/serve";
import { registerRepoCommands } from "./commands/repo";
import { registerTemplateCommands } from "./commands/template";
import { registerActivityCommands } from "./commands/activity";
import { registerComplianceCommands } from "./commands/compliance";
import { registerQueryCommands } from "./commands/query";
import { registerWidgetCommands } from "./commands/widget";
import { registerExclusionCommands } from "./commands/exclusion";
import { registerGraphCommands } from "./commands/graph";
import { registerDependabotCommands } from "./commands/dependabot";

const program = new Command();

program
  .name("ghch")
  .description("GitHub Control Hub — CLI")
  .version("1.0.0")
  .hook("preAction", async () => {
    await bootstrap();
  });

registerSetupCommands(program);
registerServeCommands(program);
registerRepoCommands(program);
registerTemplateCommands(program);
registerActivityCommands(program);
registerComplianceCommands(program);
registerQueryCommands(program);
registerWidgetCommands(program);
registerExclusionCommands(program);
registerGraphCommands(program);
registerDependabotCommands(program);

program.parse(process.argv);
