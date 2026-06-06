type NullableOptionalSchema = {
  nullable: () => {
    optional: () => unknown
  }
}

export function nullableOptional<T extends NullableOptionalSchema>(schema: T) {
  return schema.nullable().optional() as ReturnType<ReturnType<T["nullable"]>["optional"]>
}

export function collapseNull<T>(value: T | null | undefined): T | undefined {
  return value === null || value === undefined ? undefined : value
}

export function optionalTrimmedString(value: string | null | undefined): string | undefined {
  const normalized = collapseNull(value)?.trim()
  return normalized ? normalized : undefined
}

export function optionalNonBlankString(value: string | null | undefined): string | undefined {
  const normalized = collapseNull(value)
  if (normalized === undefined) {
    return undefined
  }
  return normalized.trim() ? normalized : undefined
}

export function requiredTrimmedString(value: string | null | undefined, field: string): string {
  const normalized = collapseNull(value)?.trim()
  if (!normalized) {
    throw new Error(`${field} must not be empty`)
  }
  return normalized
}

export function optionalNumber<T extends number>(value: T | null | undefined): T | undefined {
  return collapseNull(value)
}

export function compactDefined<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as Partial<T>
}
