/**
 * Legacy adapter for the input gate.
 *
 * The policy itself lives in plan.ts (L3): this file keeps the historical
 * exports so existing callers and tests keep working, but it makes no decision
 * of its own and reads nothing but the arguments it is given.
 */

export {
  INPUT_GATE_MAX_MS,
  INPUT_GATE_TIMEOUT_MS,
  cleanGateText,
  decideInput,
  inputGateTraceFields,
  normalizeModelVerdict,
  ruleInputDecision,
} from './plan.js'

export type {
  InputGateDecision,
  InputGateInput,
  InputGateOptions,
  InputVerdict,
  VerdictSource,
} from './plan.js'
