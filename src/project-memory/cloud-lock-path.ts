import { join } from "path";
import { localCloudDir } from "./cloud-paths.js";

export function lockPath(projectRoot: string): string {
  return join(localCloudDir(projectRoot), "lock");
}
