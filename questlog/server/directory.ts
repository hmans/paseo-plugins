import { existsSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function taskDirectory(env: NodeJS.ProcessEnv = process.env) {
  // Keep custom data locations working across the rename.
  const override = env.PASEO_QUESTLOG_DATA_DIR ?? env.PASEO_FLOWTASKS_DATA_DIR;
  if (override !== undefined) return override;
  const home = env.PASEO_HOME ?? join(homedir(), ".paseo");
  const directory = join(home, "questlog");
  const legacy = join(home, "flowtasks");
  if (existsSync(legacy)) {
    if (existsSync(directory)) throw new Error("Both Questlog and legacy task data exist. Set PASEO_QUESTLOG_DATA_DIR to select the data to use.");
    // Run after removing the old plugin; preserve outlines, revisions and bindings.
    renameSync(legacy, directory);
  }
  return directory;
}
