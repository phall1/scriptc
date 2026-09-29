import { buildNative } from "./driver.js";
import { loadNativeToolchain } from "./toolchain.js";
import { NATIVE_HELP, parseNativeArguments } from "./arguments.js";

try {
  const args = parseNativeArguments(process.argv.slice(2), process.execPath + ".json");
  if (args.help) console.log(NATIVE_HELP);
  else {
    const result = buildNative(args.build, loadNativeToolchain(args.toolchainPath));
    console.log(JSON.stringify(result));
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
