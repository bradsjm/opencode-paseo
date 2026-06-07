type NullableOptionalSchema = {
  nullable: () => {
    optional: () => unknown
  }
}

/** Wrap a schema so it accepts both `null` and an omitted value.
 *
 * @param schema - The schema to make nullable and optional.
 * @returns A schema that accepts `null` or omission.
 */
export function nullableOptional<T extends NullableOptionalSchema>(schema: T) {
  return schema.nullable().optional() as ReturnType<ReturnType<T["nullable"]>["optional"]>
}

/** Convert `null` and `undefined` to `undefined`.
 *
 * @param value - The value to normalize.
 * @returns `undefined` when the input is `null` or `undefined`; otherwise the original value.
 */
export function collapseNull<T>(value: T | null | undefined): T | undefined {
  return value === null || value === undefined ? undefined : value
}

/** Trim a string and return `undefined` when the result is blank.
 *
 * @param value - The string to normalize.
 * @returns The trimmed string, or `undefined` when it is empty after trimming.
 */
export function optionalTrimmedString(value: string | null | undefined): string | undefined {
  const normalized = collapseNull(value)?.trim()
  return normalized ? normalized : undefined
}

/** Return a trimmed string when the input contains non-whitespace content.
 *
 * @param value - The string to normalize.
 * @returns The original string when it contains non-whitespace content; otherwise `undefined`.
 */
export function optionalNonBlankString(value: string | null | undefined): string | undefined {
  const normalized = collapseNull(value)
  if (normalized === undefined) {
    return undefined
  }
  return normalized.trim() ? normalized : undefined
}

/** Require a non-empty trimmed string for the named field.
 *
 * @param value - The string to normalize.
 * @param field - The field name used in the error message.
 * @returns The trimmed string.
 */
export function requiredTrimmedString(value: string | null | undefined, field: string): string {
  const normalized = collapseNull(value)?.trim()
  if (!normalized) {
    throw new Error(`${field} must not be empty`)
  }
  return normalized
}

/** Preserve a numeric value while collapsing `null` and `undefined` to `undefined`.
 *
 * @param value - The numeric value to normalize.
 * @returns `undefined` when the input is `null` or `undefined`; otherwise the original number.
 */
export function optionalNumber<T extends number>(value: T | null | undefined): T | undefined {
  return collapseNull(value)
}

/** Remove keys whose values are `undefined` from an object.
 *
 * @param value - The object to compact.
 * @returns A shallow copy without `undefined` values.
 */
export function compactDefined<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as Partial<T>
}
