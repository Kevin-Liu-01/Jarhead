/**
 * `@jarhead/cli/install`: the one-Jarhead install library. Imported by
 * scripts/build-mac.ts on its own so a build script does not drag the brain, the
 * hands and the daemon in through `@jarhead/cli`.
 */
export { parsePlistXml, serializePlistXml, PlistSyntaxError, dictGet, dictSet, dictOnly, stringAt, integerAt, str, int, dict, array } from "./plist.ts";
export type { PlistNode } from "./plist.ts";
export { DOCK_DOMAIN, JARHEAD_BUNDLE_ID, INSTALLED_APP, INSTALLED_URL, DEFAULT_FILE_TYPE, PIN_KEYS, findJarheadTiles, isJarheadTile, auditDock, modCountOf, describeDock, describeDockChanges } from "./dock.ts";
export type { DockTile, DockChange, DockAudit, DockList, DockOptions } from "./dock.ts";
export { LSREGISTER, parseLsBundleDump, staleJarheadRecords, jarheadRecords, describeLaunchServices, defaultRealpath } from "./launchservices.ts";
export type { LsRecord, StaleRule } from "./launchservices.ts";
export { probeTarget, planInstall, RSYNC, rsyncArgs, snapshotArgs, snapshotNameOk, parseItemized, compareTrees, parityOk, CODESIGN, CODESIGN_VERIFY_ARGS, CODESIGN_REQUIREMENT_ARGS, requirementHasIdentifier, installLine, rollbackLine, performInstall } from "./bundle.ts";
export type { TargetProbe, InstallPlan, RsyncSummary, ParityReport, InstallSpec, InstallIO, InstallOutcome } from "./bundle.ts";
export { runHygiene, hygieneLine, readDock, repairDock, restartDock, installedUrlOf, defaultExec, defaultStaleRoots, lsregisterRefreshArgs, LSREGISTER_TIMEOUT_MS } from "./hygiene.ts";
export type { Exec, ExecResult, HygieneMode, HygieneOptions, HygieneReport, DockOnlyOptions } from "./hygiene.ts";
