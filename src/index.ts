/**
 * `@guideme/sdk` — make a TypeSafe Jev judgment usable as control flow.
 *
 * Everything the package offers is exported from this file and nowhere else.
 */

export { GuidemeError, type ErrorKind } from "./errors.js";
export {
  ApiKey,
  type Confidence,
  type Key,
  type Model,
  type Probability,
  type Rank,
} from "./scalars.js";
export { type Policy, type Thresholds, type Verdict } from "./policy.js";
export { fallback, level, option, type LevelRubric, type OptionRubric } from "./rubric.js";
export {
  choice,
  chooseAmong,
  choose,
  levels,
  noul,
  score,
  scoreLevels,
  type ChoiceQuestion,
  type Level,
  type NoulQuestion,
  type Option,
  type Question,
  type Ranked,
  type ScoreQuestion,
  type Scored,
} from "./question.js";
export { Guide, type GuideOptions } from "./guide.js";
export { type ModelInfo, type Receipt, type Usage } from "./receipt.js";
