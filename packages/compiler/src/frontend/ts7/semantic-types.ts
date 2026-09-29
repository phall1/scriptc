/** Frontend names over the concrete native client. No SDK object or
 * structural cast participates in the production checker boundary. */
export type {
  SemanticType as Type,
  SemanticType as InterfaceType,
  SemanticType as TypeReference,
  SemanticType as UnionOrIntersectionType,
  SemanticType as UnionType,
  SemanticTupleType as TupleType,
  // A reference carries its element flags on the target, not necessarily on
  // itself. Claiming a tuple shape here makes a native presence test constant.
  SemanticObjectType as TupleTypeReference,
  SemanticStringLiteralType as StringLiteralType,
  SemanticNumberLiteralType as NumberLiteralType,
  SemanticBooleanLiteralType as BooleanLiteralType,
  SemanticObjectType as ObjectType,
  SemanticSignature as Signature,
  SemanticSymbol as Symbol,
} from "./semantic-model.js";
export type { SemanticIndexInfo as IndexInfo, SemanticTypePredicate as TypePredicate } from "./semantic-checker.js";
export type { Ts7CompilerOptionsData as CompilerOptions, Ts7DiagnosticData as Diagnostic } from "./session-schema.generated.js";
