const { execSync } = require("child_process");
const path = require("path");

exports.default = async function (context) {
  if (context.electronPlatformName !== "darwin") return;

  const appPath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`
  );

  const bundleId = context.packager.appInfo.id;

  // Ad-hoc sign with a custom designated requirement that only checks the
  // bundle identifier. Without this, each CI build generates a different
  // ad-hoc identity, and ShipIt rejects updates because the new build's
  // identity doesn't match the installed build's identity.
  // By requiring only the bundle ID, all builds with the same appId match.
  console.log(`Ad-hoc signing with permissive DR: ${appPath}`);
  try {
    execSync(
      `codesign --force --deep --sign - "${appPath}"`,
      { stdio: "inherit" }
    );
    execSync(
      `codesign --force --sign - -r='designated => identifier "${bundleId}"' "${appPath}"`,
      { stdio: "inherit" }
    );
    console.log("Ad-hoc signing completed successfully.");
  } catch (err) {
    console.warn("Warning: ad-hoc signing failed:", err.message);
  }
};
