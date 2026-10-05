export type CompilationTiming = (phase: string, detail?: Record<string, unknown>) => void;

/** Opt-in phase durations shared by the Node seed and native compiler.
 * The disabled path does not read the clock or write compiler output. */
export function compilationTiming(): CompilationTiming {
  if (process.env["SCRIPTC_TIMING"] !== "1") return () => {};
  const start = performance.now();
  let previous = start;
  return (phase, detail = {}) => {
    const now = performance.now();
    process.stderr.write(
      `scriptc timing ${JSON.stringify({
        phase,
        phase_ms: Math.round((now - previous) * 10) / 10,
        total_ms: Math.round((now - start) * 10) / 10,
        ...detail,
      })}\n`,
    );
    previous = now;
  };
}
