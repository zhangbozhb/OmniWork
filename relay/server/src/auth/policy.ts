import type { RelayAuthContext } from "./context.ts";
import type { RelayAuthDecision } from "./decision.ts";

export interface RelayAuthPolicy<
  Context extends RelayAuthContext = RelayAuthContext,
> {
  readonly name: string;
  authorize(context: Context): RelayAuthDecision | null;
}
