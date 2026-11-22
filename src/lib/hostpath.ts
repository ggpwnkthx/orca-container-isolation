/**
 * Where a folder on the host is seen inside the box.
 *
 * On Linux and macOS the container sees the host's paths unchanged: the
 * worktree is mounted at the same place inside the box as it is on the
 * host, so an agent that prints its working directory prints something
 * the user recognises.
 *
 * Windows is different: a Linux container cannot have a folder called
 * `C:\Users\me\project` in it. So the drive is turned into a folder:
 *
 *   C:\Users\me\project   ->   /c/Users/me/project
 *
 * The shape of the path is kept, only the drive letter moves, so the
 * paths still read like the ones on the host.
 */

import { isWindows } from "./platform.ts";

/**
 * The path a host folder is mounted at inside the box.
 *
 * The same path on Linux and macOS; the drive turned into a folder on
 * Windows.
 */
export function containerPath(hostPath: string): string {
  if (!isWindows()) return hostPath;
  if (!hostPath) return hostPath;

  // A drive: C:\Users\me -> /c/Users/me
  const drive = /^([A-Za-z]):[\\/](.*)$/.exec(hostPath);
  if (drive) {
    const letter = (drive[1] ?? "c").toLowerCase();
    const rest = (drive[2] ?? "").split("\\").join("/");
    return rest ? `/${letter}/${rest}` : `/${letter}`;
  }

  // A UNC path: \\server\share\folder -> /host/server/share/folder
  const unc = /^\\\\([^\\]+)\\([^\\]+)(.*)$/.exec(hostPath);
  if (unc) {
    const server = unc[1] ?? "";
    const share = unc[2] ?? "";
    const rest = (unc[3] ?? "").split("\\").join("/");
    return `/host/${server}/${share}${rest}`;
  }

  // Anything else (a relative path, say): leave it alone.
  return hostPath.split("\\").join("/");
}

/**
 * The path on the host for a folder the box is using.
 *
 * The other way round; needed when a path that came from the box has to
 * be looked up on the host.
 */
export function hostPath(containerPathOnBox: string): string {
  if (!isWindows()) return containerPathOnBox;
  const drive = /^\/([A-Za-z])\/(.*)$/.exec(containerPathOnBox);
  if (drive) {
    const letter = (drive[1] ?? "c").toUpperCase();
    const rest = (drive[2] ?? "").split("/").join("\\");
    return `${letter}:\\${rest}`;
  }
  const unc = /^\/host\/([^/]+)\/([^/]+)(.*)$/.exec(containerPathOnBox);
  if (unc) {
    const server = unc[1] ?? "";
    const share = unc[2] ?? "";
    const rest = (unc[3] ?? "").split("/").join("\\");
    return `\\\\${server}\\${share}${rest}`;
  }
  return containerPathOnBox;
}

/**
 * The path a folder is mounted at, as the engine's -v argument.
 *
 * The source is a host path and the destination is the container path.
 */
export function mountPair(hostPathOnHost: string): string {
  return `${hostPathOnHost}:${containerPath(hostPathOnHost)}`;
}
