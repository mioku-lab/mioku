import { botConfig } from "mioki";

export function getCommandPrefix(): string {
  return botConfig.prefix ?? "#";
}
