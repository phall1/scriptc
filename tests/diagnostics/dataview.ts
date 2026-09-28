// Stored ArrayBuffers and DataViews lower; Float16 accessors remain unsupported.
const buffer = new ArrayBuffer(16);
const view = new DataView(buffer);
view.setFloat16(0, 1.5);
console.log(view.getFloat16(0));
// End of the diagnostic fixture.
