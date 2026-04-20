import { z } from "zod";

const capabilitiesSchema = z
  .object({
    network: z.boolean().optional(),
    filesystem: z.enum(["readonly", "readwrite"]).optional(),
    tools: z.array(z.string()).optional()
  })
  .optional();

const resourceSchema = z
  .array(
    z.object({
      path: z.string().min(1),
      type: z.string().optional()
    })
  )
  .optional();

const schema = z.object({
  name: z
    .string()
    .min(1)
    .regex(/^[a-z0-9][a-z0-9-_]*$/i, "must be alphanumeric with - or _"),
  description: z.string().min(20),
  license: z.string().optional(),
  tags: z.array(z.string()).optional(),
  category: z.string().optional(),
  metadata: z
    .object({
      version: z.string().default("1.0.0")
    })
    .optional(),
  capabilities: capabilitiesSchema,
  resources: resourceSchema,
  "requires-secrets": z
    .array(
      z.object({
        name: z.string().min(1),
        description: z.string().optional(),
        required: z.boolean().optional()
      })
    )
    .optional()
});

export function validateSchema(data: Record<string, unknown>): {
  valid: boolean;
  errors: string[];
} {
  const result = schema.safeParse(data);
  if (result.success) {
    return { valid: true, errors: [] };
  }
  return {
    valid: false,
    errors: result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`)
  };
}
