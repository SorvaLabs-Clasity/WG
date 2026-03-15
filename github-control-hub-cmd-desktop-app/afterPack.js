const { execSync } = require("child_process");
const path = require("path");

exports.default = async function (context) {
  if (context.electronPlatformName !== "darwin") return;

  const appPath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`
  );

  // Electron binaries come pre-signed. electron-builder modifies the app
  // (renames binary, changes Info.plist, etc.) which BREAKS the existing
  // signature. With identity=null, electron-builder skips re-signing,
  // leaving a broken signature that ShipIt rejects.
  //
  // Fix: re-sign everything with a valid ad-hoc signature.
  // Ad-hoc signing is free, needs no certificate, and ShipIt accepts it.
  console.log(`Re-signing app with ad-hoc signature: ${appPath}`);
  try {
    execSync(
      `codesign --force --deep --sign - "${appPath}"`,
      { stdio: "inherit" }
    );
    console.log("Ad-hoc signing completed successfully.");
  } catch (err) {
    console.warn("Warning: ad-hoc signing failed:", err.message);
  }
};
