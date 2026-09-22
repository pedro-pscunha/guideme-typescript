/**
 * `@guideme/sdk` — make a TypeSafe Jev judgment usable as control flow.
 *
 * A yes/no is an `if`, a choice is an exhaustive `switch`, a score is a comparison.
 * Everything the package offers is exported here and nowhere else.
 */

export { Guide, type GuideOptions } from "./guide.js";
export {
  choice,
  choose,
  chooseAmong,
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
export { fallback, level, option, type LevelRubric, type OptionRubric } from "./rubric.js";
export { type Policy, type Thresholds, type Verdict } from "./policy.js";
export { type ModelInfo, type Receipt, type Usage } from "./receipt.js";
export {
  ApiKey,
  type Confidence,
  type Key,
  type Model,
  type Probability,
  type Rank,
} from "./scalars.js";
export { GuidemeError, type ErrorKind } from "./errors.js";
