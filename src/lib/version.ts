/**
 * The version of this program.
 *
 * build.sh bakes the contents of the VERSION file in, so the built program
 * and the release always agree.
 */
export const VERSION: string =
  typeof ORCA_BOX_VERSION === "string" ? ORCA_BOX_VERSION : "0.0.0-dev";
