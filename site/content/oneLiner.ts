import { INSTALL } from "./deck";

/** The one-liner's held runs (INSTALL.runs, checked against INSTALL.code at build): a line may wrap after `curl -fsSL`, before `install.sh` and before `| sh`, never inside the host. */
export const CMD = INSTALL.runs.cmd;
export const HOST = INSTALL.runs.host;
export const SCRIPT = INSTALL.runs.script;
export const TAIL = INSTALL.runs.tail;
