/**
 * The release of Orca we install.
 *
 * The app is published on GitHub; each release carries the files for every
 * platform and, for most of them, a checksum.
 */

export interface ReleaseInfo {
  version: string;
  url: string;
  sha256: string;
  ymlUrl: string;
}

export interface ReleaseAsset {
  name?: string;
  browser_download_url?: string;
  digest?: string;
}

/**
 * Look up the app in a release.
 *
 * Returns the tag, the app's URL, its SHA-256 (if the release publishes
 * one) and the URL of the release's checksum file (if any).
 */
export async function releaseInfo(
  release: { tag_name?: string; assets?: ReleaseAsset[] },
  names: { asset: string; yml: string },
): Promise<ReleaseInfo> {
  const { asset, yml } = names;
  const assets = new Map(
    (release.assets ?? []).map((a) => [a.name ?? "", a] as const),
  );
  const app = assets.get(asset);
  const ymlAsset = assets.get(yml);
  const digest = app?.digest ?? "";
  return {
    version: release.tag_name ?? "",
    url: app?.browser_download_url ?? "",
    sha256: digest.startsWith("sha256:") ? digest.slice("sha256:".length) : "",
    ymlUrl: ymlAsset?.browser_download_url ?? "",
  };
}
