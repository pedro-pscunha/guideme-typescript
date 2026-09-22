/**
 * The key every nominal type in this package is branded under.
 *
 * TypeScript types are structural, so without a brand a hand-built object with the right
 * fields passes for a rubric or a descriptor, and a bare number passes for a probability. A
 * `unique symbol` property is the one thing a caller cannot write, because this symbol is not
 * exported from the package: only this package's constructors can produce a value carrying it.
 *
 * On rubrics and descriptors the property is real, set by the constructor that builds them. On
 * the scalars (`Probability`, `Model` and the rest) it exists only in the type: a number or a
 * string cannot hold a property, and the brand is applied by the one checked function per type.
 */
export const brand: unique symbol = Symbol("guideme.brand");
