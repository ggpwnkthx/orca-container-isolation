/**
 * A stand-in for the macOS installer.
 *
 * The real installer is macOS-only, so this runs it with the platform
 * faked and the disk image's tools stood in for. It is called by the
 * test suite; see tests/macos.test.ts.
 */

Object.defineProperty(process, "platform", {
  value: "darwin",
  configurable: true,
});

const { installMacApp } = await import("../../src/lib/macapp.ts");

const image = process.argv[2] ?? "";
if (!image) {
  process.stderr.write("usage: mac-install.ts <disk image>\n");
  process.exit(2);
}
await installMacApp(image);
