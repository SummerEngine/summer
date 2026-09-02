/** True when a process with this pid exists. EPERM = alive but not ours;
 *  ESRCH = dead. Non-positive / non-integer pids are never alive. */
export function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
