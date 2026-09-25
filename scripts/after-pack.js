const fs = require("fs");
const path = require("path");

exports.default = async function afterPack(context) {
  const localesDir = path.join(context.appOutDir, "locales");
  if (fs.existsSync(localesDir)) {
    const keep = new Set(["en-US.pak", "zh-CN.pak"]);
    for (const file of fs.readdirSync(localesDir)) {
      if (!keep.has(file)) {
        fs.rmSync(path.join(localesDir, file), { force: true });
      }
    }
  }

  if (context.electronPlatformName === "win32") {
    const { rcedit } = await import("rcedit");
    const appInfo = context.packager.appInfo;
    const executable = path.join(context.appOutDir, `${context.packager.config.win?.executableName || appInfo.productFilename}.exe`);
    await rcedit(executable, {
      "file-version": appInfo.version,
      "product-version": appInfo.version,
      "version-string": {
        ProductName: appInfo.productName,
        FileDescription: "AI_bar - Local AI Agent quota and token dashboard",
        CompanyName: "w1ndwill",
        LegalCopyright: `Copyright © ${new Date().getFullYear()} w1ndwill`,
        OriginalFilename: `${appInfo.productFilename}.exe`,
        InternalName: appInfo.productFilename
      }
    });
  }
};
