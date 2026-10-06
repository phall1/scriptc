import * as ts from "../../ts7/adapter.js";
import { type Lowerer } from "../lowerer.js";
import { F64, type IrExpr, type IrType, STRING, type SrcLoc } from "../../../ir/ir.js";

/** `os.userInfo()` — the passwd-entry snapshot, Node's uv_os_get_passwd
 * behind the call site's own mapped record shape: username = pw_name,
 * uid/gid = getuid/getgid, shell = pw_shell (as the `string | null`
 * union @types/node declares — POSIX always answers the string arm;
 * null is Node's Windows answer), homedir = pw_dir (the PASSWD home,
 * NOT os.homedir's $HOME-first cascade — Node's own split). The record
 * assembles field-by-field from scalar libCalls in the shape's
 * declaration order; unknown fields and the options argument fence. */
export function lowerOsUserInfoCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  loc: SrcLoc,
): IrExpr {
  if (call.arguments.length !== 0) {
    lowerer.noLowering(
      "userInfo with options",
      call,
      "the zero-argument call is the lowered form (Node's buffer encoding option has no lowering)",
    );
  }
  const fence: () => never = () =>
    lowerer.noLowering(
      "userInfo() where the result is not the UserInfo record",
      call,
      "{ username, uid, gid, shell, homedir } is the supported result shape",
    );
  const result = lowerer.mapTypeOf(lowerer.typeOf(call));
  if (result?.kind !== "record") fence();
  const shape = lowerer.shapes.get(result.shapeId);
  if (!shape || shape.tuple || shape.indexValue || shape.fields.length === 0) fence();
  const fields: { name: string; value: IrExpr }[] = [];
  for (const f of shape.fields) {
    if (f.name === "username" && f.type.kind === "string") {
      fields.push({
        name: f.name,
        value: { kind: "libCall", fn: "os.userName", args: [], type: STRING, loc },
      });
    } else if (f.name === "uid" && f.type.kind === "f64") {
      fields.push({
        name: f.name,
        value: { kind: "libCall", fn: "process.getuid", args: [], type: F64, loc },
      });
    } else if (f.name === "gid" && f.type.kind === "f64") {
      fields.push({
        name: f.name,
        value: { kind: "libCall", fn: "process.getgid", args: [], type: F64, loc },
      });
    } else if (f.name === "homedir" && f.type.kind === "string") {
      fields.push({
        name: f.name,
        value: { kind: "libCall", fn: "os.userHomedir", args: [], type: STRING, loc },
      });
    } else if (f.name === "shell") {
      // `string | null` (the @types/node shape) wraps the always-string
      // POSIX answer into its arm; a plain-string mapping takes it raw.
      const raw: IrExpr = { kind: "libCall", fn: "os.userShell", args: [], type: STRING, loc };
      if (f.type.kind === "string") {
        fields.push({ name: f.name, value: raw });
      } else if (f.type.kind === "union") {
        const tag = lowerer.armTag(f.type.unionId, STRING);
        if (tag < 0) fence();
        fields.push({
          name: f.name,
          value: { kind: "unionWrap", unionId: f.type.unionId, tag, value: raw, type: f.type, loc },
        });
      } else {
        fence();
      }
    } else {
      fence();
    }
  }
  return { kind: "recordLit", fields, type: result, loc };
}

export function lowerOsNetworkInterfacesCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  loc: SrcLoc,
): IrExpr {
  if (call.arguments.length !== 0) {
    lowerer.noLowering(
      `networkInterfaces with ${call.arguments.length} arguments`,
      call,
      "networkInterfaces() takes no arguments",
    );
  }
  // Annotated as a never-returning const so tsc's control flow narrows
  // through the structural checks below.
  const fence: () => never = () =>
    lowerer.noLowering(
      "networkInterfaces() where the result is not the NetworkInterfaceInfo dictionary",
      call,
      "@types/node's NodeJS.Dict<NetworkInterfaceInfo[]> shape is the supported result",
    );
  const result = lowerer.mapTypeOf(lowerer.typeOf(call));
  if (result?.kind !== "record") fence();
  const dictShape = lowerer.shapes.get(result.shapeId);
  if (!dictShape || dictShape.tuple || dictShape.fields.length > 0 || !dictShape.indexValue)
    fence();
  const iv = dictShape.indexValue;
  if (iv.kind !== "union") fence();
  const ivDef = lowerer.unions.get(iv.unionId);
  const arrArm = ivDef?.arms.find((a) => a.kind === "array");
  if (
    !ivDef ||
    ivDef.arms.length !== 2 ||
    arrArm?.kind !== "array" ||
    !ivDef.arms.some((a) => a.kind === "undefinedT")
  )
    fence();
  const info = arrArm.elem;
  if (info.kind !== "union") fence();
  const infoDef = lowerer.unions.get(info.unionId);
  if (!infoDef || infoDef.arms.length !== 2) fence();
  // One arm per family, distinguished by scopeid: plain number = IPv6,
  // `number | undefined` = IPv4. Every other field is shared.
  let saw4 = false;
  let saw6 = false;
  for (const arm of infoDef.arms) {
    if (arm.kind !== "record") fence();
    const shape = lowerer.shapes.get(arm.shapeId);
    if (!shape || shape.tuple || shape.indexValue || shape.fields.length !== 7) fence();
    const f = (name: string): IrType | undefined => shape.fields.find((x) => x.name === name)?.type;
    for (const s of ["address", "family", "mac", "netmask"]) {
      if (f(s)?.kind !== "string") fence();
    }
    if (f("internal")?.kind !== "bool") fence();
    const cidr = f("cidr");
    const cidrDef = cidr?.kind === "union" ? lowerer.unions.get(cidr.unionId) : undefined;
    if (
      !cidrDef ||
      cidrDef.arms.length !== 2 ||
      !cidrDef.arms.some((a) => a.kind === "string") ||
      !cidrDef.arms.some((a) => a.kind === "nullT")
    ) {
      fence();
    }
    const scopeid = f("scopeid");
    if (scopeid?.kind === "f64") {
      saw6 = true;
    } else {
      const sDef = scopeid?.kind === "union" ? lowerer.unions.get(scopeid.unionId) : undefined;
      if (
        !sDef ||
        sDef.arms.length !== 2 ||
        !sDef.arms.some((a) => a.kind === "f64") ||
        !sDef.arms.some((a) => a.kind === "undefinedT")
      ) {
        fence();
      }
      saw4 = true;
    }
  }
  if (!saw4 || !saw6) fence();
  return { kind: "libCall", fn: "os.networkInterfaces", args: [], type: result, loc };
}
