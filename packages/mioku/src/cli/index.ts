#!/usr/bin/env node

import mri from "mri";
import { version } from "../../package.json";
import { buildHelpInfo } from "./shared";
import { installCommand } from "./install";
import { updateCommand } from "./update";
import { scaffoldCommand } from "./scaffold";

interface CliOptions {
  help?: boolean;
  version?: boolean;
}

const args = process.argv.slice(2);

(async () => {
  const cli = mri<CliOptions>(args, { alias: { v: "version", h: "help" } });
  const helpInfo = buildHelpInfo(version);
  const [cmd, ...cmdArgs] = args;

  switch (cmd) {
    case "install":
      process.exitCode = await installCommand(cmdArgs, helpInfo);
      return;
    case "update":
      process.exitCode = await updateCommand(cmdArgs);
      return;
    default:
      if (cli.version) {
        console.log(`v${version}`);
        return;
      }
      if (cli.help) {
        console.log(helpInfo);
        return;
      }
      process.exitCode = await scaffoldCommand();
      return;
  }
})();
