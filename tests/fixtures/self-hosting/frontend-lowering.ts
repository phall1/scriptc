import { loadProgram, checkPreflight } from "../../../packages/compiler/src/frontend/program.js";
import { FrontendServices } from "../../../packages/compiler/src/frontend/services.js";
import { createNativeTs7Api } from "../../../packages/compiler/src/frontend/ts7/native-api.js";
import { lowerToIr } from "../../../packages/compiler/src/frontend/lowering/lowerer.js";

// Reach the complete production frontend through the native TS7 client.
// Keep the call and ordinary error paths in this entry so an audit cannot
// accidentally measure only parsing, type mapping, or an isolated helper.
const services = new FrontendServices((options) => createNativeTs7Api({ ...options, executable: process.argv[2]! }));
try {
  const load = loadProgram(process.argv[3]!, services);
  try {
    const diagnostics = checkPreflight(load);
    console.log(diagnostics.length);
    if (diagnostics.length === 0) {
      const result = lowerToIr(load.program, load.entry, load.moduleOrder, { dynamic: false, frontendServices: services });
      console.log(result.stats.statementsFailed, result.stats.statementsIsland);
    }
  } finally { load.dispose(); }
} finally { services.close(); }
