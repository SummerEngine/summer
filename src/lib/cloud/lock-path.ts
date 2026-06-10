import { join } from "path";
import { localCloudDir } from "./paths.js";

export function lockPath(projectRoot: string): string {
  return join(localCloudDir(projectRoot), "lock");
}
