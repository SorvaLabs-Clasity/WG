const { execSync } = require("child_process");
const path = require("path");

exports.default = async function (context) {
  if (context.electronPlatformName !== "darwin") return;

  const appPath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`
  );

  console.log(`Stripping broken code signatures from: ${appPath}`);
  try {
    // Remove all _CodeSignature directories (the signature metadata)
    execSync(
      `find "${appPath}" -name "_CodeSignature" -type d -exec rm -rf {} + 2>/dev/null || true`,
      { stdio: "inherit" }
    );
    // Remove any CodeResources files
    execSync(
      `find "${appPath}" -name "CodeResources" -type f -delete 2>/dev/null || true`,
      { stdio: "inherit" }
    );
    console.log("Code signatures stripped successfully.");
  } catch (err) {
    console.warn("Warning: failed to strip signatures:", err.message);
  }
};
